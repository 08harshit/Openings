import { toLlmJobEvaluation } from './analysis.service';
import type { RawLlmEvaluationResponse } from './groq.types';

function rawResponse(overrides: Partial<RawLlmEvaluationResponse> = {}): RawLlmEvaluationResponse {
  return {
    roleFit: 80,
    seniorityFit: 70,
    requiredSkillFit: 90,
    preferredSkillFit: 60,
    experienceFit: 75,
    domainFit: 50,
    criticalMismatch: false,
    matchedSkills: ['nodejs', 'postgresql'],
    missingSkills: ['kubernetes'],
    criticalGaps: [],
    summary: 'Strong backend match; missing container orchestration exposure.',
    confidence: 85,
    requiredSkills: [
      { name: 'nodejs', required: true },
      { name: 'kubernetes', required: true },
      { name: 'graphql', required: false },
    ],
    ...overrides,
  };
}

describe('toLlmJobEvaluation', () => {
  it('passes through a well-formed response', () => {
    const result = toLlmJobEvaluation(rawResponse());
    expect(result.roleFit).toBe(80);
    expect(result.criticalMismatch).toBe(false);
    expect(result.matchedSkills).toEqual(['nodejs', 'postgresql']);
    expect(result.confidence).toBe(85);
    expect(result.requiredSkills).toEqual([
      { name: 'nodejs', required: true },
      { name: 'kubernetes', required: true },
      { name: 'graphql', required: false },
    ]);
  });

  it('defaults a missing required_skills array to empty', () => {
    const result = toLlmJobEvaluation(rawResponse({ requiredSkills: undefined as unknown as Array<{ name: string; required: boolean }> }));
    expect(result.requiredSkills).toEqual([]);
  });

  it('drops a required-skill entry with no name and coerces required to a boolean', () => {
    const result = toLlmJobEvaluation(
      rawResponse({
        requiredSkills: [
          { name: '', required: true },
          { name: 'docker', required: 1 as unknown as boolean },
        ],
      }),
    );
    expect(result.requiredSkills).toEqual([{ name: 'docker', required: true }]);
  });

  it('clamps every fit field to 0-100', () => {
    const result = toLlmJobEvaluation(rawResponse({ roleFit: 150, seniorityFit: -20 }));
    expect(result.roleFit).toBe(100);
    expect(result.seniorityFit).toBe(0);
  });

  it('rounds non-integer fit values', () => {
    const result = toLlmJobEvaluation(rawResponse({ requiredSkillFit: 77.6 }));
    expect(result.requiredSkillFit).toBe(78);
  });

  it('defaults a missing/non-boolean criticalMismatch to false', () => {
    const result = toLlmJobEvaluation(rawResponse({ criticalMismatch: undefined as unknown as boolean }));
    expect(result.criticalMismatch).toBe(false);
  });

  it('defaults missing array fields to empty arrays', () => {
    const result = toLlmJobEvaluation(
      rawResponse({
        matchedSkills: undefined as unknown as string[],
        missingSkills: undefined as unknown as string[],
        criticalGaps: undefined as unknown as string[],
      }),
    );
    expect(result.matchedSkills).toEqual([]);
    expect(result.missingSkills).toEqual([]);
    expect(result.criticalGaps).toEqual([]);
  });

  it('truncates an overly long summary to 500 characters', () => {
    const result = toLlmJobEvaluation(rawResponse({ summary: 'x'.repeat(600) }));
    expect(result.summary.length).toBe(500);
  });

  it('defaults a missing/invalid confidence to 0', () => {
    const result = toLlmJobEvaluation(rawResponse({ confidence: NaN }));
    expect(result.confidence).toBe(0);
  });
});
