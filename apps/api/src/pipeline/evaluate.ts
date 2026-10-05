import { evaluateEligibility } from './eligibility';
import { normalizeCandidate, type NormalizedJob, type ScopedCandidate } from './normalize';
import { scoreRetrieval, type RetrievalSignals, type ScoringContext } from './retrieval-score';
import { applyFloor, orderByScore, type Rankable } from './select';

export interface ScoredJob {
  job: NormalizedJob;
  score: number;
  signals: RetrievalSignals;
}

export interface EvaluationResult {
  /** Eligible, at or above the floor, best-first. */
  accepted: ScoredJob[];
  eligibleCount: number;
  belowFloorCount: number;
  /** Rejection reason code -> count, for the run summary. */
  rejectionReasons: Record<string, number>;
}

export function scoredJobRank(item: ScoredJob): Rankable {
  return { score: item.score, postedDateIso: item.job.candidate.postedDateIso, title: item.job.title };
}

/** normalize -> eligibility -> score -> floor -> order, over one run's candidates. */
export function evaluateCandidates(
  scoped: readonly ScopedCandidate[],
  ctx: ScoringContext,
  floor: number,
): EvaluationResult {
  const rejectionReasons: Record<string, number> = {};
  const scored: ScoredJob[] = [];

  for (const item of scoped) {
    const job = normalizeCandidate(item);
    const eligibility = evaluateEligibility(job, ctx.profile);
    if (!eligibility.eligible) {
      rejectionReasons[eligibility.reason] = (rejectionReasons[eligibility.reason] ?? 0) + 1;
      continue;
    }
    const { score, signals } = scoreRetrieval(job, ctx);
    scored.push({ job, score, signals });
  }

  const aboveFloor = applyFloor(scored, floor);
  return {
    accepted: orderByScore(aboveFloor, scoredJobRank),
    eligibleCount: scored.length,
    belowFloorCount: scored.length - aboveFloor.length,
    rejectionReasons,
  };
}
