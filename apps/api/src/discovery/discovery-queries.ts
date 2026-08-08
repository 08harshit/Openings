/**
 * Company-discovery search queries — phrased to surface *companies that are
 * hiring*, not individual job postings. Results are only ever used to
 * extract a company name; the actual job data always comes from that
 * company's own career page (see company-resolver.service.ts).
 *
 * Scoped to the target role definition (Backend Engineer primary, Full Stack
 * secondary, entry-mid level) and to India / Remote, per the plan. Edit
 * freely — each entry costs one Firecrawl search call per ingestion run,
 * same as before.
 */
export const COMPANY_DISCOVERY_QUERIES: string[] = [
  'startups hiring backend engineers India 2026',
  'companies hiring nodejs nestjs backend developers India',
  'tech companies hiring full stack developers India remote',
  'series A series B startups hiring backend engineers India',
  'remote-first companies hiring backend engineers India',
  'product companies bangalore hiring backend engineer nodejs',
];
