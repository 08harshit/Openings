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
