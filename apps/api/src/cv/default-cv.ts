import type { ProficiencyLevel } from '@jobportal/shared';

/** Seeded from the old RELEVANT_TITLE_MARKERS constant in text.util.ts. */
const DEFAULT_TARGET_ROLES = [
  'backend', 'back end', 'back-end',
  'full stack', 'fullstack', 'full-stack',
  'software engineer', 'software developer',
  'sde', 'swe',
  'node.js', 'nodejs', 'node',
  'nestjs', 'nest.js',
  'api engineer',
  'server-side', 'server side',
];

/** Seeded from the old OFF_TARGET_TITLE_MARKERS constant in text.util.ts. */
const DEFAULT_EXCLUDED_ROLES = [
  'sales engineer', 'support engineer', 'solutions engineer',
  'field engineer', 'hardware engineer', 'mechanical engineer',
  'electrical engineer', 'civil engineer', 'network engineer',
  'security engineer', 'data engineer', 'ml engineer',
  'machine learning engineer', 'ai engineer', 'qa engineer',
  'test engineer', 'ios engineer', 'android engineer',
  'mobile engineer', 'frontend engineer', 'front-end engineer',
  'front end engineer', 'site reliability', 'devops engineer',
  'platform engineer', 'embedded engineer',
  'ios', 'android', 'react native', 'flutter',
];

/** Seeded from the old NON_ENGINEERING_DEPARTMENTS constant in text.util.ts. */
const DEFAULT_EXCLUDED_DEPARTMENTS = [
  'sales', 'marketing', 'people', 'hr', 'human resources', 'finance',
  'legal', 'design', 'customer success', 'customer support', 'support',
  'operations', 'recruiting', 'talent', 'business development', 'bd',
  'account management', 'partnerships', 'content', 'communications',
  'product management',
];

/** Seeded from the old INDIA_PLACE_MARKERS + REMOTE_MARKERS constants in location.util.ts. */
const DEFAULT_PREFERRED_LOCATIONS = [
  'india',
  'bangalore', 'bengaluru', 'mumbai', 'bombay', 'delhi', 'new delhi', 'ncr',
  'gurgaon', 'gurugram', 'noida', 'pune', 'hyderabad', 'chennai', 'madras',
  'kolkata', 'calcutta', 'ahmedabad', 'kochi', 'cochin', 'coimbatore',
  'jaipur', 'chandigarh', 'indore', 'thane', 'navi mumbai',
  ' in)', '(in)', ', in',
  'remote', 'work from home', 'wfh', 'anywhere', 'distributed team', 'fully distributed',
];

/**
 * Baseline CV used to bootstrap a brand-new account, so the skill-gap engine
 * has something to score against on day one instead of matching every job at 0.
 *
 * Edit this freely, or ignore it entirely and use the in-app CV editor — it's
 * only ever applied once, when a user has no cv_profile row yet.
 */
export const DEFAULT_CV = {
  currentTitle: 'Full Stack Developer (Backend Focus)',
  experienceYears: 1.5,

  targetRoles: DEFAULT_TARGET_ROLES,
  excludedRoles: DEFAULT_EXCLUDED_ROLES,
  excludedDepartments: DEFAULT_EXCLUDED_DEPARTMENTS,
  preferredLocations: DEFAULT_PREFERRED_LOCATIONS,
  excludedCompanies: [] as string[],
  seniorityMinYears: null as number | null,
  seniorityMaxYears: null as number | null,
  workModes: [] as string[],
  employmentTypes: [] as string[],
  domainPreferences: [] as string[],
  domainExclusions: [] as string[],

  rawText: `Harshit Sen — Full Stack Developer (Backend Focus)

EXPERIENCE
Wisflux Tech Labs — Full Stack Developer (Backend Focus), July 2024 – Present
  (Software Development Intern, April 2024 – July 2024)
  - Built and maintained backend services in NestJS / Node.js / Express.
  - Designed real-time features using Socket.IO, WebSockets and Server-Sent Events.
  - Built event-driven pipelines on Kafka with dead-letter queues and circuit
    breakers for fault tolerance.
  - Used Redis for Pub/Sub messaging and distributed locking across instances.
  - Modelled and optimised PostgreSQL schemas via TypeORM and Sequelize;
    profiled and tuned slow queries to improve API response times.
  - Ran analytics workloads against BigQuery.
  - Containerised services with Docker; integrated Supabase Auth.
  - Built frontend interfaces in Angular.

EDUCATION
B.Tech, Information Technology — Swami Keshvanand Institute of Technology
2020 – 2024, CGPA 8.4

CORE STACK
NestJS, Node.js, Express.js, Angular, PostgreSQL, TypeORM, Sequelize, Redis,
Kafka, Socket.IO, WebSockets, SSE, BigQuery, Docker, Supabase Auth,
TypeScript, JavaScript, SQL

STRENGTHS
Real-time systems, event-driven architecture, API performance optimisation,
distributed locking, fault-tolerant pipelines (DLQ, circuit breakers).`,

  /**
   * Canonical skill slugs (see packages/shared/src/skills.ts) with self-rated
   * proficiency. These feed straight into the match-score prompt.
   */
  skills: [
    // Backend — the core of the profile
    ['nestjs', 'advanced'],
    ['nodejs', 'advanced'],
    ['expressjs', 'advanced'],
    ['rest-api', 'advanced'],
    ['microservices', 'intermediate'],

    // Languages
    ['typescript', 'advanced'],
    ['javascript', 'advanced'],
    ['sql', 'advanced'],

    // Data
    ['postgresql', 'advanced'],
    ['typeorm', 'advanced'],
    ['sequelize', 'intermediate'],
    ['redis', 'advanced'],
    ['bigquery', 'intermediate'],
    ['query-optimization', 'intermediate'],
    ['database-design', 'intermediate'],

    // Messaging / realtime — the differentiators
    ['kafka', 'intermediate'],
    ['event-driven-architecture', 'advanced'],
    ['websockets', 'advanced'],
    ['socketio', 'advanced'],
    ['server-sent-events', 'advanced'],

    // Frontend
    ['angular', 'intermediate'],
    ['rxjs', 'intermediate'],
    ['html', 'intermediate'],
    ['css', 'intermediate'],

    // Infra / tooling
    ['docker', 'intermediate'],
    ['git', 'advanced'],
    ['linux', 'intermediate'],
    ['oauth', 'intermediate'],
    ['supabase', 'intermediate'],
    ['agile', 'intermediate'],
    ['system-design', 'intermediate'],
  ] as ReadonlyArray<readonly [string, ProficiencyLevel]>,
} as const;
