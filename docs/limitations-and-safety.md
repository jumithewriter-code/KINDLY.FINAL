# Known limitations and safety boundaries

Read this before KINDLY is used by a real family, and before any claim is made
about what it does.

---

## 1. What KINDLY is not

KINDLY is **not**:

* a medical device
* a diagnostic tool
* a therapy, an intervention, or a treatment
* an emergency service
* a monitoring or surveillance product

It is a communication aid. It helps a child tell an adult something, helps an
adult answer, and helps both prepare for a situation in advance.

These boundaries are stated in the product itself — on the sign-in screen, in
Settings, and on every urgent request — not only in this document.

### KINDLY never contacts anybody on your behalf

There is no code path that dials a number, sends an SMS, or contacts emergency
services. When a request cannot be answered, KINDLY shows the child the safe
adult and safe place **the family configured**, and tells them to find a
grown-up nearby. The offline-help screen says plainly: *"Kindly cannot call
anyone for you."*

If a family enters emergency instructions, those are shown to **caregivers** on
an urgent request. KINDLY never acts on them.

---

## 2. Safety-critical behaviours, and how they are enforced

| Rule | Where it is enforced |
| --- | --- |
| "Delivered" only after the server has stored **and** routed the request | `public.child_send_request()`; `delivered_at` is written nowhere else |
| Never say a caregiver has seen a request until they answered | status and `acknowledged_at` written only alongside a `request_responses` row |
| An urgent request can never be answered with a delay | `respond_to_request()`, a trigger on `request_responses`, and the UI never renders the control |
| Closing an urgent request needs explicit confirmation | `resolve_request(p_confirm_urgent)` refuses without it |
| Two caregivers cannot give two different answers | `SELECT … FOR UPDATE` plus an assignment check; a second caregiver must claim it first |
| Repeated tapping cannot create two requests | per-child idempotency key **and** a partial unique index over every open status |
| A child is never left waiting indefinitely | the escalation ladder always ends in `show_offline_help`; the settings screen re-appends that step if a caregiver removes it |
| No story reaches a child without caregiver approval | `assign_story()` refuses anything not `approved`; `child_get_stories()` returns only approved **and** assigned **and** not withdrawn |
| Urgent requests are never silenced by quiet hours | `quiet_hours_allow_urgent` is locked on in the UI and defaults true in the schema |

Each of these has a test. See `src/lib/backend/memory.test.ts` and
`e2e/journey.spec.ts`.

---

## 3. Known limitations

### 3a. Child mode shares the caregiver's authenticated session

**This is the most important limitation in the product.**

Child mode runs under a scoped session token stored in `child_sessions`, with an
explicit `allowed_actions` array checked by every `child_*` RPC. The client
cannot widen that set, and a caregiver can revoke the session at any time.

**But** the device is still authenticated as the caregiver who handed it over. A
technically capable person in child mode could open developer tools and query
the database with the caregiver's rights.

What mitigates it today: the PIN gate on leaving child mode, an audit log, and
the fact that every *write* is scoped to the permitted action list.

What does not mitigate it: nothing prevents a determined reader from seeing
caregiver-visible data on that device.

**The fix** is a genuinely low-privilege child JWT issued through a Supabase
custom auth hook, so RLS itself constrains the child session. That is not built.
Until it is, treat a device in child mode as a device the child can read the
family's data from.

### 3b. Escalation now runs server-side, but has never run on a real project

Migration `…001200_scheduled_jobs.sql` installs three `pg_cron` jobs:
escalation every 15 seconds, deletions nightly, retention nightly. The caregiver
app still runs its own heartbeat, so escalation works either way.

**Untested against a hosted Supabase project.** The migration degrades safely —
if `pg_cron` is unavailable it raises a warning instead of failing — so after
deploying, check that the jobs actually exist:

```sql
select jobname, schedule, active from cron.job where jobname like 'kindly-%';
```

If they are missing, escalation only runs while a caregiver has the app open.

### 3c. Push notifications are not implemented

The permission flow, the preference storage and the `notifications` table exist.
No service worker or push service is wired up; `push_result` is always null.

This is by design rather than an oversight: an urgent request never depends on a
push arriving. It is also surfaced in-app, in the request list, in the banner
across every screen, and through escalation. But a caregiver who does not have
the app open will not be alerted on their device.

### 3d. Story generation has two paths, and the AI one is untested

`supabase/functions/generate-story` calls Claude and validates the result
against a schema before returning it. `src/lib/stories/generator.ts` is a
deterministic template builder used when the service is unconfigured,
unreachable, or declines.

Both paths end identically: a **draft**, run through `reviewStory()`, that a
caregiver must read and approve. Neither can put text in front of a child.

What the model receives is exactly `minimalGenerationPayload()` — the scenario
and the caregiver's own description. **Not** the child's name, the family's
names, identifiers, request history, or anything the child wrote. A unit test
asserts those omissions.

**The Edge Function has never been deployed or executed.** Until it has, assume
every generation falls back to the template builder — which is what the editor
tells the caregiver when it happens.

Two things a review should confirm before it is switched on for real families:
that the provider's data-retention and training terms are acceptable for this
content, and that the prompt's constraints hold under adversarial caregiver
input.

### 3e. Media upload is untested against a live project

`SupabaseBackend.uploadMedia()` and the private `kindly-media` bucket policies
exist but have never run against a hosted Supabase instance.

### 3f. Bathroom urgency is a family decision KINDLY cannot make

KINDLY ships `bathroom` as **urgent** by default and does not assume it can
safely wait. The setting is per child, and the settings screen says to decide it
with the child's clinicians where that applies. This is a genuine clinical
question and the default is a conservative guess, not advice.

### 3g. No usability testing has been done

The brief asks for testing with autistic people of varied support needs, AAC
users, nonspeaking users, caregivers and accessibility specialists. **None has
happened.** The neurodiversity-affirming choices in this build are applied from
published principles, not validated with the people they affect. Nothing here
should be presented as evidence-based until that testing exists.

### 3h. Rate limits are per-family, not per-IP

`kindly.rate_limit()` counts against a family or user key. It does not see IP
addresses, so it slows credential stuffing against a known account but does not
stop distributed enumeration. Supabase's own auth rate limits sit in front of
this (`supabase/config.toml`), and should be tuned per deployment.

---

## 4. Neurodiversity-affirming choices, stated plainly

These were deliberate, and reversing them should be a deliberate decision too.

* **Nothing is scored.** Routine runs record what happened; there is no
  completion rate, streak, or reward. `memory.test.ts` asserts a run's payload
  contains no score, streak or points field.
* **A skipped step looks the same size as a completed one**, and is described as
  "skipped, and that is fine".
* **"Plans changed" is a first-class outcome**, not a failure state.
* **Nothing surprises the child.** Sound, vibration, animation and countdowns are
  all off by default, per child. The OS reduced-motion setting always overrides
  the profile.
* **A countdown is optional.** When it is off, a delayed answer shows a
  progress bar and words, never a ticking clock.
* **The child can always decline.** Cancel is reachable from every live state,
  "I don't know" and "Something else" are first-class feeling choices, and a
  story can be stopped at any page.
* **Speech is never required.** Communication methods are per child and include
  AAC, gestures, photos and yes/no choices.
* **Generated stories are linted** for coercive, compliance-training, secrecy,
  deficit-based and mind-reading language, and for promises a story cannot keep.
  21 rules, in `src/lib/stories/safetyReview.ts`.
* **Preferences are individual.** Nothing in the product claims a setting suits
  autistic children generally.

---

## 5. Privacy, and what is deliberately not stored

* **PINs** are bcrypt-hashed in `caregiver_pins`, a table with **no client
  policy at all**. No browser can read it, including a family owner's.
* **Invitation and child-session tokens** are stored only as SHA-256 hashes.
* **`request_events.detail` never contains the child's own message text** — only
  structured metadata. A child's words are in `requests.custom_message` and go
  no further.
* **`story_progress` stores a page number, never a comprehension or completion
  measure.**
* **`audit_events` records who did what**, with a salted IP hash at most, and
  never message content.

Retention: audit history 24 months, then purged by `kindly.purge_expired_audit()`.
Deletion requests soft-delete immediately and hard-delete after a seven-day
grace window.

**Regulatory status: not reviewed.** COPPA, GDPR/UK GDPR and any applicable
health-data rules have **not** been assessed by anyone qualified. The schema and
the deletion/export paths were built with them in mind — data minimisation,
right of access, right to erasure, purpose limitation — but *built with them in
mind is not compliance*. Do not claim compliance. See
[privacy-compliance.md](privacy-compliance.md) for the specific questions a
review would need to answer.
