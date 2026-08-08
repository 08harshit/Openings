import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SupabaseService } from '../supabase/supabase.service';
import { IngestService } from './ingest.service';

/**
 * Drives the "[Scheduled Cron on Render]" box in the data-flow diagram.
 *
 * Registered dynamically (rather than with @Cron()) so the schedule expression
 * and the on/off switch both come from INGEST_CRON / INGEST_CRON_ENABLED
 * without a redeploy.
 *
 * Iterates every row in `public.users` — for a personal tool that's one row,
 * but nothing here assumes it stays that way.
 */
@Injectable()
export class IngestScheduler implements OnModuleInit {
  private readonly logger = new Logger(IngestScheduler.name);
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly supabase: SupabaseService,
    private readonly ingest: IngestService,
  ) {}

  onModuleInit(): void {
    const enabled = this.config.get<boolean>('ingest.cronEnabled', true);
    const expression = this.config.get<string>('ingest.cron', '0 6,18 * * *');

    if (!enabled) {
      this.logger.log('Ingestion cron disabled via INGEST_CRON_ENABLED=false');
      return;
    }

    const job = new CronJob(expression, () => {
      void this.runForAllUsers('cron');
    });
    this.registry.addCronJob('job-ingestion', job);
    job.start();

    this.logger.log(`Ingestion cron scheduled: "${expression}"`);
  }

  async runForAllUsers(trigger: 'cron' | 'manual'): Promise<void> {
    if (this.running) {
      this.logger.warn(`Ingestion already in progress — skipping ${trigger} trigger`);
      return;
    }
    this.running = true;

    try {
      const result = await this.supabase.admin.from('users').select('id');
      const users = (result.data ?? []) as Array<{ id: string }>;

      if (result.error) {
        this.logger.error(`Could not list users for ingestion: ${result.error.message}`);
        return;
      }
      if (users.length === 0) {
        this.logger.debug('No users to run ingestion for yet');
        return;
      }

      for (const user of users) {
        try {
          await this.ingest.run(user.id);
        } catch (error) {
          this.logger.error(
            `Ingestion run failed for user ${user.id}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
