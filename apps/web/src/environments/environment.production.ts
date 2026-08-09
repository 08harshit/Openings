/**
 * Production build values. Angular inlines this file at build time (see
 * angular.json fileReplacements) — these are NOT read from process.env, so
 * update them here (or template them in CI) before deploying to Render/Netlify/etc.
 * The Supabase anon key is safe to ship to the browser by design.
 */
export const environment = {
  production: true,
  apiBaseUrl: 'https://openings.onrender.com/api',
  // Same Supabase project as apps/web/src/environments/environment.ts — the
  // anon key is safe to ship to the browser by design (RLS-gated).
  supabaseUrl: 'https://nkqszcnefqtvigdumxec.supabase.co',
  supabaseAnonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rcXN6Y25lZnF0dmlnZHVteGVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NjczODIsImV4cCI6MjA4OTA0MzM4Mn0.QxKuWYN8ovRCCbOfz5_Ouly0f63XTHBm5N1BIz-PPTc',
};
