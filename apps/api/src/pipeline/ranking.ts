import type { LlmJobEvaluation, Recommendation } from '@jobportal/shared';

/** Weights for collapsing LlmJobEvaluation's six fit dimensions into one
 * llm_score. Favors requiredSkillFit and roleFit — the two dimensions that
 * matter most for "should I apply". Code constants, not configurable: this
 * is an internal mapping, distinct from the top-level final-score weights
 * below, which ARE configurable (spec §18.2). */
export const RANKING_WEIGHTS = {
  requiredSkillFit: 0.35,
  roleFit: 0.25,
  seniorityFit: 0.15,
  domainFit: 0.10,
  preferredSkillFit: 0.10,
  experienceFit: 0.05,
} as const;

/** A true criticalMismatch caps llm_score here regardless of the weighted
 * average — "exceptional fit on paper" must not outrank "there is a
 * disqualifying issue" just because the six fit numbers look good. */
export const CRITICAL_MISMATCH_CAP = 30;

/** Collapses the six LLM fit dimensions into one 0-100 score. */
export function combineLlmFit(evaluation: LlmJobEvaluation): number {
  const weighted =
    evaluation.requiredSkillFit * RANKING_WEIGHTS.requiredSkillFit +
    evaluation.roleFit * RANKING_WEIGHTS.roleFit +
    evaluation.seniorityFit * RANKING_WEIGHTS.seniorityFit +
    evaluation.domainFit * RANKING_WEIGHTS.domainFit +
    evaluation.preferredSkillFit * RANKING_WEIGHTS.preferredSkillFit +
    evaluation.experienceFit * RANKING_WEIGHTS.experienceFit;
  const score = Math.round(weighted);
  return evaluation.criticalMismatch ? Math.min(score, CRITICAL_MISMATCH_CAP) : score;
}

export const RECOMMENDATION_BANDS: ReadonlyArray<{ min: number; label: Recommendation }> = [
  { min: 90, label: 'APPLY_NOW' },
  { min: 80, label: 'STRONG_MATCH' },
  { min: 70, label: 'CONSIDER' },
  { min: 60, label: 'LOW_PRIORITY' },
  { min: 0, label: 'SKIP' },
];

/** Maps a 0-100 final score to its recommendation band. Starting-point
 * thresholds from spec §18.4 — tunable later from application outcomes. */
export function bandFor(score: number): Recommendation {
  for (const band of RECOMMENDATION_BANDS) {
    if (score >= band.min) return band.label;
  }
  return 'SKIP';
}

export interface FinalScoreWeights {
  retrieval: number;
  llm: number;
  freshness: number;
  preference: number;
}

export interface FinalScoreInput {
  retrievalScore: number;
  llmScore: number;
  freshnessScore: number;
  preferenceScore: number;
}

export interface FinalScoreResult {
  finalScore: number;
  recommendation: Recommendation;
}

/** Weighted sum of the four 0-100 inputs. Weights are normalized to sum to
 * 1 first, so a misconfigured env (weights not summing to 100) still
 * produces a score inside [0, 100] rather than violating the DB's
 * final_score check constraint at insert time. */
export function combineFinalScore(input: FinalScoreInput, weights: FinalScoreWeights): FinalScoreResult {
  const total = weights.retrieval + weights.llm + weights.freshness + weights.preference;
  const safeTotal = total > 0 ? total : 1;
  const normalized = {
    retrieval: weights.retrieval / safeTotal,
    llm: weights.llm / safeTotal,
    freshness: weights.freshness / safeTotal,
    preference: weights.preference / safeTotal,
  };

  const weighted =
    input.retrievalScore * normalized.retrieval +
    input.llmScore * normalized.llm +
    input.freshnessScore * normalized.freshness +
    input.preferenceScore * normalized.preference;

  const finalScore = Math.min(100, Math.max(0, Math.round(weighted)));
  return { finalScore, recommendation: bandFor(finalScore) };
}
