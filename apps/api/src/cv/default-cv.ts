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
  currentTitle: 'Backend-Focused Full Stack Developer',
  experienceYears: 2.2,

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

  rawText: `Harshit Sen — Backend-Focused Full Stack Developer

EXPERIENCE
Freelance (Real-Estate Marketplace Client) — Backend Engineer, July 2026 – Present
  - Designed geo-ranked property discovery in NestJS and PostgreSQL (Sequelize)
    using Haversine ranking with a bounding-box prefilter and composite/geo
    indexes, replacing full-table scans on the hottest query.
  - Integrated Razorpay payments with HMAC webhook verification on the raw
    request body; found and fixed an idempotency bug where a redelivered
    webhook reset an approved vendor to pending.
  - Fixed concurrency issues across the API: a partial unique index with a 409
    response stopped double-booked visit slots, and conditional updates made
    the offer-expiry cron safe to run across multiple replicas.
  - Built a media upload pipeline (presigned uploads, WebP variant generation,
    scheduled orphan sweeper) on AWS S3 and CloudFront.
  - Built CI/CD with GitHub Actions and Docker that deploys to AWS EC2 without
    SSH access; the rollout runs migrations, checks health, and auto-rolls
    back on failure.

Wisflux Tech Labs, Jaipur — Full Stack Developer (Backend Focus), August 2024 – June 2026
  (Software Development Intern, April 2024 – July 2024)
  - Designed and implemented a real-time collaboration system using NestJS and
    Socket.IO with Redis Pub/Sub, enabling concurrent editing, user presence
    tracking, and room-based broadcasting across distributed clients.
  - Implemented distributed locking using Redis with heartbeat-based lock
    extension, preventing concurrent execution of critical workflows.
  - Designed an event-driven data pipeline and asynchronous audit logging
    system using PostgreSQL triggers and Kafka.
  - Implemented fault-tolerant pipelines using retry mechanisms, circuit
    breakers, and Dead Letter Queues (DLQ).
  - Optimized REST API performance (indexed queries, summary endpoints, lazy
    loading), reducing payload size from 1.4MB to 10KB and improving response
    times by 50-90%.
  - Built a high-performance Project Metrics API using NestJS and Sequelize,
    replacing client-side aggregations with optimized SQL (SUM, CASE,
    ARRAY_AGG), reducing payload size by 95%.

EDUCATION
B.Tech, Information Technology — Swami Keshvanand Institute of Technology
2020 – 2024, CGPA 8.4

CORE STACK
TypeScript, JavaScript, SQL, Node.js, NestJS, Express.js, REST APIs,
Microservices, Angular, HTML, CSS, RxJS, PostgreSQL, Sequelize, Apache Kafka,
Redis, Redis Pub/Sub, WebSockets, Socket.IO, Server-Sent Events, AWS, Docker,
Nginx, Git, GitHub, GitHub Actions, CI/CD

STRENGTHS
Geo-ranked search and query optimization, payment integration and webhook
security, concurrency control under load, real-time collaboration systems,
distributed locking, event-driven architecture, fault-tolerant pipelines
(DLQ, circuit breakers), zero-downtime deployment pipelines.`,

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
    ['sequelize', 'advanced'],
    ['redis', 'advanced'],
    ['query-optimization', 'advanced'],
    ['database-design', 'advanced'],

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

    // Cloud / infra
    ['aws', 'intermediate'],
    ['s3', 'intermediate'],
    ['docker', 'intermediate'],
    ['nginx', 'intermediate'],
    ['ci-cd', 'intermediate'],
    ['github-actions', 'intermediate'],
    ['git', 'advanced'],
    ['linux', 'intermediate'],

    // Product / domain-specific
    ['razorpay', 'intermediate'],
    ['webhooks', 'intermediate'],
    ['distributed-locking', 'advanced'],
    ['system-design', 'intermediate'],
    ['agile', 'intermediate'],
  ] as ReadonlyArray<readonly [string, ProficiencyLevel]>,
} as const;
