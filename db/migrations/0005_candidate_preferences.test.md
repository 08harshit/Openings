# Manual verification — 0005_candidate_preferences.sql

This repo has no automated migration test runner; verification is a manual
check against the live Supabase project.

## Steps

1. Apply `0005_candidate_preferences.sql` via the Supabase Dashboard SQL Editor
   or `supabase db push`.
2. Run:
   ```sql
   select user_id, target_roles, preferred_locations, seniority_min_years
   from public.cv_profile;
   ```
3. Confirm every existing row shows `target_roles = []`, `preferred_locations = []`,
   `seniority_min_years = null` — **not** the `DEFAULT_CV` seed values added in
   Task 5, since those only apply to a brand-new profile created via
   `CvService.bootstrap()`, never backfilled onto an existing row.

## Result

Pending user confirmation — see ledger entry for this task.
