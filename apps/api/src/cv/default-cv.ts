import type { ProficiencyLevel } from '@jobportal/shared';

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
