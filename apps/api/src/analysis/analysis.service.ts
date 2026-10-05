import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeSkillList, type LlmJobEvaluation } from '@jobportal/shared';
import { retry, type RetryDelayHint } from '../common/async.util';
import { normalizeWhitespace } from '../common/text.util';
import { CvService } from '../cv/cv.service';
import type {
  GroqChatRequest,
  GroqChatResponse,
  GroqErrorResponse,
  RawLlmEvaluationResponse,
} from './groq.types';

const SYSTEM_PROMPT = `You evaluate how well a candidate's CV fits a specific job description, along several
independent dimensions. Score each dimension generously for adjacent/transferable experience (e.g.
Sequelize experience counts partially toward "any ORM" requirements; Kafka experience counts toward
general message-queue familiarity) but do not invent skills the CV does not support.

Use this scale consistently for every 0-100 fit dimension:
0-20   clearly unsuitable
21-40  weak fit
41-60  possible but significant gaps
61-75  decent fit
76-89  strong fit
90-100 exceptional fit

A criticalMismatch is NOT "low fit" — it is a disqualifying issue the fit scores above would otherwise
hide, such as a posting requiring on-site presence incompatible with a remote-only candidate, or a
security clearance / work authorization the CV gives no evidence of. Set it true only in that case,
with the specific reason(s) in criticalGaps. Most jobs have criticalMismatch: false even with low fit
scores — that is just a weak match, not a critical one.

Extract skill names as short canonical slugs: lowercase, hyphenated, no version numbers unless the JD
is version-specific. Prefer well-known conventional slugs (nodejs, postgresql, rest-api, ci-cd, aws)
over ad-hoc phrasing.

Respond with ONLY a single JSON object — no markdown fences, no commentary — matching exactly this shape:
{
  "roleFit": <integer 0-100>,
  "seniorityFit": <integer 0-100>,
  "requiredSkillFit": <integer 0-100>,
  "preferredSkillFit": <integer 0-100>,
  "experienceFit": <integer 0-100>,
  "domainFit": <integer 0-100>,
  "criticalMismatch": <boolean>,
  "matchedSkills": [<canonical skill slug strings the candidate already has>],
  "missingSkills": [<canonical skill slug strings the JD wants but the CV lacks>],
  "criticalGaps": [<short phrases naming the specific critical mismatch reason(s), empty if none>],
  "summary": "<one or two short sentences on the fit, no preamble>",
  "confidence": <integer 0-100>,
  "requiredSkills": [{ "name": <canonical skill slug>, "required": <boolean> }, ...] (every distinct skill the JD mentions, matched or not)
}`;

/**
 * Wraps the Groq chat-completions call described in the plan: compare a job
 * description against the CV, get back match_score + missing_skills[] +
 * matched_skills[].
 *
 * Groq exposes an OpenAI-compatible /chat/completions endpoint, so this is a
 * plain `fetch` call (same shape as FirecrawlService) rather than a vendor
 * SDK. JSON mode (`response_format: {type: "json_object"}`) constrains the
 * output to a single JSON object; the shape is still validated on our side
 * before it ever reaches the database.
 */
export interface GroqRateLimitSnapshot {
  limit_requests: number | null;
  remaining_requests: number | null;
  reset_requests: string | null;
  limit_tokens: number | null;
  remaining_tokens: number | null;
  reset_tokens: string | null;
  /** When this snapshot was captured — Groq has no standalone "check my
   * quota" endpoint, so this is only ever as fresh as the last real call. */
  observed_at: string;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;

  /** Rate-limit headers from the most recent Groq call — the only place
   * this data is ever exposed, there's no dedicated usage endpoint. */
  private lastRateLimit: GroqRateLimitSnapshot | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cv: CvService,
  ) {
    this.apiKey = this.config.get<string>('groq.apiKey', '');
    this.baseUrl = this.config.get<string>('groq.baseUrl', 'https://api.groq.com').replace(/\/+$/, '');
    this.model = this.config.get<string>('groq.model', 'llama-3.3-70b-versatile');
    this.maxTokens = this.config.get<number>('groq.maxTokens', 2048);
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Snapshot from the last Groq call, or null if none has been made yet
   * this process lifetime (e.g. fresh deploy, no analysis run since boot). */
  getRateLimitSnapshot(): GroqRateLimitSnapshot | null {
    return this.lastRateLimit;
  }

  async analyze(
    userId: string,
    job: { title: string; companyName: string | null; location: string | null; description: string },
  ): Promise<LlmJobEvaluation | null> {
    if (!this.isConfigured) {
      this.logger.warn('GROQ_API_KEY not set — skipping skill-gap analysis');
      return null;
    }

    const cvContext = await this.cv.buildAnalysisContext(userId);
    const description = normalizeWhitespace(job.description, 12_000);

    if (description.trim().length < 40) {
      this.logger.debug(`Skipping analysis for "${job.title}" — description too short to score`);
      return null;
    }

    const userPrompt = buildUserPrompt(cvContext, job, description);

    try {
      // More attempts than a typical retry budget: Groq's free tier rate
      // limit is the expected steady-state failure here, not a rare blip,
      // and each attempt now waits exactly as long as Groq's own
      // Retry-After header says rather than a guessed backoff — so extra
      // attempts cost wall-clock time, not wasted request volume.
      const raw = await retry(() => this.callGroq(userPrompt), {
        attempts: 6,
        baseDelayMs: 1_000,
        shouldRetry: (error) => error instanceof GroqRetryableError,
        onRetry: (_e, attempt, delay) =>
          this.logger.warn(`Retrying Groq analysis (attempt ${attempt}) in ${Math.round(delay)}ms`),
      });
      return raw ? toLlmJobEvaluation(raw) : null;
    } catch (error) {
      this.logger.error(
        `Skill-gap analysis failed for "${job.title}": ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private async callGroq(userPrompt: string): Promise<RawLlmEvaluationResponse | null> {
    const body: GroqChatRequest = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    };

    const res = await fetch(`${this.baseUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    this.captureRateLimit(res.headers);

    if (res.status === 429 || res.status >= 500) {
      throw new GroqRetryableError(
        `Groq chat completions returned ${res.status}`,
        parseRetryAfterMs(res.headers.get('retry-after')),
      );
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => null)) as GroqErrorResponse | null;
      this.logger.warn(
        `Groq chat completions failed (${res.status}): ${errBody?.error?.message ?? 'unknown error'}`,
      );
      return null;
    }

    const payload = (await res.json()) as GroqChatResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return null;

    try {
      return JSON.parse(content) as RawLlmEvaluationResponse;
    } catch (error) {
      this.logger.warn(`Could not parse Groq response as JSON: ${error}`);
      return null;
    }
  }

  private captureRateLimit(headers: Headers): void {
    const asNumber = (name: string): number | null => {
      const value = headers.get(name);
      if (!value) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    this.lastRateLimit = {
      limit_requests: asNumber('x-ratelimit-limit-requests'),
      remaining_requests: asNumber('x-ratelimit-remaining-requests'),
      reset_requests: headers.get('x-ratelimit-reset-requests'),
      limit_tokens: asNumber('x-ratelimit-limit-tokens'),
      remaining_tokens: asNumber('x-ratelimit-remaining-tokens'),
      reset_tokens: headers.get('x-ratelimit-reset-tokens'),
      observed_at: new Date().toISOString(),
    };
  }
}

class GroqRetryableError extends Error implements RetryDelayHint {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** `Retry-After` is either seconds (most APIs, including Groq) or an HTTP
 * date — handle both per the HTTP spec rather than assuming the common case. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

  return undefined;
}

function buildUserPrompt(
  cvContext: Awaited<ReturnType<CvService['buildAnalysisContext']>>,
  job: { title: string; companyName: string | null; location: string | null },
  description: string,
): string {
  return `# Candidate profile

Current title: ${cvContext.currentTitle}
Years of experience: ${cvContext.experienceYears}

Skills:
${cvContext.skillLines}

CV excerpt:
${cvContext.rawCvExcerpt || '(no CV text on file)'}

# Job posting to evaluate

Title: ${job.title}
Company: ${job.companyName ?? 'Unknown'}
Location: ${job.location ?? 'Unknown'}

Description:
${description}

# Task

Score this candidate's fit for this specific job posting. Respond with the JSON object only.`;
}

const FIT_FIELDS = [
  'roleFit', 'seniorityFit', 'requiredSkillFit', 'preferredSkillFit', 'experienceFit', 'domainFit',
] as const;

function clampFit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? normalizeSkillList(value.filter((v): v is string => typeof v === 'string')) : [];
}

export function toLlmJobEvaluation(raw: RawLlmEvaluationResponse): LlmJobEvaluation {
  const result: Record<string, number> = {};
  for (const field of FIT_FIELDS) result[field] = clampFit((raw as unknown as Record<string, unknown>)[field]);

  return {
    roleFit: result.roleFit,
    seniorityFit: result.seniorityFit,
    requiredSkillFit: result.requiredSkillFit,
    preferredSkillFit: result.preferredSkillFit,
    experienceFit: result.experienceFit,
    domainFit: result.domainFit,
    criticalMismatch: raw.criticalMismatch === true,
    matchedSkills: toStringArray(raw.matchedSkills),
    missingSkills: toStringArray(raw.missingSkills),
    criticalGaps: Array.isArray(raw.criticalGaps)
      ? raw.criticalGaps.filter((g): g is string => typeof g === 'string')
      : [],
    summary: (raw.summary ?? '').trim().slice(0, 500),
    confidence: clampFit(raw.confidence),
    requiredSkills: toRequiredSkills(raw.requiredSkills),
  };
}

function toRequiredSkills(value: unknown): Array<{ name: string; required: boolean }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const name = normalizeSkillList([String((entry as Record<string, unknown>).name ?? '')])[0];
      return name ? { name, required: Boolean((entry as Record<string, unknown>).required) } : null;
    })
    .filter((s): s is { name: string; required: boolean } => s !== null);
}
