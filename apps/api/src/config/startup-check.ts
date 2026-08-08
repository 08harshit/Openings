import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/**
 * Boot-time credential check.
 *
 * Supabase credentials are hard requirements — without them nothing works, so
 * we fail fast rather than surfacing confusing 500s on the first request.
 * Anthropic and Firecrawl are checked but only warned about: the app is
 * deliberately usable (manual job entry, pipeline tracking, notes) before those
 * keys exist, which is how you'll run it while waiting on account setup.
 */
export function checkStartupConfig(config: ConfigService): void {
  const logger = new Logger('Startup');

  const required: Array<[string, string]> = [
    ['SUPABASE_URL', config.get<string>('supabase.url', '')],
    ['SUPABASE_ANON_KEY', config.get<string>('supabase.anonKey', '')],
    ['SUPABASE_SERVICE_ROLE_KEY', config.get<string>('supabase.serviceRoleKey', '')],
  ];

  const missing = required.filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to apps/api/.env and fill in the Supabase values ' +
        '(Project Settings -> API).',
    );
  }

  if (!config.get<string>('supabase.jwtSecret', '')) {
    logger.warn(
      'SUPABASE_JWT_SECRET is not set — falling back to remote token ' +
        'verification via the Supabase Auth API. Works fine, just adds a ' +
        'round-trip on cache misses. Set it for local HS256 verification.',
    );
  }

  const degraded: string[] = [];
  if (!config.get<string>('groq.apiKey', '')) {
    degraded.push('GROQ_API_KEY (skill-gap scoring disabled)');
  }
  if (!config.get<string>('firecrawl.apiKey', '')) {
    degraded.push('FIRECRAWL_API_KEY (scraping disabled)');
  }

  if (degraded.length > 0) {
    logger.warn(
      `Running in degraded mode — ${degraded.join('; ')}. ` +
        'Manual job entry and pipeline tracking still work.',
    );
  }
}
