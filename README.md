# KINDLY

A calm space for a child and the adults who support them: prepare for something
(stories), communicate a need (requests and feelings), and get through a day
together (routines).

**KINDLY is not a medical device, a diagnostic tool, a therapy, or an emergency
service.** In an emergency, contact your local emergency services directly.

> **Status:** feature-complete against the brief, with 180 unit tests and 14
> end-to-end tests passing. It has **never been run against a live Supabase
> project**, escalation is not yet scheduled server-side, and no regulatory
> review has happened. Read [HANDOVER.md](HANDOVER.md) §3 before it reaches a
> real family.

---

## Running it

### Option A — offline demo, no Supabase needed

Uses the in-process backend. Nothing leaves the machine.

```bash
npm install
```

```bash
VITE_KINDLY_BACKEND=memory npm run dev
```

On Windows PowerShell:

```bash
$env:VITE_KINDLY_BACKEND='memory'; npm run dev
```

Open http://localhost:5173, create an account with any email and password, and
work through onboarding. The emulated database lives in one `localStorage` key
and is wiped by clearing site data.

### Option B — against Supabase

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
```

```bash
npx supabase start
```

```bash
npx supabase db reset
```

`db reset` applies all 11 migrations and loads `supabase/seed.sql`, which builds
a demo family. Then copy the environment template and fill in the URL and anon
key printed by `supabase start`:

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

Demo sign-ins created by the seed (local development only):

| Email | Password | Role |
| --- | --- | --- |
| `rosa@example.test` | `kindly-demo-1` | family owner |
| `marcus@example.test` | `kindly-demo-1` | second caregiver |

The demo family's grown-up code is `7391`.

For a hosted project, set the same three `VITE_*` values from
**Project Settings → API**, add your site URL under **Authentication → URL
Configuration → Redirect URLs**, and push the migrations:

```bash
npx supabase db push
```

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on :5173 |
| `npm run build` | Typecheck then production build |
| `npm run preview` | Serve the built app on :4173 |
| `npm test` | Unit, integration and accessibility tests (180, all passing) |
| `npm run test:coverage` | The same with a coverage report |
| `npm run e2e` | Playwright end-to-end suite — 14 tests, desktop and mobile |
| `npm run build:demo` | Single-file demo build (`demo/site/`, deployable anywhere) |
| `npm run db:reset` | Re-apply migrations and reseed the local database |
| `npm run db:types` | Regenerate `src/lib/database.types.ts` from the local schema |

### Running the end-to-end suite

The suite builds the app and serves it with `VITE_KINDLY_BACKEND=memory`, so it
never needs a live Supabase project.

```bash
npx playwright install chromium
```

If that download is blocked on your network, drive an installed browser instead:

```bash
KINDLY_BROWSER_CHANNEL=chrome npm run e2e
```

---

## Layout

```
supabase/migrations/   13 migrations: schema, RLS, functions, realtime, cron
supabase/functions/    generate-story — the AI drafting path
supabase/seed.sql      demo family — local development only
src/lib/               names, schemas, request state machine, story builder + review
src/lib/backend/       one interface, two implementations (Supabase, in-memory)
src/state/             backend, announcer, auth, workspace, child session
src/components/        icon sprite and shared UI primitives
src/routes/            auth, onboarding, app/*, app/settings/*, child/*
src/test/              harness, setup, accessibility and component tests
e2e/                   journey, accessibility, responsive
docs/                  architecture, functionality matrix, schema + RLS, API
                       contract, seed data, accessibility report, limitations
                       and safety, privacy considerations
```

## Environment

Every variable is documented in [.env.example](.env.example). No secrets are
committed. Only the Supabase URL and the publishable anon key reach the browser;
that is safe only because Row Level Security is enabled and forced on every
table (see `supabase/migrations/20260101000800_rls.sql`).
