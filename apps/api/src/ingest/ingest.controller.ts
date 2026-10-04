import { Controller, ForbiddenException, Get, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IngestRunStatus } from '@jobportal/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/public.decorator';
import { IngestService } from './ingest.service';
import { IngestScheduler } from './ingest.scheduler';

@Controller('ingest')
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly scheduler: IngestScheduler,
    private readonly config: ConfigService,
  ) {}

  /**
   * The "Refresh" button — starts the same pipeline the cron uses for the
   * calling user only, and returns immediately. The dashboard polls
   * `GET /ingest/status` (and re-fetches jobs) to see progress instead of
   * holding one request open for the whole multi-minute run.
   */
  @Post('refresh')
  refresh(@CurrentUser('id') userId: string): IngestRunStatus {
    return this.ingest.start(userId);
  }

  /** Polled by the dashboard while a run is in flight. */
  @Get('status')
  status(@CurrentUser('id') userId: string): IngestRunStatus {
    return this.ingest.getStatus(userId);
  }

  /**
   * Alternate entry point for external cron pingers (e.g. a free uptime
   * monitor hitting this on a schedule instead of relying on Render's own
   * cron). Accepts a shared token via header instead of a user JWT, and —
   * since there is no user context — refreshes every account.
   */
  @Public()
  @Post('refresh/all')
  refreshAll(@Headers('x-ingest-token') token?: string): { triggered: boolean } {
    const expected = this.config.get<string>('ingest.triggerToken', '');
    if (!expected || token !== expected) {
      throw new ForbiddenException('Invalid or missing x-ingest-token');
    }
    // Fire and forget — external pingers expect a fast response, not to hold
    // the connection open for a multi-minute scrape.
    void this.scheduler.runForAllUsers('manual');
    return { triggered: true };
  }
}
