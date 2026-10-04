import { Controller, Get } from '@nestjs/common';
import type { ApiUsageSnapshot } from '@jobportal/shared';
import { FirecrawlService } from '../firecrawl/firecrawl.service';
import { AnalysisService } from '../analysis/analysis.service';

/**
 * Remaining-quota readout for the two metered third-party APIs this app
 * depends on, surfaced in the dashboard so a refresh doesn't silently run
 * into a wall mid-run.
 */
@Controller('usage')
export class UsageController {
  constructor(
    private readonly firecrawl: FirecrawlService,
    private readonly analysis: AnalysisService,
  ) {}

  @Get()
  async get(): Promise<ApiUsageSnapshot> {
    const firecrawlUsage = await this.firecrawl.getCreditUsage();
    const groqUsage = this.analysis.getRateLimitSnapshot();

    return {
      firecrawl: firecrawlUsage,
      groq: groqUsage,
    };
  }
}
