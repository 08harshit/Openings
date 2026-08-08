-- ===========================================================================
-- 0003_seed_skills.sql — canonical skill vocabulary
--
-- Mirrors SEED_SKILLS in packages/shared/src/skills.ts. The API also upserts
-- this list on boot (SkillsService.seed()), so running this file is optional —
-- it just means a freshly created database is queryable before the API starts.
--
-- Names here are already-normalised slugs. Never insert raw JD text directly;
-- always run it through normalizeSkillName() first or the vocabulary
-- fragments ("Node.js" vs "nodejs" vs "node js").
-- ===========================================================================

insert into public.skills (name, category) values
  -- languages
  ('typescript',                'language'),
  ('javascript',                'language'),
  ('sql',                       'language'),
  ('python',                    'language'),
  ('go',                        'language'),
  ('java',                      'language'),
  ('rust',                      'language'),
  ('csharp',                    'language'),
  -- backend
  ('nodejs',                    'backend'),
  ('nestjs',                    'backend'),
  ('expressjs',                 'backend'),
  ('fastify',                   'backend'),
  ('graphql',                   'backend'),
  ('rest-api',                  'backend'),
  ('grpc',                      'backend'),
  ('microservices',             'backend'),
  ('django',                    'backend'),
  ('fastapi',                   'backend'),
  ('spring-boot',               'backend'),
  -- frontend
  ('angular',                   'frontend'),
  ('react',                     'frontend'),
  ('vue',                       'frontend'),
  ('nextjs',                    'frontend'),
  ('rxjs',                      'frontend'),
  ('html',                      'frontend'),
  ('css',                       'frontend'),
  ('tailwindcss',               'frontend'),
  -- databases
  ('postgresql',                'db'),
  ('mysql',                     'db'),
  ('mongodb',                   'db'),
  ('redis',                     'db'),
  ('typeorm',                   'db'),
  ('sequelize',                 'db'),
  ('prisma',                    'db'),
  ('bigquery',                  'db'),
  ('elasticsearch',             'db'),
  ('supabase',                  'db'),
  ('database-design',           'db'),
  ('query-optimization',        'db'),
  -- messaging
  ('kafka',                     'messaging'),
  ('rabbitmq',                  'messaging'),
  ('sqs',                       'messaging'),
  ('bullmq',                    'messaging'),
  ('event-driven-architecture', 'messaging'),
  -- realtime
  ('websockets',                'realtime'),
  ('socketio',                  'realtime'),
  ('server-sent-events',        'realtime'),
  ('webrtc',                    'realtime'),
  -- cloud
  ('aws',                       'cloud'),
  ('gcp',                       'cloud'),
  ('azure',                     'cloud'),
  ('serverless',                'cloud'),
  ('s3',                        'cloud'),
  -- devops
  ('docker',                    'devops'),
  ('kubernetes',                'devops'),
  ('ci-cd',                     'devops'),
  ('github-actions',            'devops'),
  ('jenkins',                   'devops'),
  ('terraform',                 'devops'),
  ('nginx',                     'devops'),
  ('linux',                     'devops'),
  ('observability',             'devops'),
  -- testing
  ('jest',                      'testing'),
  ('vitest',                    'testing'),
  ('mocha',                     'testing'),
  ('unit-testing',              'testing'),
  ('integration-testing',       'testing'),
  ('cypress',                   'testing'),
  ('tdd',                       'testing'),
  -- tooling
  ('git',                       'tooling'),
  ('agile',                     'tooling'),
  ('system-design',             'tooling'),
  ('oauth',                     'tooling'),
  ('code-review',               'tooling')
on conflict (name) do update set category = excluded.category;
