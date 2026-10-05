import type { LlmJobEvaluation, JobDetail, JobListItem, JobPosting, JobQuery } from './types';

describe('LlmJobEvaluation shape', () => {
  it('accepts every required field with correct types', () => {
    const evaluation: LlmJobEvaluation = {
      roleFit: 80,
      seniorityFit: 70,
      requiredSkillFit: 90,
      preferredSkillFit: 60,
      experienceFit: 75,
      domainFit: 50,
      criticalMismatch: false,
      matchedSkills: ['nodejs'],
      missingSkills: ['kubernetes'],
      criticalGaps: [],
      summary: 'Strong backend match.',
      confidence: 85,
      requiredSkills: [{ name: 'nodejs', required: true }],
    };
    expect(evaluation.roleFit).toBe(80);
    expect(evaluation.requiredSkills).toEqual([{ name: 'nodejs', required: true }]);
  });
});

describe('JobPosting/JobListItem ranking fields', () => {
  it('allows final_score and recommendation to be null or set', () => {
    const posting: Pick<JobPosting, 'final_score' | 'recommendation'> = {
      final_score: null,
      recommendation: null,
    };
    expect(posting.final_score).toBeNull();

    const listItem: Pick<JobListItem, 'final_score' | 'recommendation'> = {
      final_score: 87,
      recommendation: 'STRONG_MATCH',
    };
    expect(listItem.final_score).toBe(87);
  });
});

describe('JobDetail llm_evaluation breakdown', () => {
  it('allows a full breakdown or null', () => {
    const withBreakdown: Pick<JobDetail, 'llm_evaluation'> = {
      llm_evaluation: {
        llm_score: 78,
        role_fit: 80,
        seniority_fit: 70,
        required_skill_fit: 90,
        preferred_skill_fit: 60,
        experience_fit: 75,
        domain_fit: 50,
        critical_mismatch: false,
        critical_gaps: [],
        confidence: 85,
      },
    };
    expect(withBreakdown.llm_evaluation?.llm_score).toBe(78);

    const withoutBreakdown: Pick<JobDetail, 'llm_evaluation'> = { llm_evaluation: null };
    expect(withoutBreakdown.llm_evaluation).toBeNull();
  });

  it('allows a retrieval_score/retrieval_signals breakdown or null', () => {
    const withSignals: Pick<JobDetail, 'retrieval_score' | 'retrieval_signals'> = {
      retrieval_score: 67,
      retrieval_signals: {
        role: 25,
        skills: 20,
        experience: 12,
        location: 10,
        freshness: 3,
        source: 4,
        requiredYearsMin: 3,
        mentionedSkills: ['nodejs'],
        matchedSkills: ['nodejs'],
      },
    };
    expect(withSignals.retrieval_signals?.role).toBe(25);

    const withoutSignals: Pick<JobDetail, 'retrieval_score' | 'retrieval_signals'> = {
      retrieval_score: null,
      retrieval_signals: null,
    };
    expect(withoutSignals.retrieval_score).toBeNull();
  });
});

describe('JobQuery.sort', () => {
  it('accepts final_score as a sort value', () => {
    const query: JobQuery = { sort: 'final_score' };
    expect(query.sort).toBe('final_score');
  });
});
