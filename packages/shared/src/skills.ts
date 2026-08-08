import type { SkillCategory } from './enums';

/**
 * Canonical skill taxonomy.
 *
 * `normalizeSkillName` folds whatever Claude (or you) types into one of these
 * canonical slugs so `job_skills` and `cv_skills` join cleanly. Anything not in
 * the alias map still gets slugified, so the vocabulary grows on its own — the
 * seed list just guarantees the common cases never fragment
 * ("Node.js" / "nodejs" / "Node JS" -> `nodejs`).
 */
export interface SeedSkill {
  name: string;
  category: SkillCategory;
  aliases: string[];
}

export const SEED_SKILLS: SeedSkill[] = [
  // --- languages ---
  { name: 'typescript', category: 'language', aliases: ['ts', 'type script'] },
  { name: 'javascript', category: 'language', aliases: ['js', 'ecmascript', 'es6'] },
  { name: 'sql', category: 'language', aliases: ['structured query language'] },
  { name: 'python', category: 'language', aliases: ['py', 'python3'] },
  { name: 'go', category: 'language', aliases: ['golang'] },
  { name: 'java', category: 'language', aliases: [] },
  { name: 'rust', category: 'language', aliases: [] },
  { name: 'csharp', category: 'language', aliases: ['c#', 'c sharp', 'dotnet', '.net'] },

  // --- backend frameworks / runtimes ---
  { name: 'nodejs', category: 'backend', aliases: ['node', 'node.js', 'node js'] },
  { name: 'nestjs', category: 'backend', aliases: ['nest', 'nest.js', 'nest js'] },
  { name: 'expressjs', category: 'backend', aliases: ['express', 'express.js'] },
  { name: 'fastify', category: 'backend', aliases: [] },
  { name: 'graphql', category: 'backend', aliases: ['graph ql', 'apollo'] },
  { name: 'rest-api', category: 'backend', aliases: ['rest', 'restful', 'rest apis', 'restful api'] },
  { name: 'grpc', category: 'backend', aliases: ['g rpc'] },
  { name: 'microservices', category: 'backend', aliases: ['micro services', 'microservice architecture'] },
  { name: 'django', category: 'backend', aliases: [] },
  { name: 'fastapi', category: 'backend', aliases: ['fast api'] },
  { name: 'spring-boot', category: 'backend', aliases: ['spring', 'springboot'] },

  // --- frontend ---
  { name: 'angular', category: 'frontend', aliases: ['angular 2+', 'angularjs'] },
  { name: 'react', category: 'frontend', aliases: ['react.js', 'reactjs'] },
  { name: 'vue', category: 'frontend', aliases: ['vue.js', 'vuejs'] },
  { name: 'nextjs', category: 'frontend', aliases: ['next', 'next.js'] },
  { name: 'rxjs', category: 'frontend', aliases: ['reactive extensions'] },
  { name: 'html', category: 'frontend', aliases: ['html5'] },
  { name: 'css', category: 'frontend', aliases: ['css3', 'scss', 'sass'] },
  { name: 'tailwindcss', category: 'frontend', aliases: ['tailwind'] },

  // --- databases / ORMs ---
  { name: 'postgresql', category: 'db', aliases: ['postgres', 'psql', 'postgre sql'] },
  { name: 'mysql', category: 'db', aliases: ['my sql', 'mariadb'] },
  { name: 'mongodb', category: 'db', aliases: ['mongo'] },
  { name: 'redis', category: 'db', aliases: [] },
  { name: 'typeorm', category: 'db', aliases: ['type orm'] },
  { name: 'sequelize', category: 'db', aliases: [] },
  { name: 'prisma', category: 'db', aliases: [] },
  { name: 'bigquery', category: 'db', aliases: ['big query', 'google bigquery'] },
  { name: 'elasticsearch', category: 'db', aliases: ['elastic search', 'opensearch'] },
  { name: 'supabase', category: 'db', aliases: [] },
  { name: 'database-design', category: 'db', aliases: ['schema design', 'data modeling', 'data modelling'] },
  { name: 'query-optimization', category: 'db', aliases: ['sql tuning', 'query tuning', 'indexing'] },

  // --- messaging / streaming ---
  { name: 'kafka', category: 'messaging', aliases: ['apache kafka'] },
  { name: 'rabbitmq', category: 'messaging', aliases: ['rabbit mq', 'amqp'] },
  { name: 'sqs', category: 'messaging', aliases: ['aws sqs', 'simple queue service'] },
  { name: 'bullmq', category: 'messaging', aliases: ['bull', 'bull mq'] },
  { name: 'event-driven-architecture', category: 'messaging', aliases: ['event driven', 'eda', 'pub/sub', 'pubsub', 'pub sub'] },

  // --- realtime ---
  { name: 'websockets', category: 'realtime', aliases: ['web sockets', 'ws'] },
  { name: 'socketio', category: 'realtime', aliases: ['socket.io', 'socket io'] },
  { name: 'server-sent-events', category: 'realtime', aliases: ['sse'] },
  { name: 'webrtc', category: 'realtime', aliases: [] },

  // --- cloud ---
  { name: 'aws', category: 'cloud', aliases: ['amazon web services'] },
  { name: 'gcp', category: 'cloud', aliases: ['google cloud', 'google cloud platform'] },
  { name: 'azure', category: 'cloud', aliases: ['microsoft azure'] },
  { name: 'serverless', category: 'cloud', aliases: ['lambda', 'aws lambda', 'cloud functions'] },
  { name: 's3', category: 'cloud', aliases: ['aws s3', 'object storage'] },

  // --- devops ---
  { name: 'docker', category: 'devops', aliases: ['containers', 'containerization', 'docker compose'] },
  { name: 'kubernetes', category: 'devops', aliases: ['k8s', 'kube'] },
  { name: 'ci-cd', category: 'devops', aliases: ['ci/cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'] },
  { name: 'github-actions', category: 'devops', aliases: ['gh actions'] },
  { name: 'jenkins', category: 'devops', aliases: [] },
  { name: 'terraform', category: 'devops', aliases: ['iac', 'infrastructure as code'] },
  { name: 'nginx', category: 'devops', aliases: [] },
  { name: 'linux', category: 'devops', aliases: ['unix', 'bash', 'shell scripting'] },
  { name: 'observability', category: 'devops', aliases: ['monitoring', 'logging', 'prometheus', 'grafana', 'datadog'] },

  // --- testing ---
  { name: 'jest', category: 'testing', aliases: [] },
  { name: 'vitest', category: 'testing', aliases: [] },
  { name: 'mocha', category: 'testing', aliases: ['chai'] },
  { name: 'unit-testing', category: 'testing', aliases: ['unit tests'] },
  { name: 'integration-testing', category: 'testing', aliases: ['integration tests', 'e2e testing', 'end to end testing'] },
  { name: 'cypress', category: 'testing', aliases: ['playwright'] },
  { name: 'tdd', category: 'testing', aliases: ['test driven development'] },

  // --- tooling / practices ---
  { name: 'git', category: 'tooling', aliases: ['github', 'gitlab', 'version control'] },
  { name: 'agile', category: 'tooling', aliases: ['scrum', 'kanban', 'jira'] },
  { name: 'system-design', category: 'tooling', aliases: ['distributed systems', 'scalability'] },
  { name: 'oauth', category: 'tooling', aliases: ['oauth2', 'jwt', 'authentication', 'authorization', 'auth'] },
  { name: 'code-review', category: 'tooling', aliases: ['peer review'] },
];

/** alias -> canonical name. Built once at module load. */
const ALIAS_INDEX: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const skill of SEED_SKILLS) {
    map.set(slugify(skill.name), skill.name);
    map.set(collapse(skill.name), skill.name);
    for (const alias of skill.aliases) {
      map.set(slugify(alias), skill.name);
      map.set(collapse(alias), skill.name);
    }
  }
  return map;
})();

const CATEGORY_INDEX: ReadonlyMap<string, SkillCategory> = new Map(
  SEED_SKILLS.map((s) => [s.name, s.category] as const),
);

/** Lowercase, strip punctuation, collapse separators to single dashes. */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[+#.]/g, (ch) => (ch === '+' ? 'p' : ch === '#' ? 'sharp' : ''))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Same as slugify but with separators removed entirely ("node.js" -> "nodejs"). */
function collapse(raw: string): string {
  return slugify(raw).replace(/-/g, '');
}

/**
 * Fold a free-text skill mention onto a canonical slug.
 * Unknown skills still normalise deterministically, so two spellings of the
 * same new skill converge instead of creating duplicate rows.
 */
export function normalizeSkillName(raw: string): string {
  const slug = slugify(raw);
  if (!slug) return '';
  return ALIAS_INDEX.get(slug) ?? ALIAS_INDEX.get(collapse(raw)) ?? slug;
}

/** Best-effort category for a canonical slug. Unknown skills fall to `other`. */
export function categoryForSkill(canonicalName: string): SkillCategory {
  return CATEGORY_INDEX.get(canonicalName) ?? 'other';
}

/** Normalise a list, drop blanks, and de-duplicate while preserving order. */
export function normalizeSkillList(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = normalizeSkillName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Human-friendly rendering of a canonical slug, for chips and tooltips. */
export function displaySkillName(canonicalName: string): string {
  const overrides: Record<string, string> = {
    nodejs: 'Node.js',
    nestjs: 'NestJS',
    expressjs: 'Express.js',
    nextjs: 'Next.js',
    socketio: 'Socket.IO',
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mongodb: 'MongoDB',
    bigquery: 'BigQuery',
    graphql: 'GraphQL',
    grpc: 'gRPC',
    typeorm: 'TypeORM',
    rxjs: 'RxJS',
    csharp: 'C#',
    aws: 'AWS',
    gcp: 'GCP',
    'ci-cd': 'CI/CD',
    'rest-api': 'REST APIs',
    tdd: 'TDD',
    sql: 'SQL',
    html: 'HTML',
    css: 'CSS',
    s3: 'S3',
    sqs: 'SQS',
    sse: 'SSE',
    oauth: 'OAuth',
    k8s: 'Kubernetes',
  };
  if (overrides[canonicalName]) return overrides[canonicalName];
  return canonicalName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
