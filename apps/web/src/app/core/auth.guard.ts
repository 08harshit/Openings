import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Waits for the initial session restore (signal starts `undefined`) before
 * deciding — otherwise a hard refresh on a protected route bounces to /login
 * for a frame even when a valid session exists in localStorage.
 */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.session() === undefined) {
    await new Promise<void>((resolve) => {
      const stop = setInterval(() => {
        if (auth.session() !== undefined) {
          clearInterval(stop);
          resolve();
        }
      }, 25);
    });
  }

  if (auth.isAuthenticated) return true;
  return router.createUrlTree(['/login']);
};
