# Risk register

Risks this project carries, what is already done about each, and what is still
open. Written to be useful rather than reassuring: several entries describe
risks that remain live.

**A note on provenance.** This register was compiled alongside
`docs/sdlc-process.md`, not prospectively at the start of each development
cycle. It is an honest inventory of risks the project has run into or still
carries — it is not evidence of a Spiral-model risk analysis, and
`docs/sdlc-process.md` says so.

Severity is judged by **what happens to a child**, not by engineering effort.

---

## Open risks

### RK-01 — A child asks for help and nobody comes · Severity: critical

The failure the product exists to prevent. Mitigated in depth: escalation to a
trusted caregiver, then to everyone, then the offline-help screen naming a safe
adult and a safe place, so the child always has a next step. `pg_cron` runs
escalation server-side so it fires with no caregiver device awake.

**Still open:** the cron jobs have never been observed firing on the live
project. They are covered by tests against the in-memory backend only. Until
someone leaves a request unanswered on the real deployment with every caregiver
device closed and confirms escalation still happens, this mitigation is
unproven in production. `DEPLOY.md` step 6.8 is that check.

### RK-02 — Email silently fails, so an invitation never arrives · Severity: high

Supabase's built-in email sender is a testing service, capped at roughly two
messages an hour per project, and on many projects it refuses addresses outside
the Supabase organisation. Over the cap it fails at the provider with no error
the app can see.

The consequence is not an inconvenience: a second caregiver who never learns
they were invited is a child with one adult able to answer instead of two.

Partly mitigated — the app no longer reports success when a send fails
(*"Stop swallowing password-reset send failures"*). **Still open:** custom SMTP
is documented in `DEPLOY.md` §2b but not yet configured, so the cap still
applies.

### RK-03 — Child mode hangs with no way out · Severity: high

`ChildShell` can reach an indefinite "Opening your space…" with no error and no
exit, by two routes: no child id resolves, so no session is ever started; or
`start()` throws and the rejection is discarded, while the error state is driven
by a query that never runs without a token.

Reproduced and documented; **not yet fixed.** A screen a child may be looking at
should never hang silently.

### RK-04 — Commits reach production without review · Severity: medium

Work goes straight to `main`. CI now runs on every push, so a failing build is
visible, but nothing *blocks* a merge and no second person reads the change.

**Mitigation available:** branch protection requiring a passing CI run.

### RK-05 — Defects have no tracked identifier · Severity: medium

Every defect in this project was found, fixed and described in a commit message,
with no issue number. The commit history and `CHANGELOG.md` are the only record,
so there is no way to see what is open, what recurred, or how long a fix took.

### RK-06 — Colour contrast can regress unnoticed · Severity: medium

Thirteen contrast defects were found and corrected by measurement
(`docs/accessibility-report.md`). No automated test would fail if someone
changed a colour tomorrow, because `axe`'s contrast rule cannot run under jsdom,
which has no layout engine. Row R9.7 in the traceability matrix.

### RK-07 — Hosting can pause without warning · Severity: medium

The app runs on a free Vercel plan, which can pause a project for exceeding
limits or for commercial use. The build is a pure static SPA, so moving to
Cloudflare Pages or Netlify is roughly a ten-minute job, but it is not set up in
advance.

### RK-08 — No testing with autistic children or caregivers · Severity: high

The product is built on published neurodiversity-affirming principles, not on
observed use. Every claim about how it feels to use is a design intention, not a
finding. No amount of testing in this repository substitutes for that, and it is
the largest gap in the project.

### RK-09 — Security verified by tests, never attacked · Severity: medium

Row-level security is enabled, forced, and verified against a live project.
Nobody has attempted to break it. There has been no penetration test and no
third-party review.

### RK-10 — The safety boundary has had no clinical or regulatory review · Severity: high

The product states it is not a medical device, diagnostic tool, therapy or
emergency service, and never contacts emergency services. Nobody qualified has
confirmed that boundary holds in the jurisdictions where it would be used.

---

## Closed risks

Kept because how each was found is the useful part.

### RK-C1 — The adult check accepted any code · Was: critical

`verify_caregiver_pin` returned `ok: true` when no PIN row existed. A screen
that looked like a lock and was not one, in front of a child's private messages.

**Found by:** investigating a user report that the app asked for a code the user
had never set. The report was about an annoyance; the cause was a security hole.
**Closed by:** migration `…001300_mandatory_adult_code.sql`, and the code is now
mandatory. Tests R4.1–R4.3.

### RK-C2 — No request could be sent at all · Was: critical

A `CASE` over string literals resolves to `text`, and Postgres will not
implicitly cast `text` to an enum during function resolution, so
`record_event(...)` matched no signature.

**Found by:** the first run against a real Postgres instance. 195 offline tests
passed throughout. **Closed by:** `patch-01-child-send-request.sql`, and the live
suite now covers the full request lifecycle.

### RK-C3 — The caregiver list was silently empty · Was: high

`loadWorkspace` embedded `caregiver_profiles` through a foreign key that does
not exist, so it returned zero members with no error.

**Found by:** the live suite. **Closed by:** a second query joined in JavaScript.

### RK-C4 — Every route except `/` returned 404 · Was: high

`cleanUrls` in `vercel.json` made Vercel resolve extensionless paths as clean
URLs and 404 before the SPA rewrite was considered. Refreshing any page, or
opening any shared link, failed.

**Found by:** a user report. The headers from the same config file applied
correctly on the 404 responses, which is what made it look like a working
config. **Closed by:** *"Remove cleanUrls so the SPA rewrite actually runs"*.

### RK-C5 — Decorative glyphs rendered as black boxes · Was: medium

Ten Unicode pictographs had no glyph in the user's installed fonts.

**Found by:** a person looking at the screen. 194 tests and `axe` all passed,
because a missing glyph is still valid text with a valid accessible name.
**Closed by:** sprite icons at explicit sizes, guarded by `glyphs.test.ts`.

### RK-C6 — Tests only ever ran on one machine · Was: high

Nothing stopped a commit that failed the suite from reaching production.

**Closed by:** `.github/workflows/ci.yml`. RK-04 remains open, because CI
reports a failure but does not yet block anything.
