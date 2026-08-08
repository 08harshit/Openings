/**
 * Auto-discovery search queries, derived from the target role definition in
 * the planning doc: Backend Engineer (primary) / Full Stack Developer
 * (secondary), entry-mid level, any location.
 *
 * These are plain Firecrawl `/search` queries, not a DSL — edit freely. Keep
 * the list short; each entry costs one Firecrawl search call per ingestion run.
 */
export const DEFAULT_SEARCH_QUERIES: string[] = [
  'backend engineer entry level hiring nodejs nestjs',
  'backend developer 0-2 years node.js typescript job',
  'full stack developer angular node junior hiring',
  'nodejs nestjs backend engineer remote job openings',
  'software engineer backend node postgresql kafka hiring',
  'junior backend engineer typescript real-time systems',
];
