import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get()
  ok(): { status: 'ok'; env: string } {
    return { status: 'ok', env: this.config.get<string>('nodeEnv', 'development') };
  }

  /**
   * Also keeps the free-tier Supabase project awake — see db/README.md.
   * A cheap `select count`, so it's fine to hit on every uptime-monitor ping.
   */
  @Public()
  @Get('db')
  async db(): Promise<{ status: 'ok'; skills: number }> {
    const { count, error } = await this.supabase.admin
      .from('skills')
      .select('*', { count: 'exact', head: true });
    if (error) throw new ServiceUnavailableException(`Database unreachable: ${error.message}`);
    return { status: 'ok', skills: count ?? 0 };
  }
}
