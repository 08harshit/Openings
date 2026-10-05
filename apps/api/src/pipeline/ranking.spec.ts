import { combineLlmFit, combineFinalScore, bandFor } from './ranking';
import type { LlmJobEvaluation } from '@jobportal/shared';

function evaluation(overrides: Partial<LlmJobEvaluation> = {}): LlmJobEvaluation {
  return {
    roleFit: 80,
    seniorityFit: 70,
    requiredSkillFit: 90,
    preferredSkillFit: 60,
    experienceFit: 75,
    domainFit: 50,
    criticalMismatch: false,
    matchedSkills: [],
    missingSkills: [],
    criticalGaps: [],
    summary: '',
    confidence: 85,
    ...overrides,
  };
}

describe('combineLlmFit', () => {
  it('weighs requiredSkillFit and roleFit most heavily', () => {
    const skillHeavy = combineLlmFit(evaluation({ requiredSkillFit: 100, roleFit: 20, seniorityFit: 20, domainFit: 20, preferredSkillFit: 20, experienceFit: 20 }));
    const roleHeavy = combineLlmFit(evaluation({ requiredSkillFit: 20, roleFit: 100, seniorityFit: 20, domainFit: 20, preferredSkillFit: 20, experienceFit: 20 }));
    expect(skillHeavy).toBeGreaterThan(roleHeavy);
  });

  it('matches the documented weighted-average formula', () => {
    const e = evaluation();
    const expected = Math.round(
      e.requiredSkillFit * 0.35 + e.roleFit * 0.25 + e.seniorityFit * 0.15 +
      e.domainFit * 0.10 + e.preferredSkillFit * 0.10 + e.experienceFit * 0.05,
    );
    expect(combineLlmFit(e)).toBe(expected);
  });

  it('caps the result when criticalMismatch is true, even with perfect fit scores', () => {
    const perfect = evaluation({
      roleFit: 100, seniorityFit: 100, requiredSkillFit: 100,
      preferredSkillFit: 100, experienceFit: 100, domainFit: 100,
      criticalMismatch: true,
    });
    expect(combineLlmFit(perfect)).toBeLessThanOrEqual(30);
  });

  it('does not cap when criticalMismatch is false, even with low fit scores', () => {
    const weak = evaluation({
      roleFit: 10, seniorityFit: 10, requiredSkillFit: 10,
      preferredSkillFit: 10, experienceFit: 10, domainFit: 10,
      criticalMismatch: false,
    });
    expect(combineLlmFit(weak)).toBe(10);
  });

  it('does not raise a below-cap score when criticalMismatch is true', () => {
    const alreadyLow = evaluation({
      roleFit: 10, seniorityFit: 10, requiredSkillFit: 10,
      preferredSkillFit: 10, experienceFit: 10, domainFit: 10,
      criticalMismatch: true,
    });
    expect(combineLlmFit(alreadyLow)).toBe(10);
  });
});

describe('combineFinalScore', () => {
  const weights = { retrieval: 35, llm: 45, freshness: 10, preference: 10 };

  it('matches the documented weighted-sum formula when weights sum to 100', () => {
    const input = { retrievalScore: 60, llmScore: 80, freshnessScore: 40, preferenceScore: 50 };
    const expected = Math.round(60 * 0.35 + 80 * 0.45 + 40 * 0.10 + 50 * 0.10);
    const result = combineFinalScore(input, weights);
    expect(result.finalScore).toBe(expected);
  });

  it('normalizes weights that do not sum to 100, keeping the score in range', () => {
    const misconfigured = { retrieval: 35, llm: 4500, freshness: 10, preference: 10 };
    const result = combineFinalScore({ retrievalScore: 60, llmScore: 80, freshnessScore: 40, preferenceScore: 50 }, misconfigured);
    expect(result.finalScore).toBeGreaterThanOrEqual(0);
    expect(result.finalScore).toBeLessThanOrEqual(100);
  });

  it('never returns a score outside 0-100 even with extreme inputs', () => {
    const result = combineFinalScore({ retrievalScore: 100, llmScore: 100, freshnessScore: 100, preferenceScore: 100 }, weights);
    expect(result.finalScore).toBeLessThanOrEqual(100);
    const zero = combineFinalScore({ retrievalScore: 0, llmScore: 0, freshnessScore: 0, preferenceScore: 0 }, weights);
    expect(zero.finalScore).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [95, 'APPLY_NOW'],
    [90, 'APPLY_NOW'],
    [85, 'STRONG_MATCH'],
    [80, 'STRONG_MATCH'],
    [75, 'CONSIDER'],
    [70, 'CONSIDER'],
    [65, 'LOW_PRIORITY'],
    [60, 'LOW_PRIORITY'],
    [59, 'SKIP'],
    [0, 'SKIP'],
  ])('assigns the correct band for score %i', (score, expectedBand) => {
    expect(bandFor(score)).toBe(expectedBand);
  });

  it('attaches the band matching the computed final score', () => {
    const result = combineFinalScore({ retrievalScore: 100, llmScore: 100, freshnessScore: 100, preferenceScore: 100 }, weights);
    expect(result.recommendation).toBe('APPLY_NOW');
  });
});
