import { Injectable, signal } from '@angular/core';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

/**
 * Thin wrapper over the Supabase browser client, doing exactly what section 3
 * of the plan calls for: Supabase Auth, email/password. The API never sees
 * this client directly — it verifies the JWT independently (see
 * apps/api/src/auth) — this service's only job is sign-in/out and handing out
 * the current access token for the HTTP interceptor to attach.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly client: SupabaseClient;

  /** Null while the initial session restore is in flight. */
  readonly session = signal<Session | null | undefined>(undefined);

  constructor() {
    this.client = createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    this.client.auth.getSession().then(({ data }) => this.session.set(data.session));
    this.client.auth.onAuthStateChange((_event, session) => this.session.set(session));
  }

  get isAuthenticated(): boolean {
    return !!this.session();
  }

  get accessToken(): string | null {
    return this.session()?.access_token ?? null;
  }

  get userEmail(): string | null {
    return this.session()?.user?.email ?? null;
  }

  async signIn(email: string, password: string): Promise<string | null> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    return error?.message ?? null;
  }

  async signUp(email: string, password: string): Promise<string | null> {
    const { error } = await this.client.auth.signUp({ email, password });
    return error?.message ?? null;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }
}
