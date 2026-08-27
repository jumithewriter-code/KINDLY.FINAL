# KINDLY — handover

An honest account: what is finished, what is not, and what the next person needs
to know. **Do not ship this to real families yet** — see §3.

---

## 1. Verified state

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | passes, strict mode |
| `npm run build` | passes |
| `npm test` | **180 / 180 passing** across 5 files |
| `npm run e2e` | **14 / 14 passing** — desktop, mobile, and the standalone demo |
| Documentation | **all 12 deliverables written** |

Everything that was outstanding at the first handover is now closed. What
remains is listed in §3 and is deliberate, not unfinished.

---

## 2. What is built and working

### Database — `supabase/migrations/`, 11 files

23 tables, all with RLS `ENABLE`d **and** `FORCE`d, and `REVOKE ALL … FROM anon`.

Design decisions worth keeping:

* **`caregiver_pins` and `rate_limits` have no client policy at all.** No
  browser can select them, including a family owner's. PIN verification happens
  entirely inside `verify_caregiver_pin()`, which returns only a boolean.
* **`requests` has no INSERT/UPDATE/DELETE policy.** Every mutation goes through
  a SECURITY DEFINER function that validates the transition, the assignment and
  the urgency rules. This is what makes "delivered" impossible to fake.
* **`request_events` is append-only** — no update or delete policy exists.
* **Urgent-cannot-be-delayed is enforced three times**: in
  `respond_to_request()`, in a `BEFORE INSERT` trigger on `request_responses`,
  and in the UI (the control is never rendered).
* **Duplicate prevention is two mechanisms**: a per-child idempotency key, and a
  partial unique index over every open status on
  `(child_id, type_slug, child_facing_label)`.
* Every SECURITY DEFINER function pins `search_path = ''` and re-checks
  authorization itself. RLS is the second lock, not the only one.

### Frontend — 61 TypeScript files

Auth (sign in, create account, forgot password, reset, verify, accept invite),
6-step onboarding, the caregiver shell with home / requests / request detail /
stories / story editor / routines / routine editor / profile / settings and six
settings subpages, and child mode: home, help, request, feelings, stories, story
reader, my day, routine runner, offline help, and the PIN gate.

Real routes throughout — back, forward, refresh, bookmarks and deep links work.
Unknown paths render a real 404.

### Test suite — 180 passing

* `names.test.ts` (37) — Unicode initials: emoji, combining marks, non-Latin
  scripts, apostrophes, hyphens; and that no fallback ever invents a person.
* `stateMachine.test.ts` (27) — **parses `kindly.allowed_transition()` out of
  the migration file and asserts the TypeScript mirror is identical.** The two
  cannot drift apart without a test failing.
* `stories.test.ts` (31) — the ten social-story acceptance tests from the brief,
  plus the automated language review's 21 rules.
* `memory.test.ts` (62) — integration: cross-family authorization, PIN lockout,
  child-session scoping, the full request lifecycle, duplicate prevention,
  escalation with fake timers, conflicting caregivers, cancellation, routines
  and stories CRUD, export and deletion.
* `accessibility.test.tsx` (23) — jest-axe on real screens, keyboard operation,
  focus management in dialogs, error/field association.

---

## 3. What remains, and why

Nothing is failing. These are deliberate gaps with consequences, not loose ends.

### 3a. The scheduled jobs exist but have never been observed running

Migration `…001200_scheduled_jobs.sql` installs three `pg_cron` jobs —
escalation every 15 seconds, deletions and retention nightly. `run_pending_deletions()`
is the hard delete the seven-day grace window promises, and was previously
missing entirely.

The migration degrades safely: without `pg_cron` it warns rather than failing.
So **verify** rather than assume (DEPLOY.md §5). Two things still open: nothing
sweeps orphaned storage objects (`kindly.orphaned_media_paths()` lists them), and
none of it has run on a real project.

### 3b. Child mode shares the caregiver's authenticated session

Writes are scoped by the child session's `allowed_actions`, but the device is
still authenticated as the caregiver. Someone capable could read family data via
devtools. The fix is a low-privilege child JWT through a Supabase auth hook.
Full detail in docs/limitations-and-safety.md §3a.

### 3c. Never run against a hosted Supabase project

Everything is verified against the in-process backend and, for the SQL, by
review. `supabase db push`, the RLS policies in a real Postgres, realtime,
storage uploads and `pg_cron` have **not** been executed once. That is the
single largest untested surface.

### 3d. No screen-reader or user testing

axe passes on every route, but no NVDA/JAWS/VoiceOver run has happened, and no
autistic person, AAC user or accessibility specialist has tried it. See
docs/accessibility-report.md §5 and docs/limitations-and-safety.md §3g.

### 3e. Regulatory status unreviewed

COPPA, GDPR/UK GDPR and health-data rules have not been assessed. The schema was
built with them in mind; that is not compliance. docs/privacy-compliance.md
lists the open questions and one concrete gap: **the seven-day hard-delete sweep
is documented but not scheduled**, so an erasure request cannot yet be honoured
in full.

### 3f. Story generation is written but unexecuted

`supabase/functions/generate-story` calls Claude, validates the result against a
schema, and returns a draft. It checks the caller's JWT and `can_edit_stories`
first, and cannot approve or assign. Every failure — unconfigured, refused,
invalid, rate-limited, unreachable — falls back to the deterministic template
builder, and the editor tells the caregiver which draft they are reading.

**Never deployed, never executed.** Until it is, assume every generation is the
template builder. Deploy steps: DEPLOY.md §5b.

### 3g. Deliberately not built

* **Push notifications** — permission flow, preferences and the table exist; no
  service worker. By design: an urgent request never depends on a push.
* **Media upload** is implemented but never run against a live project.

## 4. Things the next person must know

### The child-mode security model, and its limit

Child mode runs under a scoped session token whose SHA-256 hash is stored in
`child_sessions` with an explicit `allowed_actions` array. Every child-facing
read and write goes through a `child_*` RPC that validates the token, its expiry
and that array. The client cannot widen the set.

**The limit:** the device is still authenticated as the caregiver who handed it
over. A technically sophisticated person in child mode could open devtools and
query as that caregiver. Mitigations in place: the PIN gate, the audit log, and
the fact that all *writes* are scoped. The planned fix is a genuinely
low-privilege child JWT via a Supabase custom auth hook. **This should be stated
in the safety documentation before any real family uses it.**

### The in-memory backend is a test double, not app storage

`src/lib/backend/memory.ts` serialises its emulated database into one
`localStorage` key. That key is the stand-in for Postgres. No application module
reads it; only that file does, and it is only bundled when
`VITE_KINDLY_BACKEND=memory`. The production build tree-shakes it away.

The only sanctioned browser storage in the app itself is
`src/lib/devicePrefs.ts`: last-opened family and child, a collapsed sidebar, a
form draft, and the child-session token in `sessionStorage` (a capability, not a
record — the authoritative session is the database row, revocable by a
caregiver).

### A conflicting scaffold was set aside

A partial Next.js / v0 scaffold appeared in this directory part-way through the
build and overwrote `tsconfig.json` and `vitest.config.ts`. It was not wired to
anything — `next` is not even a dependency, and its config set
`typescript.ignoreBuildErrors: true`.

It has been **moved, not deleted**, to `_conflicting-next-scaffold/` with a
README explaining what it is. The Vite configs were restored. If that scaffold
was intentional, the two approaches need reconciling before any more work.

### Design fidelity

`src/styles/kindly.css` is the design's stylesheet, copied verbatim.
`src/styles/app.css` layers on top and contains only (a) accessibility
corrections and (b) states the interactive design implied but did not draw —
loading, empty, error, offline, permission-denied, dialogs, editors. No
decorative changes were made. Where the design drew a list as `<div>`/`<span>`,
the app renders `<ol>`/`<li>` and app.css restores the exact appearance.

---

## 5. Suggested order of work

1. Stand up a real Supabase project and run everything against it (§3c). This
   uncovers more than any other single step.
2. Schedule escalation server-side and verify it (§3a).
3. Build and schedule the hard-delete sweep (§3e).
4. Decide on the child-session model: fix it or accept and document it (§3b).
5. Independent review of the RLS policies.
6. Screen-reader and user testing (§3d).
7. Commission a DPIA (§3e).
8. Only then: push notifications, AI generation.
