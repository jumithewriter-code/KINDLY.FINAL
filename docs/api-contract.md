# API contract

Everything the frontend can do, and the guarantee each call makes.

The client talks to one interface, `KindlyBackend`
(`src/lib/backend/types.ts`). Against Supabase, reads are PostgREST selects
under RLS and safety-critical writes are RPC calls to SECURITY DEFINER
functions. **`requests` has no INSERT/UPDATE/DELETE policy for any client role**,
so the functions below are the only way a request can change.

Errors arrive as `KindlyError { code, message, detail?, retryable }`. Codes are
listed per call; `message` is already human-readable and safe to show.

---

## Conventions

* Every function pins `search_path = ''` and re-checks authorization itself.
  RLS is the second lock, not the only one.
* `NOT_AUTHENTICATED`, `NOT_A_FAMILY_MEMBER`, `NOT_PERMITTED` and `RATE_LIMITED`
  can be returned by any authenticated call and are not repeated below.
* Timestamps are ISO-8601 UTC. Ids are UUIDs.

---

## 1. Authentication

| Call | Supabase | Notes |
| --- | --- | --- |
| `signUp(email, password)` | `auth.signUp` | returns `needsEmailVerification`. `EMAIL_ALREADY_REGISTERED` is reported on the email field |
| `signIn(email, password)` | `auth.signInWithPassword` | `INVALID_CREDENTIALS` is **identical** for a wrong password and an unknown account |
| `signOut()` | `auth.signOut` | also clears the child session token |
| `sendPasswordReset(email)` | `auth.resetPasswordForEmail` | always resolves; never reveals whether the address exists |
| `updatePassword(next)` | `auth.updateUser` | requires the recovery session |
| `resendVerificationEmail(email)` | `auth.resend` | — |
| `onAuthStateChange(cb)` | `auth.onAuthStateChange` | clears the query cache on change |

## 2. Workspace

**`loadWorkspace(activeFamilyId?) → Workspace`**
One call returning the signed-in adult, their caregiver profile, their families,
the active family's members, children, per-child preferences, communication
methods, sensory notes, trusted caregivers, escalation rules, the request
vocabulary, the adult-verification mode, and any pending invitations addressed
to them.

**`bootstrapFamily({ caregiverName, childName, familyName?, trustedCaregiverName?, pin })`**
→ `public.bootstrap_family` — one transaction creating the caregiver profile,
the family, the owner membership, the child, default preferences, notification
preferences, an optional trusted caregiver, a three-rung escalation ladder
ending in `show_offline_help`, and the grown-up code. The code is **required**:
a family space holds a child's private communication, and the adult check has
nothing to check against without one.
Errors: `CAREGIVER_NAME_REQUIRED`, `CHILD_NAME_REQUIRED`, `PIN_REQUIRED`,
`PIN_MUST_BE_4_TO_8_DIGITS`.

**`saveOnboardingDraft(stage, data)`** — server-side resumable draft.
**`updateCaregiverProfile({ caregiverName, … })`** — upserts; an invited
caregiver has an account before a profile.

## 3. Children and preferences

| Call | Permission | Notes |
| --- | --- | --- |
| `addChild(familyId, { childName, pronouns? })` | `can_manage_children` | creates default preferences and a two-rung ladder |
| `updateChild(childId, patch)` | `can_manage_children` | name, pronouns, safe adult, safe place, emergency instructions |
| `archiveChild(childId, archived)` | `can_manage_children` | hides from child mode |
| `updateChildPreferences(childId, patch)` | member | `quietHoursAllowUrgent` is forced true |
| `setCommunicationMethods(childId, methods)` | member | replaces the set |
| `setSensoryPreferences(childId, items)` | member | replaces the set |
| `saveEscalationRules(childId, rules)` | `can_manage_safety` | the UI appends `show_offline_help` if absent |

## 4. Caregivers and invitations

| Call | RPC | Notes |
| --- | --- | --- |
| `inviteCaregiver(familyId, { email, role })` | `create_caregiver_invitation` | returns the raw token **once**; only its SHA-256 is stored. `CANNOT_INVITE_AS_OWNER` |
| `acceptInvitation(token)` | `accept_caregiver_invitation` | `INVITATION_NOT_FOUND` / `_EXPIRED` / `_EMAIL_MISMATCH` |
| `revokeInvitation(id)` | `revoke_caregiver_invitation` | — |
| `revokeCaregiverAccess(familyId, userId)` | `revoke_caregiver_access` | unassigns their open requests back to the family and notifies them. `CANNOT_REMOVE_LAST_OWNER` |
| `updateCaregiverRole(familyId, userId, role)` | `update_caregiver_role` | permissions are re-derived by trigger. `CANNOT_REMOVE_LAST_OWNER` |
| `upsertTrustedCaregiver(input)` / `removeTrustedCaregiver(id)` | table writes | `can_manage_caregivers` |

## 5. Adult verification

| Call | RPC | Guarantee |
| --- | --- | --- |
| `setCaregiverPin(familyId, pin)` | `set_caregiver_pin` | bcrypt, cost 10. Rejects `PIN_TOO_EASY_TO_GUESS` |
| `verifyCaregiverPin(familyId, pin)` | `verify_caregiver_pin` | returns **only** `{ ok, mode, attemptsRemaining?, lockedUntil? }`. 10 attempts / 15 min, then a 15-minute block; 5 wrong in a row locks for 5 minutes. With no code stored it returns `{ ok: false, mode: 'not_configured' }` — it never accepts an arbitrary code |
| `getAdultVerification(familyId)` | `get_adult_verification` | `{ mode, isConfigured, lockedUntil }` — whether a code exists, never the hash |
| `setAdultVerificationMode(familyId, mode)` | `set_adult_verification_mode` | `pin` \| `device_biometric` only. `none` raises `INVALID_VERIFICATION_MODE`: a family may choose *how* to verify, not whether |

`caregiver_pins` has **no client policy**. No browser can select it — which is
why `get_adult_verification` exists to answer the one question the app needs.

## 6. Child sessions

**`startChildSession(childId, deviceLabel?) → { sessionToken, … }`**
→ `start_child_session`. Ends any existing active session for that child.
Returns the token once; only its SHA-256 is stored, alongside an explicit
`allowed_actions` array and a 12-hour expiry.

`endChildSession(token)` and `revoke_child_session(id)` both end it immediately.

Every `child_*` call below runs `kindly.assert_child_session(token, action)`
first, which checks the hash, the state, the expiry and the action list.
Errors: `CHILD_SESSION_INVALID` / `_EXPIRED` / `_ENDED` / `_REVOKED`,
`CHILD_ACTION_NOT_PERMITTED`.

| Call | Action required | Returns |
| --- | --- | --- |
| `childGetSpace` | `read_own_preferences` | child name, pronouns, safe adult/place, emergency note, preferences, the request vocabulary with this child's bathroom urgency applied, trusted caregiver names |
| `childGetRequests` | `read_own_requests` | this child's open requests, plus any closed in the last hour |
| `childGetStories` | `read_assigned_stories` | approved **and** assigned **and** not withdrawn, with the remembered page |
| `childGetRoutines` | `read_own_routines` | routines and steps, plus any active run |
| `childSetStoryProgress` | `read_assigned_stories` | — |
| `childSendStoryFeedback` | `send_story_feedback` | notifies every eligible adult |

## 7. The request lifecycle

### `childCreateRequest(token, { typeSlug, dedupeKey, customMessage?, connectionState?, labelOverride?, detailOverride? })`
→ `child_create_request`. Creates a `reviewing` request. **Idempotent twice
over**: the same `dedupeKey` returns the same row, and an existing *open*
request of the same `(type, label)` is returned rather than duplicated.
Bathroom urgency comes from the child's own preference.
`labelOverride`/`detailOverride` serve the "How I feel" vocabulary, which shares
this lifecycle.
Errors: `DEDUPE_KEY_REQUIRED`, `UNKNOWN_REQUEST_TYPE`.

### `childSendRequest(token, requestId, connectionState?)`
→ `child_send_request`. **The only path to `delivered`.** In one transaction it:

1. moves to `sending` (or `retrying`) and increments `attempts`;
2. if the device reports `offline`, stops at `failed` / reason `offline` — it
   never claims delivery;
3. finds every adult with `can_answer_requests`, preferring whoever started the
   child session;
4. if there are none → `unavailable`, and the child is shown offline help;
5. writes a notification row for each of them;
6. **only then** sets `delivered` and `delivered_at`.

### `childCancelRequest` / `childResolveRequest`
Cancel is reachable from every live state. If the request had been delivered,
every eligible adult is notified that it was withdrawn.

### `respondToRequest({ requestId, kind, delayMinutes?, message?, urgency })`
→ `respond_to_request`. Takes `SELECT … FOR UPDATE`.

* `REQUEST_NOT_DELIVERED_YET` — you cannot answer what has not arrived.
* `REQUEST_ASSIGNED_ELSEWHERE` — only the assignee answers; `detail` names them.
* `URGENT_REQUEST_CANNOT_BE_DELAYED` — refused for `kind: 'delay'` on an urgent
  request. Also refused by a trigger on `request_responses`, and never rendered.
* Supersedes any previous response (`is_current`), sets `acknowledged_at`, and
  snapshots `responder_name`.

`kind` ∈ `seen | coming_now | delay | other_caregiver | safe_adult | safe_place`.

### `claimRequest` / `escalateRequest` / `resolveRequest` / `cancelRequestAsCaregiver`

| Call | Guard |
| --- | --- |
| `claimRequest(id)` | takes ownership so you can answer; `REQUEST_ALREADY_CLOSED` |
| `escalateRequest(id, trustedId?)` | `NO_TRUSTED_CAREGIVER_CONFIGURED`; valid transition only |
| `resolveRequest(id, confirmUrgent)` | `URGENT_RESOLVE_NEEDS_CONFIRMATION` unless true |
| `cancelRequestAsCaregiver(id, reason?)` | valid transition only |

### `tickEscalations(familyId) → number`
→ `tick_request_escalations`, which checks membership and delegates to
`kindly.escalate_family()`. Idempotent. Marks a `sending`/`retrying` request
stale after 60 s as `failed` / reason `interrupted`. Returns how many changed.

The same `kindly.escalate_family()` is driven server-side by the
`kindly-escalations` cron job, so escalation no longer depends on a caregiver
having the app open. The rules exist in exactly one place. Confirm the job
actually installed — DEPLOY.md §5.

### `subscribeToFamily(familyId, cb)` / `subscribeToChild(childId, cb)`
Supabase Realtime `postgres_changes` on `requests`, `request_responses` and
`notifications`, filtered server-side and still subject to RLS.

## 8. Routines

`listRoutines`, `saveRoutine`, `duplicateRoutine`, `archiveRoutine`,
`deleteRoutine`, `reorderRoutines` — all `can_edit_routines`.

`startRoutineRun`, `setRoutineStepState`, `setRoutineRunStatus`,
`getActiveRoutineRun` — any member. Step states are `pending | done | skipped |
changed`, recorded neutrally. **No score, streak or completion rate is stored or
derived**, and a unit test asserts the payload contains no such field.

## 9. Stories

| Call | Guarantee |
| --- | --- |
| `saveStoryDraft(input)` | **always produces a draft**, including when editing an approved story — the child keeps reading the last approved version. Runs `reviewStory()` and stores the flags per story and per page |
| `approveStory(id, acknowledgeFlags)` | snapshots a version, records approver and time. `STORY_TOO_SHORT` under 3 pages; `STORY_HAS_UNREVIEWED_FLAGS` unless acknowledged |
| `assignStory(id, childId)` | `STORY_NOT_APPROVED` for anything else. **This is the rule the whole pipeline exists to protect** |
| `withdrawStory(id, childId)` | removes it from child mode immediately |
| `archiveStory` / `deleteStory` / `duplicateStory` | as named |
| `generateStory(childId, input)` | Invokes the `generate-story` Edge Function. Throws `GENERATION_UNAVAILABLE` (no API key), `GENERATION_REFUSED` (the model declined), `GENERATION_INVALID` (failed schema validation), `RATE_LIMITED` or `GENERATION_FAILED` — the editor falls back to the built-in builder on every one of them and says which draft the caregiver is looking at. Returns a draft plus its provenance; it cannot approve or assign |
| `listStoryVersions` / `listStoryFeedback` / `markStoryFeedbackSeen` | — |

## 10. Notifications, media, data rights

| Call | Notes |
| --- | --- |
| `listNotifications(familyId)` | per recipient; last 100 |
| `markNotificationsRead(ids?)` | omit ids to mark all |
| `listMedia` / `uploadMedia` / `deleteMedia` | `altText` is required — `ALT_TEXT_REQUIRED` |
| `getSignedMediaUrl(mediaId)` | private bucket; 300-second signed URL. There are no public object URLs |
| `exportFamilyData(familyId)` | `can_export_data`; the complete family record as JSON |
| `requestDeletion(scope, opts)` | `account` \| `child` \| `family`. Soft-deletes at once, revokes live child sessions, seven-day grace. **The hard-delete sweep is not yet scheduled** — see privacy-compliance.md §4 |

---

## Function grants

Only these are `GRANT EXECUTE … TO authenticated`; everything else in the
`kindly` schema is unreachable from a browser, and the schema itself is excluded
from the PostgREST search path in `supabase/config.toml`.

```
bootstrap_family                 child_create_request
set_caregiver_pin                child_send_request
set_adult_verification_mode      child_cancel_request
verify_caregiver_pin             child_resolve_request
start_child_session              child_get_space
end_child_session                child_get_requests
revoke_child_session             child_get_stories
create_caregiver_invitation      child_get_routines
accept_caregiver_invitation      child_set_story_progress
revoke_caregiver_invitation      child_send_story_feedback
revoke_caregiver_access          respond_to_request
update_caregiver_role            claim_request
save_story_version               escalate_request
approve_story                    resolve_request
assign_story                     cancel_request_as_caregiver
withdraw_story                   tick_request_escalations
mark_notifications_read          export_family_data
request_deletion                 cancel_deletion
```
