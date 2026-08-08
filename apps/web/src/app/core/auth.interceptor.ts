import { inject } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';
import { AuthService } from './auth.service';

/** Attaches the Supabase access token to every request the app makes. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.accessToken;

  if (!token) return next(req);

  return next(
    req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }),
  );
};
