# Changelog

All notable changes to KINDLY. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Database changes are listed with the migration that makes them, because a
deployed project needs those applied separately — see `DEPLOY.md`.

## [Unreleased]

### Added
- Continuous integration (`.github/workflows/ci.yml`): typecheck, the full test
  suite, both builds and the end-to-end tests on every push and pull request.
  Until now these had only ever run on one developer's machine.
- `docs/sdlc-process.md`, `docs/traceability-matrix.md`, `docs/risk-register.md`.

### Known issues
- Child mode can hang on "Opening your space…" when no child profile resolves or
  when starting a session fails — see RK-03 in the risk register. Reproduced,
  not yet fixed.

## [1.2.0] — 2026-09-11

### Added
- Google Search Console verification file, `robots.txt` and `sitemap.xml`.
  `robots.txt` keeps crawlers out of the caregiver area, child mode, onboarding
  and invitation links; invitation URLs carry a private code.

## [1.1.0] — 2026-08-30

### Added
- **Operator dashboard** at `/app/admin`, restricted to accounts listed in
  `kindly.operators` — a table with row-level security forced and no policy at
  all, so no client can read it or add to it. Shows counts and durations across
  every family and no name, message or family identifier; the boundary is the
  fixed return shape of `public.operator_metrics()`, not the page.
  *(Migration `20260101001400_operator_metrics.sql`.)*
- Per-request-type breakdown withheld below five families, where it would stop
  being a statistic and become a description of one child's day.
- Signup funnel, cumulative by construction so it can only narrow, and traffic
  analytics via `@vercel/analytics` — cookieless, production builds only.
- A favicon. `/favicon.ico` had been 404ing on every page load.

## [1.0.2] — 2026-08-28

### Fixed
- **Every route except `/` returned 404.** `cleanUrls` in `vercel.json` made
  Vercel resolve extensionless paths as clean URLs and 404 before the SPA
  rewrite ran, so refreshing any page or opening any shared link failed.

## [1.0.1] — 2026-08-27

### Fixed
- **Password-reset and verification emails failed silently.** The result was
  discarded, so a rate limit or an SMTP failure looked identical to success and
  the page said a link was on its way when nothing had been sent. Supabase
  answers 200 for an address it does not know, so surfacing the error does not
  reveal whether an account exists.
- Production build no longer depends on dashboard environment variables, which
  were being withheld from the build and overriding the committed config with
  empty values.

### Added
- Custom SMTP documented as required configuration (`DEPLOY.md` §2b). The
  built-in Supabase sender caps at about two messages an hour and fails silently
  past it, on a path that carries caregiver invitations.

## [1.0.0] — 2026-08-27

First release.

### Added
- Child mode: request help, share a feeling, follow a routine, read an approved
  story. Full request lifecycle with honest states — a child is told "delivered"
  only when a caregiver's device actually has the request.
- Caregiver view: answer and escalate requests, write and approve stories, build
  routines, manage caregivers and roles, configure safety and escalation, export
  or delete all data.
- 33 tables with row-level security enabled **and forced**, all privileges
  revoked from `anon`, and `SECURITY DEFINER` functions as the only write path
  for requests.
- An urgent request cannot be given a delayed answer — enforced by a database
  check constraint, not only by the interface.
- The escalation ladder always ends with offline help, naming a safe adult and a
  safe place.
- The request state machine is mirrored between SQL and TypeScript, with a test
  that parses the SQL to prove the two agree.
- 196 unit, integration and accessibility tests; 14 end-to-end tests; 10 tests
  against a live Supabase project behind `KINDLY_LIVE_TEST=1`.

### Security
- **The grown-up code is mandatory and cannot be switched off.**
  `verify_caregiver_pin` previously failed open: with no code stored it returned
  `ok: true` for any code entered. *(Migration `20260101001300`.)*
- **`child_send_request` could not run at all.** A `CASE` over string literals
  resolves to `text`, and Postgres will not implicitly cast it to an enum during
  function resolution, so no request could be sent. *(Patch 01.)*
- `loadWorkspace` returned zero caregivers, silently, through an embedded join
  on a foreign key that does not exist.
