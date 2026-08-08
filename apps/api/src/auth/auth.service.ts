import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { SupabaseService } from '../supabase/supabase.service';

export interface AuthenticatedUser {
  id: string;
  email: string;
}

interface CacheEntry {
  user: AuthenticatedUser;
  expiresAt: number;
}

/**
 * Verifies Supabase access tokens.
 *
 * Supabase projects sign tokens one of two ways, and a project can have
 * either depending on when it was created / whether it's been migrated:
 *  - Newer projects use asymmetric signing keys (ES256/RS256). The public
 *    keys are served at /auth/v1/.well-known/jwks.json — no secret needed,
 *    verification is fully local via `jose`'s cached remote JWKS.
 *  - Legacy projects sign HS256 with a shared secret (SUPABASE_JWT_SECRET).
 *
 * The token's own header names its algorithm, so we branch on that rather
 * than guessing from config — a project can only produce one kind, but we
 * don't have to know which in advance. If neither path applies (HS256 token
 * but no secret configured), fall back to asking the Auth API directly.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs = 60_000;
  private readonly symmetricSecret: Uint8Array | null;
  private readonly remoteJwks: JWTVerifyGetKey | null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    const secret = this.config.get<string>('supabase.jwtSecret');
    this.symmetricSecret = secret ? new TextEncoder().encode(secret) : null;

    const url = this.config.get<string>('supabase.url');
    this.remoteJwks = url
      ? createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`))
      : null;
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }

    const user = await this.verifyToken(token);
    // Belt-and-suspenders for the on_auth_user_created DB trigger: it only
    // fires on new auth.users inserts, so an account created before the
    // trigger existed (or if the trigger ever fails) would otherwise have no
    // matching public.users row — and every FK'd table cascades from that.
    // This upsert is idempotent and only runs once per cache window (60s per
    // token), so it's cheap insurance rather than a query on every request.
    await this.ensureUserRow(user);
    this.rememberBriefly(token, user);
    return user;
  }

  private async ensureUserRow(user: AuthenticatedUser): Promise<void> {
    const { error } = await this.supabase.admin
      .from('users')
      .upsert({ id: user.id, email: user.email }, { onConflict: 'id' });
    if (error) {
      this.logger.warn(`Could not ensure users row for ${user.id}: ${error.message}`);
    }
  }

  private async verifyToken(token: string): Promise<AuthenticatedUser> {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new UnauthorizedException('Malformed session token');
    }

    try {
      const result =
        alg && !alg.startsWith('HS') && this.remoteJwks
          ? await jwtVerify(token, this.remoteJwks, { audience: 'authenticated' })
          : alg?.startsWith('HS') && this.symmetricSecret
            ? await jwtVerify(token, this.symmetricSecret, { audience: 'authenticated' })
            : null;

      if (!result) return this.verifyRemotely(token);

      const { payload } = result;
      const id = typeof payload.sub === 'string' ? payload.sub : '';
      if (!id) throw new Error('token has no subject');

      const email = typeof payload.email === 'string' ? payload.email : '';
      return { id, email };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Local token verification failed: ${reason}`);
      throw new UnauthorizedException('Invalid or expired session');
    }
  }

  private async verifyRemotely(token: string): Promise<AuthenticatedUser> {
    const { data, error } = await this.supabase.anon.auth.getUser(token);
    if (error || !data?.user) {
      this.logger.debug(`Remote token verification failed: ${error?.message ?? 'no user'}`);
      throw new UnauthorizedException('Invalid or expired session');
    }
    return { id: data.user.id, email: data.user.email ?? '' };
  }

  /**
   * Small bounded cache. Tokens are short-lived and this is a single-user app,
   * so a hard cap plus a cheap sweep is plenty — no LRU machinery needed.
   */
  private rememberBriefly(token: string, user: AuthenticatedUser): void {
    if (this.cache.size > 200) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      if (this.cache.size > 200) this.cache.clear();
    }
    this.cache.set(token, { user, expiresAt: Date.now() + this.cacheTtlMs });
  }
}
