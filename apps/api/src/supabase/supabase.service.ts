import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Owns the two Supabase clients the API needs.
 *
 * - `admin` uses the service_role key. It bypasses RLS, so **every query built
 *   on it must filter by user_id explicitly** — the guard proves who is calling,
 *   this client does not enforce it.
 * - `anon` uses the public key and is used only to validate access tokens when
 *   no local JWT secret is configured.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);

  readonly admin: SupabaseClient;
  readonly anon: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('supabase.url')!;
    const serviceRoleKey = this.config.get<string>('supabase.serviceRoleKey')!;
    const anonKey = this.config.get<string>('supabase.anonKey')!;

    // The API is stateless; never let the client library try to persist or
    // refresh a session on the server.
    const serverOptions = {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    } as const;

    this.admin = createClient(url, serviceRoleKey, serverOptions);
    this.anon = createClient(url, anonKey, serverOptions);
  }

  /**
   * Unwrap a PostgREST result, turning DB errors into 500s with the Postgres
   * detail preserved in the log (but not leaked to the client).
   */
  unwrap<T>(result: { data: T | null; error: PostgrestError | null }, context: string): T {
    if (result.error) {
      this.logger.error(
        `${context} failed: ${result.error.message}` +
          (result.error.details ? ` | ${result.error.details}` : '') +
          (result.error.hint ? ` | hint: ${result.error.hint}` : ''),
      );
      throw new InternalServerErrorException(`Database operation failed: ${context}`);
    }
    if (result.data === null) {
      throw new InternalServerErrorException(`Database returned no data: ${context}`);
    }
    return result.data;
  }

  /** Same as `unwrap` but tolerates a null payload (e.g. maybeSingle lookups). */
  unwrapMaybe<T>(
    result: { data: T | null; error: PostgrestError | null },
    context: string,
  ): T | null {
    if (result.error) {
      this.logger.error(`${context} failed: ${result.error.message}`);
      throw new InternalServerErrorException(`Database operation failed: ${context}`);
    }
    return result.data;
  }
}
