import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  email = '';
  password = '';
  mode = signal<'sign-in' | 'sign-up'>('sign-in');
  error = signal<string | null>(null);
  info = signal<string | null>(null);
  busy = signal(false);

  toggleMode(): void {
    this.mode.set(this.mode() === 'sign-in' ? 'sign-up' : 'sign-in');
    this.error.set(null);
    this.info.set(null);
  }

  async submit(): Promise<void> {
    if (!this.email || !this.password) return;
    this.busy.set(true);
    this.error.set(null);
    this.info.set(null);

    const errorMessage =
      this.mode() === 'sign-in'
        ? await this.auth.signIn(this.email, this.password)
        : await this.auth.signUp(this.email, this.password);

    this.busy.set(false);

    if (errorMessage) {
      this.error.set(errorMessage);
      return;
    }

    if (this.mode() === 'sign-up' && !this.auth.isAuthenticated) {
      // Email confirmation is enabled on the Supabase project — nothing more
      // to do client-side until the user follows the link.
      this.info.set('Account created. Check your email to confirm, then sign in.');
      this.mode.set('sign-in');
      return;
    }

    void this.router.navigateByUrl('/dashboard');
  }
}
