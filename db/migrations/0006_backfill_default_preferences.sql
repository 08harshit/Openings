-- ===========================================================================
-- 0006_backfill_default_preferences.sql — fix the C1 outage found in review
--
-- 0005_candidate_preferences.sql deliberately left existing cv_profile rows
-- with empty target_roles/preferred_locations ('[]'), reasoning that a user
-- who already customised their CV shouldn't have new arrays silently filled
-- with the app's old hardcoded defaults.
--
-- That reasoning only holds for a genuinely customised profile. In practice
-- the one existing row in this single-user deployment was never customised
-- for these NEW fields (they didn't exist until 0005 ran) — it just inherited
-- the column defaults. Since looksLikeRelevantRole()/isIndiaOrRemote() now
-- treat an empty list as "reject everything" (by design — see the Review
-- Focus item in docs/superpowers/plans/2026-10-04-candidate-profile.md), an
-- empty target_roles or preferred_locations means EVERY job is silently
-- rejected, with no error surfaced anywhere before the fix in
-- describeEmptyProfileWarning(). A row with target_roles still at its
-- column default ('[]') has definitely never been through a deliberate
-- "I want zero target roles" edit, so backfilling it here is safe.
--
-- This only touches rows where target_roles/preferred_locations are STILL
-- the column default ('[]') — a row a user has already edited (including one
-- deliberately cleared to '[]', indistinguishable from never-touched, which
-- is an accepted limitation of this one-time fix) is left alone either way.
--
-- Idempotent: safe to re-run — a row already backfilled (or already having
-- real values) won't match the `= '[]'::jsonb` condition on a second run.
-- ===========================================================================

update public.cv_profile
set target_roles = '[
  "backend", "back end", "back-end",
  "full stack", "fullstack", "full-stack",
  "software engineer", "software developer",
  "sde", "swe",
  "node.js", "nodejs", "node",
  "nestjs", "nest.js",
  "api engineer",
  "server-side", "server side"
]'::jsonb
where target_roles = '[]'::jsonb;

update public.cv_profile
set excluded_roles = '[
  "sales engineer", "support engineer", "solutions engineer",
  "field engineer", "hardware engineer", "mechanical engineer",
  "electrical engineer", "civil engineer", "network engineer",
  "security engineer", "data engineer", "ml engineer",
  "machine learning engineer", "ai engineer", "qa engineer",
  "test engineer", "ios engineer", "android engineer",
  "mobile engineer", "frontend engineer", "front-end engineer",
  "front end engineer", "site reliability", "devops engineer",
  "platform engineer", "embedded engineer",
  "ios", "android", "react native", "flutter"
]'::jsonb
where excluded_roles = '[]'::jsonb;

update public.cv_profile
set excluded_departments = '[
  "sales", "marketing", "people", "hr", "human resources", "finance",
  "legal", "design", "customer success", "customer support", "support",
  "operations", "recruiting", "talent", "business development", "bd",
  "account management", "partnerships", "content", "communications",
  "product management"
]'::jsonb
where excluded_departments = '[]'::jsonb;

update public.cv_profile
set preferred_locations = '[
  "india",
  "bangalore", "bengaluru", "mumbai", "bombay", "delhi", "new delhi", "ncr",
  "gurgaon", "gurugram", "noida", "pune", "hyderabad", "chennai", "madras",
  "kolkata", "calcutta", "ahmedabad", "kochi", "cochin", "coimbatore",
  "jaipur", "chandigarh", "indore", "thane", "navi mumbai",
  " in)", "(in)", ", in",
  "remote", "work from home", "wfh", "anywhere", "distributed team", "fully distributed"
]'::jsonb
where preferred_locations = '[]'::jsonb;
