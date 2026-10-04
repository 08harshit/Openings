import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeSkillList, type SeniorityLevel, type SkillGapResult } from '@jobportal/shared';
import { retry, type RetryDelayHint } from '../common/async.util';
import { normalizeWhitespace } from '../common/text.util';
import { CvService } from '../cv/cv.service';
import type {
  GroqChatRequest,
  GroqChatResponse,
  GroqErrorResponse,
  RawSkillGapResponse,
} from './groq.types';

const SYSTEM_PROMPT = `You score how well a candidate's CV fits a specific job description.

Score generously for adjacent/transferable experience (e.g. Sequelize experience
counts partially toward "any ORM" requirements; Kafka experience counts toward
general message-queue familiarity) but do not invent skills the CV does not
support. Extract skill names as short canonical slugs: lowercase, hyphenated,
no version numbers unless the JD is version-specific (e.g. "nestjs" not
"NestJS 10", "postgresql" not "Postgres 15"). Prefer well-known conventional
slugs (nodejs, postgresql, rest-api, ci-cd, aws) over ad-hoc phrasing.

Respond with ONLY a single JSON object — no markdown fences, no commentary —
matching exactly this shape:
{
  "match_score": <integer 0-100>,
  "seniority_guess": "entry" | "mid" | "senior" | "unknown",
  "matched_skills": [<canonical skill slug strings the candidate already has>],
  "missing_skills": [<canonical skill slug strings the JD wants but the CV lacks>],
  "required_skills": [{ "name": <canonical skill slug>, "required": <boolean> }, ...],
  "summary_text": "<one or two short sentences on the fit, no preamble>"
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
  ): Promise<SkillGapResult | null> {
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
      return raw ? toSkillGapResult(raw) : null;
    } catch (error) {
      this.logger.error(
        `Skill-gap analysis failed for "${job.title}": ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  private async callGroq(userPrompt: string): Promise<RawSkillGapResponse | null> {
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
      return JSON.parse(content) as RawSkillGapResponse;
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

function toSkillGapResult(raw: RawSkillGapResponse): SkillGapResult {
  const score = Number.isFinite(raw.match_score) ? Math.round(raw.match_score) : 0;
  return {
    match_score: Math.min(100, Math.max(0, score)),
    seniority_guess: (raw.seniority_guess ?? 'unknown') as SeniorityLevel,
    matched_skills: normalizeSkillList(raw.matched_skills ?? []),
    missing_skills: normalizeSkillList(raw.missing_skills ?? []),
    required_skills: (raw.required_skills ?? [])
      .map((s) => ({ name: normalizeSkillList([s.name])[0], required: Boolean(s.required) }))
      .filter((s): s is { name: string; required: boolean } => Boolean(s.name)),
    summary_text: (raw.summary_text ?? '').trim().slice(0, 500),
  };
}
