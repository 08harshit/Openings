/**
 * Production build values. Angular inlines this file at build time (see
 * angular.json fileReplacements) — these are NOT read from process.env, so
 * update them here (or template them in CI) before deploying to Render/Netlify/etc.
 * The Supabase anon key is safe to ship to the browser by design.
 */
export const environment = {
  production: true,
  apiBaseUrl: 'https://REPLACE_WITH_YOUR_RENDER_API_URL/api',
  supabaseUrl: 'https://REPLACE_WITH_YOUR_PROJECT_REF.supabase.co',
  supabaseAnonKey: 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY',
};
