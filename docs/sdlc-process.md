# The development process behind KINDLY

This document names the software development lifecycle model this project
follows, justifies the choice against what actually happened, and maps each
phase to evidence that exists in the repository.

It is written to be checkable. Every claim below points at a file, a test or a
commit that a reader can open. Where the process fell short of the model, that
is stated rather than smoothed over.

---

## 1. The model

**Iterative and incremental delivery, with a V-Model verification spine over
the safety-critical requirements.**

Two parts, doing two different jobs:

- **Iterative and incremental** describes how the work was scheduled. The
  product was built as a sequence of working increments, each deployed and
  exercised before the next began. Requirements were allowed to change between
  increments, and they did.
- **The V-Model spine** describes how correctness is argued. For each
  safety-critical requirement there is a named artefact that verifies it, sitting
  opposite the requirement rather than bolted on afterwards. KINDLY mediates how
  a child asks for help, so "we tested it" is not a sufficient claim; which test
  proves which rule has to be answerable. Section 5 answers it.

---

## 2. Why this model, and not another

### Why iterative and incremental

Three properties of this project make it the only honest description.

**Requirements changed after implementation began, in response to defects.**
The clearest case: the adult verification code was originally optional, with a
toggle in onboarding. Building it revealed that `verify_caregiver_pin` **failed
open** — with no PIN row stored it returned `ok: true` for any code entered. The
screen looked like a lock and was not one. The requirement changed from "the
family may choose whether to require a code" to "the code is mandatory and
cannot be switched off", and migration `20260101001300_mandatory_adult_code.sql`
implements it. A lifecycle that forbids requirement change after sign-off would
have had to either ship the hole or treat its discovery as a process failure.
It was neither; it was the model working.

**Each increment was working, deployed software.** Ten commits, each a complete
change deployed to production, not a big-bang integration at the end.

**Risk drove the sequence of iterations.** Three defects were found only by
running against a real Postgres instance, and each one shaped the next
increment:

| Defect | Why only a real database could find it |
|---|---|
| `42P17` — `enum_out` is STABLE, not IMMUTABLE, so the index expression was rejected | The in-memory backend has no index expressions |
| `record_event(...) does not exist` — a `CASE` over string literals resolves to `text`, and Postgres will not implicitly cast `text` to an enum during function resolution. **No request could be sent at all** | Function resolution is a Postgres behaviour |
| `loadWorkspace` returned zero caregivers — an embedded join relied on a foreign key between `family_members` and `caregiver_profiles` that does not exist | PostgREST embedding is a PostgREST behaviour |

The second of those is the important one for the choice of model: the single
feature the product exists to provide was completely broken, and 195 passing
offline tests did not show it. A process that defers integration until the end
would have found it at the end.

### Why not Waterfall

Requirements demonstrably were not frozen before implementation, as the
mandatory-code change above shows. Claiming Waterfall would contradict the
commit history in this same repository.

### Why not Scrum specifically

Scrum is a particular iterative framework with defined roles, sprints and
ceremonies. There was no team, no sprint boundary, no planning session, no
retrospective. Producing a sprint backlog and a burndown chart after the fact
would be fabricating evidence. "Iterative and incremental" is the accurate
general term; Scrum is a specific claim that would be false.

### Why not the Spiral model

Spiral is the closest alternative and shares the risk-driven character
described above. It is rejected only because it prescribes an explicit risk
analysis *at the start of each cycle*, documented and carried forward. That
analysis was not performed prospectively. `docs/risk-register.md` records the
risks this project carries, but it was written alongside this document, not
cycle by cycle, and presenting it as Spiral evidence would misdate it.

---

## 3. The phases, and where the evidence lives

| Phase | Artefacts in this repository |
|---|---|
| Requirements | The original brief; `docs/functionality-matrix.md` (every screen, field and rule); `docs/limitations-and-safety.md` (what the product deliberately will not do) |
| Design | `docs/architecture.md`; `docs/database-and-rls.md`; `docs/api-contract.md`; `supabase/migrations/` as executable design |
| Implementation | `src/`, `supabase/migrations/` — 14 migrations |
| Verification | `src/**/*.test.ts(x)` — 196 automated tests; `e2e/` — 14 Playwright tests; `src/lib/backend/supabase.live.test.ts` — 10 tests against a real project; `.github/workflows/ci.yml` |
| Deployment | `DEPLOY.md`; `vercel.json`; `supabase/apply-all.sql` and the numbered patch files |
| Maintenance | Commit history; `CHANGELOG.md` |

### Verification is layered on purpose

Each layer can only find certain classes of defect, and the project has been
caught out by assuming otherwise.

1. **Unit and integration tests (196).** Run against `MemoryBackend`, which
   enforces the same authorization rules as the real backend rather than
   mocking them away. These prove application logic.
2. **Accessibility tests (27 of the 196).** Render real screens through real
   providers and run `axe`, so what is asserted is what a screen-reader user
   meets.
3. **End-to-end tests (14).** Drive a real browser against a built bundle.
4. **Live-database tests (10).** Run against a real Supabase project behind
   `KINDLY_LIVE_TEST=1`. **The only layer that can prove the data layer.** All
   three blocking defects in the table above were found here and nowhere else.
5. **Looking at the screen.** Non-negotiable, because automation has a
   documented blind spot in this project: ten decorative Unicode glyphs rendered
   as black boxes on the user's machine, and 194 tests plus `axe` all passed,
   because a missing glyph is still valid text with a valid accessible name. A
   person looking at it found it. `src/test/glyphs.test.ts` now guards the
   regression, but the guard exists only because a human looked first.

---

## 4. Configuration management

- **Version control:** Git, single `main` branch, remote on GitHub.
- **Continuous integration:** `.github/workflows/ci.yml` runs typecheck, the
  196 tests, both builds and the 14 end-to-end tests on every push and pull
  request.
- **Database change control:** forward-only numbered migrations in
  `supabase/migrations/`. Nothing is edited in place on a deployed database;
  each change is a new file, and `supabase/apply-all.sql` is the concatenation
  for a project that cannot use the CLI.
- **Release record:** `CHANGELOG.md`.

### A known weakness, stated plainly

Until the CI workflow above was added, **the test suite had only ever run on one
developer's machine**. Nothing prevented a commit that failed it from reaching
production. For a product whose central claim is that safety rules are enforced
rather than suggested, that was the most serious process gap in the project, and
it is recorded here rather than quietly fixed.

Two weaknesses remain open, listed in `docs/risk-register.md`: commits go
directly to `main` without review, and defects found in production have no
tracked issue identifier, so this document and the commit messages are the only
record of them.

---

## 5. Requirements traceability

The V-Model half of the claim rests on being able to answer, for any safety
requirement, *which artefact proves it*. That mapping is
`docs/traceability-matrix.md`.

---

## 6. What this process has not covered

Listed because an SDLC document that claims full coverage of a product like this
would be the least trustworthy thing in the repository.

- **No testing with autistic children or their caregivers.** The product is
  built on published neurodiversity-affirming principles, not on observed use.
  Until that happens, every claim about how it feels to use is a design
  intention, not a finding.
- **No screen-reader testing with screen-reader users.** `axe` and keyboard
  traversal are automated; actual assistive-technology use is not.
- **No clinical or regulatory review.** The product states that it is not a
  medical device, diagnostic tool, therapy or emergency service. That statement
  has not been reviewed by anyone qualified to confirm the boundary holds in
  the jurisdictions it is used in.
- **No penetration testing.** Row-level security is enabled, forced and
  verified against a live project by automated tests. It has not been attacked
  by a person trying to break it.
- **Scheduled jobs and realtime are unverified in production.** The `pg_cron`
  escalation jobs and the realtime subscriptions are covered by tests against
  the in-memory backend, and have not been observed firing on the live project.
  Section 3 explains why that distinction matters.
