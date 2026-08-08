import type { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./shell/shell.component').then((m) => m.ShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },
      {
        path: 'jobs/:id',
        loadComponent: () =>
          import('./features/job-detail/job-detail.component').then((m) => m.JobDetailComponent),
      },
      {
        path: 'companies',
        loadComponent: () =>
          import('./features/companies/companies.component').then((m) => m.CompaniesComponent),
      },
      {
        path: 'cv',
        loadComponent: () => import('./features/cv/cv.component').then((m) => m.CvComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
