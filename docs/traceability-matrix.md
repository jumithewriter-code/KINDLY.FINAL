# Requirements traceability matrix

For each safety-critical or privacy-critical requirement: where it is enforced,
and which test proves it. This is the artefact the V-Model half of
`docs/sdlc-process.md` rests on.

**Test names are quoted verbatim** so any row can be checked by searching for
the string. If a test is renamed and this file is not updated, the row becomes
unverifiable — which is the intended failure mode. A row with no test is marked
as such rather than left blank.

Enforcement is read as: a rule enforced in SQL cannot be bypassed by a client,
and a rule enforced only in TypeScript can be. Where both appear, the SQL is the
real boundary and the TypeScript is how the interface behaves.

---

## 1. A child's request reaches an adult, or the child is told

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R1.1 | "Delivered" means a caregiver's device has the request, not that sending was attempted | `child_send_request` is the only path to `delivered` (`…001000_functions_requests.sql`) | *"never reports delivered until the server has routed it"*; *"does not claim delivery while the device is offline"* |
| R1.2 | Repeated tapping never creates a second request | `client_dedupe_key` plus a partial unique index over open statuses | *"prevents duplicate requests from repeated tapping"*; *"sending twice does not send twice"*; e2e *"repeated tapping never creates two requests"* |
| R1.3 | A delivered request always has somebody able to answer it | Assignment logic in the request functions | *"keeps at least one adult able to answer, so a delivered request always has an assignee"* |
| R1.4 | An unanswered request escalates, and ends by showing offline help | `kindly.escalate_family` and the escalation ladder (`…001200_scheduled_jobs.sql`) | *"escalates an unanswered request and then shows offline help"* |
| R1.5 | The escalation ladder always ends in offline help, whatever the caregiver configures | `SafetySettingsPage` appends the step if it is missing before saving | *"refuses to escalate when no trusted caregiver is configured"* — **partial**: the append itself has no direct test |
| R1.6 | A request accepted but never confirmed is recorded as interrupted, not lost | State machine, mirrored in SQL and TypeScript | *"marks a request that was accepted but never confirmed as interrupted"* |
| R1.7 | The SQL and TypeScript state machines cannot drift apart | `kindly.allowed_transition` and `src/lib/requests/stateMachine.ts` | `stateMachine.test.ts` parses the SQL and compares the two tables (27 tests) |

## 2. An urgent request can never be answered unsafely

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R2.1 | An urgent request can never receive a "wait a little" answer | Database check constraint (migration 0004) **and** the UI | *"rejects a delayed answer to an urgent request"*; e2e *"an urgent request is never offered a delayed answer…"* |
| R2.2 | A delayed answer is still allowed when the request can wait | Same constraint | *"allows a delay when the request can wait"* |
| R2.3 | An urgent request cannot be closed without explicit confirmation | `RequestDetailPage` confirmation dialog | *"will not close an urgent request without an explicit confirmation"*; e2e *"…needs confirmation to close"* |
| R2.4 | Whether a bathroom request is urgent is the family's decision, not a default | `child_preferences.bathroom_urgency`, defaulting to urgent | *"applies the child's own bathroom urgency setting"* |

## 3. One family cannot read another

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R3.1 | Row-level security is enabled **and forced** on all 33 tables, with all privileges revoked from `anon` | `…000800_rls.sql` | `DEPLOY.md` step 1 verification query; live suite *"creates a family and reads it back through loadWorkspace"* |
| R3.2 | An adult from another family cannot read, answer or start a session in this family | RLS policies; `kindly.is_member` | *"an adult from another family cannot read this family"*, *"…cannot start a child session here"*, *"…cannot answer a request here"* |
| R3.3 | A revoked caregiver loses access immediately | `family_members.revoked_at` checked in policies | *"revoking a caregiver stops their access immediately"* |
| R3.4 | A view-only caregiver cannot answer a request | Per-role permission columns | *"a view-only caregiver cannot answer a request"* |
| R3.5 | Only a caregiver with the permission can change safety settings | `kindly.has_permission(…, 'can_manage_safety')` | *"only a caregiver with the right permission can change safety settings"* |
| R3.6 | A family cannot be left without an owner | Guard in the member-removal function | *"refuses to remove the last owner"* |

## 4. The adult check is real

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R4.1 | Verification never fails open when no code is stored | `verify_caregiver_pin` returns `not_configured` (migration 0013) | *"does not accept an arbitrary code when none is set"* |
| R4.2 | A family space cannot be created without a code | `bootstrap_family` raises `PIN_REQUIRED` | *"refuses to create a family space without a code"* |
| R4.3 | The code cannot be switched off | `set_adult_verification_mode` rejects `'none'` | *"will not switch adult verification off"* |
| R4.4 | The code, or any hash of it, is never readable by a client | `caregiver_pins` has **no policy at all**; `get_adult_verification` returns one boolean | *"never returns the PIN or a hash of it to a client"*; *"reports whether a code is configured without revealing it"* |
| R4.5 | Repeated wrong codes lock the keypad | Attempt counter and `locked_until` | *"locks out after repeated wrong codes"* |
| R4.6 | Urgent help and offline help are always reachable **without** the code | `ChildExitPage` keeps both routes outside the gate | e2e *"leaving child mode needs the grown-up code, but help never does"* |

## 5. A child sees only what a caregiver approved

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R5.1 | A story is a draft until approved, and editing an approved story returns it to draft | `save_story_draft` | *"always saves as a draft, even when editing an approved story"* |
| R5.2 | An unapproved story can never reach a child | Child-facing queries filter on approved **and** assigned | *"refuses to give an unapproved story to a child"*; *"a child can only open an approved AND assigned story"*; e2e *"a generated story is a draft until a caregiver approves and assigns it"* |
| R5.3 | Who approved a story is recorded, with a version snapshot | `story_versions` | *"records who approved a story and keeps a version snapshot"* |

## 6. Nothing scores the child

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R6.1 | A routine run records a skipped step neutrally and produces no score | No score column exists | *"records a skipped step neutrally and never scores a run"* |
| R6.2 | A run can be "plans changed" rather than failed | `routine_runs` status values | *"can be marked as plans changed rather than failed"* |
| R6.3 | Story progress stores position, never completion | `story_progress.last_page` only | *"remembers where the child got to, and stores no completion measure"* |
| R6.4 | A child's story feedback reaches a caregiver only when the child sends it | Explicit send step | *"a child's story feedback reaches the caregiver only after they send it"* |

## 7. Identity and privacy

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R7.1 | Caregiver, child and trusted-caregiver names are separate fields; no placeholder identities | Three distinct columns | *"stores three distinct names in three distinct places"*; *"renaming the caregiver does not touch the child"* and its converse |
| R7.2 | A wrong password and an unknown account are indistinguishable | Single error message | *"gives the same message for a wrong password and an unknown account"* |
| R7.3 | Password reset never reveals whether an address is registered | Supabase returns 200 either way; the client surfaces only send failures | *"never reveals whether a password-reset address exists"* |
| R7.4 | A child session returns only child-facing data | `child_get_space` selects a fixed shape | *"returns only child-facing data, never caregiver credentials"* |
| R7.5 | A caregiver can export the whole family record, and deletion ends live sessions at once | `export_family_data`, `request_deletion` | *"exports the whole family record"*; *"deleting a child profile ends its live sessions immediately"* |

## 8. The operator can measure without surveilling

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R8.1 | Operator metrics are refused to everyone not in `kindly.operators` | `operator_metrics` checks `kindly.is_operator()` | *"refuses metrics to an ordinary caregiver"*; *"refuses metrics to a caregiver from another family"* |
| R8.2 | No client can grant itself operator status | `kindly.operators` has RLS forced and **no policy**; no backend method writes it | *"has no client path to becoming an operator"* |
| R8.3 | Metrics contain no name, message or family identifier | The return shape is fixed in SQL | *"returns aggregates once granted, and never a name or a message"* — asserts seeded names, free text and ids are absent from the payload |
| R8.4 | A per-request-type breakdown is withheld below five families | Threshold in SQL, mirrored in the memory backend | *"withholds the request-type breakdown while too few families exist"* |
| R8.5 | Funnel steps are cumulative and can only narrow | Each step filters on all previous conditions | *"reports the signup funnel as counts that only ever narrow"* |

## 9. Accessibility

| # | Requirement | Enforced in | Proven by |
|---|---|---|---|
| R9.1 | No detectable WCAG 2.1/2.2 AA violations on any screen | — | `accessibility.test.tsx` (27 tests) and e2e *"every signed-out / caregiver / child screen passes axe"* |
| R9.2 | Every interactive target is at least 44×44 CSS pixels | `src/styles/app.css` | e2e *"every interactive target is at least 44 by 44 CSS pixels"* |
| R9.3 | Keyboard focus is always visible and reaches every control | `:focus-visible` rules | e2e *"keyboard focus is always visible and reaches every control"* |
| R9.4 | Status is never carried by colour alone | Icon and text accompany every state | e2e *"status is never carried by colour alone"* |
| R9.5 | The page works and does not scroll sideways at 200% zoom | Relative units and flexible layout | e2e *"the page still works, and does not scroll sideways, at 200% zoom"* |
| R9.6 | Meaning never depends on a font rendering a glyph | Sprite icons at explicit sizes | `glyphs.test.ts` — added after black boxes appeared on a real screen and 194 tests had passed |
| R9.7 | Colour contrast meets AA | `src/styles/app.css` section 12 | **No automated test.** `axe`'s contrast rule is disabled under jsdom, which has no layout engine. Verified by measurement and recorded in `docs/accessibility-report.md` |

---

## Known gaps

Rows above marked **partial** or **no automated test**, collected:

- **R1.5** — that the escalation ladder always gains an offline-help step on
  save is implemented but not directly tested.
- **R9.7** — colour contrast is verified by measurement, not by a test that
  would fail if someone changed a colour.

Both are carried in `docs/risk-register.md`.
