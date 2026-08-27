# KINDLY — architecture overview

## What this is

A calm space for a child and the adults who support them, with three jobs:
prepare for something (stories), communicate a need (requests and feelings),
and get through a day together (routines).

KINDLY is **not** a medical device, a diagnostic tool, a therapy, or an
emergency service. Those boundaries are stated in the product, not only here —
see [limitations-and-safety.md](limitations-and-safety.md).

## Shape

```
 Browser
 ├─ React 18 + TypeScript, Vite build, React Router (real URLs)
 ├─ TanStack Query (loading / empty / error / retry as first-class states)
 ├─ Zod at every boundary
 └─ KindlyBackend  ─────────┬── SupabaseBackend   (production)
                            └── MemoryBackend     (tests + offline demo)

 Supabase
 ├─ Auth            email + password, PKCE, no browser flags anywhere
 ├─ Postgres        23 tables, RLS forced on every one
 ├─ RPC             SECURITY DEFINER functions — the only way to write a
 │                  request, a child session, an invitation, a PIN, or a
 │                  story approval
 ├─ Realtime        postgres_changes on requests / responses / notifications
 └─ Storage         private `kindly-media` bucket, short-lived signed URLs
```

### Why a backend interface

`src/lib/backend/types.ts` defines one interface. Two implementations satisfy
it:

* **`SupabaseBackend`** — the production path. Reads go through PostgREST with
  RLS applied. Every write that could affect safety goes through an RPC.
* **`MemoryBackend`** — a deterministic in-process implementation that enforces
  *the same authorization rules*. It exists so the unit, integration, a11y and
  end-to-end suites run offline and reproducibly, and so the app can be demoed
  without a project. It is selected only by `VITE_KINDLY_BACKEND=memory` and is
  tree-shaken out of a production build.

The memory backend serialises its emulated database into one `localStorage`
key. That is the stand-in for Postgres, not the application storing its own
data: no application module reads that key. See "Known limitations".

## The request lifecycle

```
reviewing ──send──▶ sending ──confirmed──▶ delivered ──answer──▶ acknowledged ──▶ resolved
    │                  │                      │                       │
    │                  ├─offline/error──▶ failed ──retry──▶ retrying ─┘
    │                  │
    │                  └─no eligible adult──▶ unavailable
    │                                          ▲
    └─────────── cancelled ◀───────────────────┴── waiting ──▶ escalated
```

Three rules are enforced in the database, not the UI:

1. **`delivered` means stored *and* routed.** `delivered_at` is written only
   inside `public.child_send_request()`, and only after notification rows exist
   for at least one adult who may answer. If there is nobody, the request
   becomes `unavailable` and the child is shown offline help — it never claims
   delivery.
2. **`acknowledged` means a human answered.** The status and
   `acknowledged_at` are written only alongside a `request_responses` row.
3. **An urgent request can never be delayed.** `public.respond_to_request()`
   refuses it, a trigger on `request_responses` refuses it, and the UI never
   renders the control. Three independent layers.

The state machine lives in `kindly.allowed_transition()`. `src/lib/requests/
stateMachine.ts` mirrors it so the UI can disable impossible actions without a
round trip, and `stateMachine.test.ts` parses the SQL and asserts the two are
identical — they cannot drift apart unnoticed.

### Duplicate prevention

Two mechanisms, both in the database:

* a per-child idempotency key (`client_dedupe_key`) unique per child, so the
  same tap-intent always returns the same row;
* a partial unique index on `(child_id, type_slug, child_facing_label)` over
  every open status, so a second open request of the same kind is impossible.

Repeated tapping therefore returns the existing request rather than creating
another one.

### Conflicting caregivers

An open request has one `assigned_to_user_id`. `respond_to_request()` takes a
`SELECT … FOR UPDATE` and refuses anyone else with `REQUEST_ASSIGNED_ELSEWHERE`,
naming who holds it. A second caregiver calls `claim_request()` first. This is
what stops a child getting two different answers.

### Escalation

Each child has an ordered ladder in `escalation_rules`, measured from delivery.
`kindly.escalate_family()` holds the rules; `public.tick_request_escalations()`
wraps it with a membership check for the app's 10-second heartbeat, and the
`kindly-escalations` cron job calls it for every family every 15 seconds. Both
paths run the same code, and it is idempotent. The ladder always ends with
`show_offline_help`; `SafetySettingsPage` appends that step if a caregiver
removes it, so a child is never left waiting with nothing to do.

## Identity

Three names, three tables, never derived from one another:

| Name | Table | Shown |
| --- | --- | --- |
| `caregiver_name` | `caregiver_profiles` | when this adult answers |
| `child_name` | `child_profiles` | throughout the child's own space |
| `trusted_caregiver_name` | `trusted_caregivers` | when escalation reaches them |

`assigned_to_name` and `responder_name` are **snapshots**. Renaming a caregiver
or revoking their access never rewrites what a child was told at the time.

Initials are grapheme-aware (`Intl.Segmenter`), so emoji, combining marks and
non-Latin scripts survive. When a name is genuinely unknown the product says
"your caregiver" or "your child" — never an invented first name.

## Child mode

Child mode runs under a **scoped child session**, created by an adult from the
caregiver view. `start_child_session()` returns a token whose SHA-256 hash is
stored in `child_sessions` along with an explicit `allowed_actions` array. Every
child-facing read and write goes through a `child_*` RPC that validates the
token, its expiry and that array. The client cannot widen the set.

Leaving child mode requires the family's grown-up code, verified by
`verify_caregiver_pin()`. The PIN is bcrypt-hashed in `caregiver_pins`, a table
with **no client policy at all** — no browser can select it, including a family
owner's. Two things never need the code: going back to the child's own day, and
the offline help screen.

## Stories

```
caregiver inputs → draft ─review─▶ (flags) ─approve─▶ approved ─assign─▶ child
                     ▲                                                    │
                     └───────────── any edit returns it to draft ─────────┘
```

`assign_story()` refuses anything that is not `approved`. `child_get_stories()`
returns only stories that are approved **and** assigned **and** not withdrawn.
Editing an approved story returns it to draft, so the child keeps reading the
last approved version until a caregiver approves the new one.

Generation has two paths that end in the same place. `supabase/functions/
generate-story` asks Claude for a draft and validates it against a schema;
`src/lib/stories/generator.ts` is a deterministic template builder used whenever
that service is unconfigured, unreachable or declines. The caregiver is always
told which one produced what they are reading. Whatever produces a draft,
it is validated against `generatedStorySchema` and run through
`src/lib/stories/safetyReview.ts` — 21 rules across coercion, unkeepable
promises, secrecy/unsafe contact, and deficit or figurative language, plus three
structural checks (more than one valid response, a way to ask for help, and
uncertainty marked as uncertainty). A `block` finding prevents approval until a
caregiver explicitly acknowledges it.

`minimalGenerationPayload()` is what an external service would receive: the
scenario and the caregiver's own description, and *not* the child's name, the
family's names, identifiers, request history, or anything the child wrote.

## Routing

Real routes throughout, so browser back, forward, refresh, bookmarks and deep
links all work: `/auth/*`, `/onboarding/:step`, `/app/*` (including
`/app/requests/:id`, `/app/stories/:id`, `/app/routines/:id`, `/app/settings/*`)
and `/child/*`. Unknown paths render a real 404 page.

## Accessibility architecture

* One polite and one assertive live region, mounted once in `AnnouncerProvider`.
  Status changes are announced once per change, de-duplicated within 1.5s.
* Display preferences are applied to `<html>` as CSS custom properties and data
  attributes, so text scale, contrast, low-stimulation and motion affect the
  whole page at once. The operating system's reduced-motion setting always wins
  over the profile.
* `Dialog` traps Tab, closes on Escape and restores focus to the opener.
* Every icon is `aria-hidden` by default; every control also carries words.

## Repository map

```
supabase/migrations/   13 migrations: schema, RLS, functions, realtime, cron
supabase/functions/    generate-story — the AI drafting path
supabase/seed.sql      demo family (local development only)
src/lib/               names, schemas, state machine, story builder + review
src/lib/backend/       the interface and its two implementations
src/state/             backend, announcer, auth, workspace, child session
src/components/        icon sprite and shared UI primitives
src/routes/            auth, onboarding, app/*, app/settings/*, child/*
src/test/              harness, setup, accessibility and component tests
e2e/                   journey, accessibility, responsive
docs/                  this file and the other deliverables
```
