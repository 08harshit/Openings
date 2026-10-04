# Openings — Personal Job Portal

Automated job discovery, AI skill-gap scoring, and a Kanban/table pipeline dashboard for
running your own job search like a pipeline instead of a spreadsheet.

You give it a role definition and a CV. It discovers real companies, resolves each one to
its **own** careers page (never an aggregator), scrapes fresh postings straight from the
source, scores each one against your skills with an LLM, and hands you a dashboard to
track applications through to an offer.

Both apps build and typecheck clean out of the box. The only things missing are *your*
credentials — see [Getting started](#getting-started).

---

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Clone and install](#1-clone-and-install)
  - [2. Set up Supabase](#2-set-up-supabase)
  - [3. Configure environment variables](#3-configure-environment-variables)
  - [4. Run it](#4-run-it)
- [Environment variables](#environment-variables)
- [Available scripts](#available-scripts)
- [API overview](#api-overview)
- [Deployment](#deployment)
- [Known simplifications](#known-simplifications)
- [Security notes](#security-notes)
- [Roadmap ideas](#roadmap-ideas)

---

## Why

Manually job-hunting means the same repetitive loop: search several job boards, open each
listing, mentally diff it against your resume, and track the ones you applied to in a
spreadsheet that goes stale within a week. This project automates the parts that don't
need a human — discovery, scraping, and a first-pass skill-gap read — and leaves the
parts that do (deciding what to apply to, actually applying, following up) to you, backed
by a dashboard that doesn't lie about what's stale.

## How it works

```
[Firecrawl search: company names only] → [CompanyResolverService: ATS guess → homepage+career-page search]
                                                              │
                                          job_portal_companies (careers_url, ats_type resolved)
                                                              │
        [pinned companies] ───────────────────────┬──────────┘
                                                    ▼
                              [ATS JSON API  |  Firecrawl map+scrape] → relevance + India/Remote + freshness filters
                                                    │
                                                dedup → job_postings → [Groq skill-gap scoring] → dashboard
                                                                                │
                                                    [Render cron / Refresh button]      match_score, missing_skills
                                                                                │
                                                                    [Angular table + Kanban]
```

**The core rule: jobs are never inserted straight from a search result.** Search is only
ever used to learn a *company name*. Every posting that ends up in the dashboard came from
that company's own verified careers page — its Greenhouse/Lever/Ashby board, or a custom
career page found by mapping the company's site. No aggregator (LinkedIn, Indeed, Naukri,
etc.) is ever scraped directly for listings.

1. **Discovery** — Firecrawl search surfaces company names matching the target role.
2. **Resolution** — `CompanyResolverService` guesses the company's ATS (Greenhouse, Lever,
   Ashby) from its name; if that misses, it falls back to a homepage search and maps the
   site to find a real careers page. Every company is recorded with a `resolution_status`
   so failures are visible, not silently dropped.
3. **Scraping** — resolved companies are polled via their ATS's JSON API where available
   (fast, structured, free) or via Firecrawl map + scrape for custom career pages.
4. **Filtering** — every candidate listing passes a role-relevance gate, an India/Remote
   location gate, and a freshness check before it's ever written to the database.
5. **Dedup** — on `(user_id, url_hash)` (canonicalised URL, tracking params stripped) and
   `(user_id, company_id, title_normalized)`, so the same role re-listed under a new URL
   doesn't create a duplicate card.
6. **Scoring** — new postings are sent to Groq (`openai/gpt-oss-120b`, JSON mode)
   alongside your CV/skills profile, returning a `match_score` and a list of
   `missing_skills`.
7. **Surfacing** — everything lands on an Angular dashboard: a sortable table or a
   drag-and-drop Kanban board, your choice.

## Features

- **Auto-discovery pipeline** — zero manual careers-page entry. Company names in, verified
  careers pages out (`apps/api/src/discovery/`).
- **Skill-gap scoring** — every job gets a match score and a concrete list of missing
  skills, not just a keyword count (`apps/api/src/analysis/`).
- **Relevance/location/freshness filtering** — backend/full-stack role gate, India-or-Remote
  location gate, and a configurable freshness threshold, all enforced before insert
  (`apps/api/src/common/text.util.ts`, `location.util.ts`, `date.util.ts`).
- **Table + Kanban dashboard** — toggle between a sortable table and a native
  drag-and-drop Kanban board, with colour-coded match badges and clickable
  missing-skill chips.
- **Pipeline tracking that doesn't lie** — status changes are recorded by a database
  trigger (`status_history`), so edits made directly in the Supabase table editor still
  show up in the timeline, and stale applications (no status change in N days) are
  flagged automatically.
- **Manual mode included** — no API keys configured at all still gets you a working
  "add job manually + track pipeline" app; scraping and scoring degrade gracefully rather
  than blocking startup.
- **Auth via Supabase** — email/password auth with Row Level Security, so every query is
  scoped to the signed-in user at the database layer, not just in application code.
- **Scheduled ingestion** — a cron job (`@nestjs/schedule`, deployed on Render) refreshes
  the pipeline on a schedule, with a manual "Refresh" button and a token-protected
  endpoint for external cron pingers.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Angular 18 (standalone components, signals) |
| Backend | NestJS 10 + TypeScript |
| Database | Supabase (Postgres + Auth + Row Level Security) |
| Scraping | [Firecrawl](https://firecrawl.dev) (`/v2/search`, `/map`, `/scrape`) |
| Skill-gap engine | [Groq](https://groq.com) (`openai/gpt-oss-120b`, JSON mode) |
| Scheduler | `@nestjs/schedule` cron, deployed on Render |
| Monorepo | npm workspaces |

## Project structure

```
.
├── apps/
│   ├── api/                    NestJS API
│   │   └── src/
│   │       ├── analysis/       Groq skill-gap scoring
│   │       ├── auth/           Supabase-JWT auth guard, decorators
│   │       ├── common/         Text/location/date filtering utilities
│   │       ├── companies/      Company CRUD + pinning
│   │       ├── config/         Typed config + startup capability checks
│   │       ├── cv/             CV/skills profile CRUD
│   │       ├── discovery/      ATS guessing + career-page resolution pipeline
│   │       ├── firecrawl/      Firecrawl API client (search/map/scrape)
│   │       ├── health/         Liveness + DB health checks
│   │       ├── ingest/         Cron scheduler + ingestion orchestration
│   │       ├── jobs/           Job posting CRUD + status-history
│   │       ├── skills/         Skill taxonomy CRUD
│   │       └── supabase/       Supabase client module (user + admin clients)
│   └── web/                     Angular dashboard
│       └── src/app/
│           ├── core/            API client, auth guard/interceptor/service
│           ├── features/        Dashboard, Kanban, CV, Companies, Job detail, Login
│           ├── shared/          Match badge, skill chips, status select
│           └── shell/           App shell/nav
├── packages/
│   └── shared/                  Types, enums, and skill-name normalisation shared
│                                 by both apps
├── db/
│   ├── migrations/               SQL migrations (schema, RLS, seed data, discovery)
│   └── README.md                 Supabase setup guide
├── render.yaml                   Render Blueprint for the API
├── .env.example                  Root-level environment variable reference
└── package.json                  npm workspaces root
```

## Getting started

### Prerequisites

- Node.js `>= 20.19.0`
- npm (ships with Node)
- A free [Supabase](https://supabase.com) project
- Optional, for full functionality: a [Firecrawl](https://firecrawl.dev) API key and a
  [Groq](https://console.groq.com/keys) API key

### 1. Clone and install

```bash
git clone https://github.com/08harshit/Openings.git
cd Openings
npm install                 # installs all three workspaces
npm run build:shared        # packages/shared must be built before the API/web can resolve it
```

### 2. Set up Supabase

Follow [`db/README.md`](db/README.md) step by step: create a project, run the four
migrations in `db/migrations/` in order via the SQL editor, turn off email confirmation
for local dev, and grab your four API credentials from **Project Settings → API**.

### 3. Configure environment variables

```bash
cp apps/api/.env.example apps/api/.env
```

Fill in `apps/api/.env` with your Supabase credentials (see
[Environment variables](#environment-variables) below), and put your Supabase URL/anon key
into `apps/web/src/environments/environment.ts`. Firecrawl and Groq keys are optional —
without them the app runs in manual add-and-track mode; check the startup log to see which
features are active.

### 4. Run it

```bash
# Terminal 1 — API on :3000
npm run dev:api

# Terminal 2 — Angular on :4200
npm run dev:web
```

Open **http://localhost:4200**, sign up with any email/password, and you're in. A default
CV/skills profile is pre-loaded so the dashboard isn't empty on first login.

> Re-run `npm run build:shared` after changing anything in `packages/shared` — the API and
> Angular app both consume its compiled `dist/`, not the raw source.

## Environment variables

Full annotated templates live in [`.env.example`](.env.example) (root) and
[`apps/api/.env.example`](apps/api/.env.example). Summary:

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Public key, safe for the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | **Server only** — bypasses RLS, never ship to Angular |
| `SUPABASE_JWT_SECRET` | ✅ | Verifies Supabase Auth access tokens |
| `GROQ_API_KEY` | optional | Enables skill-gap scoring |
| `GROQ_MODEL` | optional | Defaults to `openai/gpt-oss-120b` |
| `FIRECRAWL_API_KEY` | optional | Enables auto-discovery + scraping |
| `FIRECRAWL_API_VERSION` | optional | `v2` (default) or `v1` |
| `INGEST_CRON` | optional | Cron expression for scheduled ingestion (default `0 6,18 * * *`) |
| `INGEST_MAX_NEW_COMPANIES_PER_RUN` | optional | Caps new-company resolution spend per run (default `5`) |
| `INGEST_MAX_POSTING_AGE_DAYS` | optional | Freshness threshold in days (default `2`) |
| `STALE_APPLICATION_DAYS` | optional | Days before an applied job is flagged stale (default `7`) |
| `INGEST_TRIGGER_TOKEN` | optional | Protects `/api/ingest/refresh` for external cron pingers |
| `CORS_ORIGINS` | ✅ | Comma-separated list of allowed origins |

## Available scripts

Run from the repo root:

| Script | What it does |
|---|---|
| `npm run build:shared` | Builds `packages/shared` |
| `npm run build:api` | Builds the NestJS API |
| `npm run build:web` | Builds the Angular app |
| `npm run build` | Builds shared → API → web, in order |
| `npm run dev:api` | Runs the API in watch mode on `:3000` |
| `npm run dev:web` | Runs the Angular dev server on `:4200` |
| `npm run typecheck` | Typechecks every workspace |
| `npm run lint` | Lints every workspace |
| `npm run test` | Runs tests in every workspace |

## API overview

All routes are prefixed `/api` and, except `/api/health`, require a Supabase-issued JWT
(`Authorization: Bearer <token>`).

| Module | Responsibility |
|---|---|
| `auth` | Validates Supabase JWTs; `@Public()` decorator opts routes out |
| `jobs` | CRUD for job postings, pipeline status transitions, status-history read |
| `companies` | CRUD + pinning for companies; resolution status visibility |
| `discovery` | Internal — ATS guessing and career-page resolution, invoked by ingest |
| `firecrawl` | Internal — thin client over Firecrawl's search/map/scrape endpoints |
| `analysis` | Internal — Groq skill-gap scoring for newly ingested postings |
| `ingest` | Scheduled + manual pipeline refresh (`POST /api/ingest/refresh`) |
| `cv` | CRUD for the CV/skills profile used in scoring |
| `skills` | CRUD for the canonical skill taxonomy |
| `health` | `/api/health` liveness, `/api/health/db` Supabase connectivity |

## Deployment

**API → Render.** Push this repo to GitHub (done), then in Render choose
**New → Blueprint** and point it at the repo — it reads [`render.yaml`](render.yaml).
After the first deploy, fill in the `sync: false` environment variables in the Render
dashboard (Supabase keys, Groq key, Firecrawl key, and `CORS_ORIGINS` set to your deployed
Angular origin). Render's free tier spins down on idle; the ingestion cron and the
`/api/health/db` endpoint both hit Supabase regularly enough to keep the *database* awake,
but the API service itself cold-starts on the next request after idling — expect a ~30s
delay on the first hit after a quiet period.

**Angular → any static host** (Netlify, Vercel, GitHub Pages, Cloudflare Pages). Before
building for production, fill in `apps/web/src/environments/environment.production.ts`
with your real Supabase URL/anon key and your deployed API's base URL, then:

```bash
npm run build:shared
npm run build --workspace @jobportal/web -- --configuration production
```

Deploy `apps/web/dist/web/browser`.

## Known simplifications

Deliberate trade-offs for a personal-tool scale, not cut corners:

- **Pagination** — the dashboard fetches up to 200 jobs in one page (the validated max on
  `page_size`), no infinite scroll/pagination UI. Fine until your pipeline grows past
  that.
- **Static discovery queries** — auto-discovery search queries are a static list tuned to
  the target role definition (Backend Engineer / Full Stack, entry–mid, India/Remote); see
  `apps/api/src/discovery/discovery-queries.ts`. Edit freely for a different role.
- **No aggregator fallback** — a company that can't be resolved to a verified careers page
  is recorded as `resolution_status: 'failed'` and skipped, never guessed at. Pin it
  manually with a known URL if you want it included anyway.
- **Freshness is conservative** — a posting with no recognisable date signal is kept; the
  filter only rejects *provable* staleness, never guesses.
- **CommonJS shared package** — `packages/shared` compiles to CommonJS to match NestJS.
  Angular's production build emits one harmless "not ESM" warning for it; doesn't affect
  output correctness or size.

## Security notes

- `apps/api/.env` and every `.env*` file except `*.env.example` are gitignored — real
  credentials never enter version control.
- `SUPABASE_SERVICE_ROLE_KEY` is used **server-side only** and bypasses Row Level
  Security; it is never sent to the Angular app.
- `SUPABASE_ANON_KEY` in `apps/web/src/environments/*.ts` is the public/anon key by
  design — it ships in every deployed frontend bundle and is safe to expose as long as
  RLS policies (`db/migrations/0002_rls.sql`) are in place, which they are.
- Every table query is scoped by Supabase Row Level Security to the authenticated user —
  authorization is enforced at the database layer, not just in the API.
- `.claude/settings.local.json` is gitignored — local tool permission state can end up
  containing ad-hoc values typed into commands during development and should never be
  committed.

## Roadmap ideas

- Real pagination / infinite scroll past the 200-job cap
- Configurable role/location filters from the dashboard instead of static query lists
- Email/Slack digest of new high-match postings
- Multi-user support beyond the current personal-tool scope
