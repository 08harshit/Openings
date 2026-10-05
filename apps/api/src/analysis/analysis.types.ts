/** JSON Schema handed to Claude via output_config.format — see analysis.service.ts. */
export const SKILL_GAP_JSON_SCHEMA = {
  type: 'object',
  properties: {
    match_score: {
      type: 'integer',
      description: '0-100 overall fit between the candidate and this job description.',
    },
    seniority_guess: {
      type: 'string',
      enum: ['entry', 'mid', 'senior', 'unknown'],
      description: 'Seniority level implied by the job description, independent of its title.',
    },
    matched_skills: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Canonical, lowercase-hyphenated skill slugs the candidate has that this JD also asks ' +
        'for (e.g. "nestjs", "postgresql", "websockets"). Use short slugs, not full sentences.',
    },
    missing_skills: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Canonical, lowercase-hyphenated skill slugs the JD asks for that the candidate\'s CV ' +
        'does not list. Prioritise skills explicitly required over nice-to-haves.',
    },
    required_skills: {
      type: 'array',
      description: 'Every distinct skill the JD mentions, matched or not, with a required flag.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Canonical, lowercase-hyphenated skill slug.' },
          required: {
            type: 'boolean',
            description: 'true if the JD lists it as required/must-have, false if nice-to-have.',
          },
        },
        required: ['name', 'required'],
        additionalProperties: false,
      },
    },
    summary_text: {
      type: 'string',
      description:
        'One or two short sentences summarising the fit, e.g. "Strong backend match; missing ' +
        'cloud and testing framework exposure." No preamble, no restating the score.',
    },
  },
  required: [
    'match_score',
    'seniority_guess',
    'matched_skills',
    'missing_skills',
    'required_skills',
    'summary_text',
  ],
  additionalProperties: false,
} as const;

export interface RawSkillGapResponse {
  match_score: number;
  seniority_guess: 'entry' | 'mid' | 'senior' | 'unknown';
  matched_skills: string[];
  missing_skills: string[];
  required_skills: Array<{ name: string; required: boolean }>;
  summary_text: string;
}

/** JSON Schema handed to Groq via response_format — see analysis.service.ts. */
export const LLM_EVALUATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    roleFit: { type: 'integer', description: '0-100: how well the job title/role matches the candidate\'s target roles and current trajectory.' },
    seniorityFit: { type: 'integer', description: '0-100: how well the job\'s seniority level matches the candidate\'s experience.' },
    requiredSkillFit: { type: 'integer', description: '0-100: coverage of the JD\'s required/must-have skills by the candidate\'s CV.' },
    preferredSkillFit: { type: 'integer', description: '0-100: coverage of the JD\'s nice-to-have skills by the candidate\'s CV.' },
    experienceFit: { type: 'integer', description: '0-100: how well the candidate\'s years and type of experience match what the JD implies.' },
    domainFit: { type: 'integer', description: '0-100: how well the candidate\'s industry/domain background matches this role\'s domain.' },
    criticalMismatch: {
      type: 'boolean',
      description:
        'true only for a disqualifying mismatch the fit scores above would hide — e.g. the posting requires ' +
        'on-site presence incompatible with a remote-only candidate, or requires a clearance/authorization the ' +
        'CV gives no evidence of. false otherwise, even if fit scores are low.',
    },
    matchedSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Canonical, lowercase-hyphenated skill slugs the candidate has that this JD also asks for.',
    },
    missingSkills: {
      type: 'array',
      items: { type: 'string' },
      description: 'Canonical, lowercase-hyphenated skill slugs the JD asks for that the candidate\'s CV lacks.',
    },
    criticalGaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short phrases naming the specific gap(s) behind a true criticalMismatch. Empty if criticalMismatch is false.',
    },
    summary: {
      type: 'string',
      description: 'One or two short sentences summarising the fit, no preamble, no restating the scores.',
    },
    confidence: {
      type: 'integer',
      description: '0-100: how confident this evaluation is, given how much detail the JD and CV provided.',
    },
    requiredSkills: {
      type: 'array',
      description: 'Every distinct skill the JD mentions, matched or not, with a required flag.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Canonical, lowercase-hyphenated skill slug.' },
          required: {
            type: 'boolean',
            description: 'true if the JD lists it as required/must-have, false if nice-to-have.',
          },
        },
        required: ['name', 'required'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'roleFit', 'seniorityFit', 'requiredSkillFit', 'preferredSkillFit', 'experienceFit', 'domainFit',
    'criticalMismatch', 'matchedSkills', 'missingSkills', 'criticalGaps', 'summary', 'confidence', 'requiredSkills',
  ],
  additionalProperties: false,
} as const;
