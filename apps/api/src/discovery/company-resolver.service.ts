import { Injectable, Logger } from '@nestjs/common';
import type { AtsType } from '@jobportal/shared';
import { FirecrawlService } from '../firecrawl/firecrawl.service';
import { tryAtsProviders } from './ats-clients';

export type ResolveResult =
  | { status: 'resolved'; careersUrl: string; atsType: AtsType | null; atsBoardToken: string | null }
  | { status: 'failed' };

/**
 * Turns a bare company name into a real, verified careers page — with no
 * manual URL entry. Two layers, cheapest and most reliable first:
 *
 *  1. ATS slug guessing (Greenhouse/Lever/Ashby) — free, instant, definitive
 *     when it hits: a 200 with a job list means we've found their real
 *     careers feed, no ambiguity.
 *  2. Homepage search + career-page mapping — for companies on a custom
 *     career page. Costs a couple of Firecrawl calls, and is inherently
 *     less certain (company-name search results can be ambiguous), so it's
 *     the fallback, not the default.
 *
 * A company that resolves via neither layer is marked `failed`, not
 * guessed at — the accuracy of every job this app ever shows depends on
 * never pinning a URL we aren't reasonably sure is the company's own.
 */
@Injectable()
export class CompanyResolverService {
  private readonly logger = new Logger(CompanyResolverService.name);

  constructor(private readonly firecrawl: FirecrawlService) {}

  async resolve(companyName: string): Promise<ResolveResult> {
    const ats = await tryAtsProviders(companyName);
    if (ats) {
      this.logger.log(`Resolved "${companyName}" via ${ats.atsType} (${ats.jobs.length} listing(s))`);
      return {
        status: 'resolved',
        careersUrl: publicBoardUrl(ats.atsType, ats.boardToken),
        atsType: ats.atsType,
        atsBoardToken: ats.boardToken,
      };
    }

    if (!this.firecrawl.isConfigured) return { status: 'failed' };

    const homepage = await this.firecrawl.findCompanyHomepage(companyName);
    if (!homepage) {
      this.logger.debug(`Could not resolve a homepage for "${companyName}"`);
      return { status: 'failed' };
    }

    const careerPage = await this.firecrawl.findCareerPageUrl(homepage);
    if (!careerPage) {
      this.logger.debug(`Found homepage ${homepage} for "${companyName}" but no careers page`);
      return { status: 'failed' };
    }

    this.logger.log(`Resolved "${companyName}" -> ${careerPage} (custom career page)`);
    return { status: 'resolved', careersUrl: careerPage, atsType: null, atsBoardToken: null };
  }
}

function publicBoardUrl(atsType: AtsType, boardToken: string): string {
  switch (atsType) {
    case 'greenhouse':
      return `https://boards.greenhouse.io/${boardToken}`;
    case 'lever':
      return `https://jobs.lever.co/${boardToken}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${boardToken}`;
  }
}
