# Database schema and Row Level Security

23 tables, all with RLS **enabled and forced**, all with `REVOKE ALL … FROM anon`.
Migrations are in `supabase/migrations/`, applied in filename order.

---

## 1. Migrations

| File | Contents |
| --- | --- |
| `…000100_extensions_and_enums` | pgcrypto, citext, pg_trgm; the private `kindly` schema; 13 enums; `normalize_name()`, `touch_updated_at()`, `now()` |
| `…000200_identity` | users, caregiver_profiles, families, family_members, child_profiles, trusted_caregivers, caregiver_invitations, caregiver_pins, child_sessions |
| `…000300_preferences` | child_preferences, communication_methods, sensory_preferences, escalation_rules, notification_preferences |
| `…000400_requests` | request_types, requests, request_responses, request_events |
| `…000500_routines` | routines, routine_steps, routine_runs |
| `…000600_stories_media` | media_assets, stories, story_pages, story_versions, story_assignments, story_progress, story_feedback; deferred FKs |
| `…000700_notifications_audit` | notifications, audit_events, rate_limits, data_export_jobs, deletion_requests |
| `…000800_rls` | the predicates, RLS on everything, every policy, the storage bucket |
| `…000900_functions_core` | audit, rate limiting, the auth mirror trigger, the role→permission matrix, the built-in request vocabulary, bootstrap, PINs, child sessions |
| `…001000_functions_requests` | the state machine and the whole request lifecycle |
| `…001100_functions_family_stories` | invitations, caregiver management, story approval, child reads, notifications, export, deletion, realtime |
| `…001200_scheduled_jobs` | `kindly.escalate_family()` (the shared escalation core), `run_pending_deletions()` (the hard delete the grace window promises), and the three `pg_cron` schedules |

## 2. The predicates

Policies never query `family_members` directly — that would recurse. They call
these, which are `SECURITY DEFINER` and therefore bypass RLS themselves:

```sql
kindly.is_member(family)              -- an ACTIVE membership in a live family
kindly.member_role(family)            -- owner | caregiver | trusted | view_only
kindly.has_permission(family, perm)   -- one of eight boolean columns
kindly.family_of_child(child)
kindly.can_access_child(child)
```

`is_member` requires `revoked_at IS NULL` **and** the family not deleted, so
revoking a caregiver takes effect on the next statement.

## 3. Roles and permissions

`family_members.role` sets eight booleans through the
`trg_family_members_role_defaults` trigger, so a role change cannot leave stale
permissions:

| | owner | caregiver | trusted | view_only |
| --- | --- | --- | --- | --- |
| answer requests | ✓ | ✓ | ✓ | |
| edit routines | ✓ | ✓ | | |
| edit stories | ✓ | ✓ | | |
| approve stories | ✓ | ✓ | | |
| manage children | ✓ | | | |
| manage caregivers | ✓ | | | |
| manage safety | ✓ | | | |
| export data | ✓ | | | |

A family always keeps at least one owner: `revoke_caregiver_access()` and
`update_caregiver_role()` both raise `CANNOT_REMOVE_LAST_OWNER`.

## 4. Policies, by table

### Reachable by no client at all

```sql
REVOKE ALL ON public.caregiver_pins FROM authenticated, anon;
REVOKE ALL ON public.rate_limits    FROM authenticated, anon;
REVOKE SELECT (token_hash) ON public.child_sessions FROM authenticated;
```

**No policy is created for `caregiver_pins`.** A PIN hash cannot be selected by
anyone, including the family owner. Verification happens entirely inside
`verify_caregiver_pin()`, which returns a boolean.

### Read-only to clients, written only by functions

| Table | Client policy | Written by |
| --- | --- | --- |
| `requests` | SELECT for family members | `child_send_request`, `respond_to_request`, `claim_request`, `escalate_request`, `resolve_request`, `cancel_request_as_caregiver`, `tick_request_escalations` |
| `request_responses` | SELECT only | `respond_to_request` |
| `request_events` | SELECT only — **append-only, no update or delete policy exists** | `kindly.record_event` |
| `audit_events` | SELECT only, and only with `can_manage_caregivers` | `kindly.log_audit` |

This is what makes `delivered_at` impossible to forge: there is no write path
from a browser.

### Normal family-scoped tables

`families`, `child_profiles`, `trusted_caregivers`, `child_preferences`,
`communication_methods`, `sensory_preferences`, `escalation_rules`, `routines`,
`routine_steps`, `routine_runs`, `media_assets`, `stories`, `story_pages`,
`story_versions`, `story_assignments`, `story_progress`, `story_feedback`.

Pattern: `SELECT` for any member; write gated on the relevant permission. For
example routines require `can_edit_routines`; escalation rules require
`can_manage_safety`; story assignment requires `can_approve_stories`.

### Per-person tables

`notifications` and `notification_preferences` are `user_id = auth.uid()` only —
unread counts are genuinely per person. `users` is self-only, except that
`caregiver_profiles` is visible to adults who share a family, so a child can be
told who answered.

### Bootstrapping

`family_members` needs one careful policy: an owner must be able to insert their
own first membership, but nobody may add anyone else directly.

```sql
create policy family_members_insert_owner on public.family_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.families f
                 where f.id = family_id and f.created_by = auth.uid())
  );
```

Every subsequent membership is created by `accept_caregiver_invitation()`.

### Storage

Objects live at `<family_id>/<child_id|shared>/<uuid>.<ext>` in the **private**
`kindly-media` bucket. Policies parse the first path segment and check
`kindly.is_member()`. Reads are always short-lived signed URLs; there are no
public object URLs.

## 5. Constraints that carry meaning

Some rules are expressed as constraints so they cannot be violated by any code
path, present or future:

```sql
-- delivery cannot precede sending, and acknowledgement cannot precede delivery
requests_delivery_order
requests_ack_order

-- a status at or past "delivered" must actually have a delivery timestamp
requests_delivered_requires_timestamp
requests_acknowledged_requires_timestamp

-- a delayed response must carry a duration
response_delay_shape

-- a story cannot be approved without recording who approved it and when
stories_approved_needs_approver

-- a generated story must carry its provenance once it leaves draft
stories_generated_needs_provenance
```

Plus a trigger, `trg_response_urgency_guard`, which raises
`URGENT_REQUEST_CANNOT_BE_DELAYED` on insert or update. Together with the check
in `respond_to_request()` and the UI never rendering the control, that is three
independent layers on the same rule.

## 6. Indexes that matter

```sql
-- repeated tapping cannot create two open requests of the same kind
idx_requests_one_open_per_type  (child_id, type_slug, child_facing_label)
  WHERE status IN (every open status)

-- the same tap-intent always returns the same row
idx_requests_dedupe             (child_id, client_dedupe_key)

-- the caregiver inbox, and the escalation sweep
idx_requests_family_open        (family_id, created_at DESC) WHERE live
idx_requests_escalation_sweep   (status, delivered_at)

-- exactly one current response per request
idx_responses_one_current       (request_id) WHERE is_current

-- revocation-aware membership lookups
idx_family_members_user_active  (user_id) WHERE revoked_at IS NULL
```

## 7. Realtime

`requests`, `request_responses`, `request_events`, `notifications`,
`story_assignments` and `routine_runs` are in the `supabase_realtime`
publication, with `REPLICA IDENTITY FULL` on the mutable ones so RLS can be
evaluated against old rows. Subscriptions are filtered by `family_id` or
`child_id` server-side and remain subject to RLS.

## 8. Verifying RLS after a deploy

```sql
select tablename, rowsecurity, forcerowsecurity
from pg_tables where schemaname = 'public' order by tablename;
```

Every row must show `t` in both columns. Then confirm the two locked tables have
no policies at all:

```sql
select tablename, count(*) from pg_policies
where schemaname = 'public' and tablename in ('caregiver_pins','rate_limits')
group by tablename;
```

Both should return zero rows.

## 9. What the tests cover

`src/lib/backend/memory.test.ts` mirrors these rules in the in-process backend
and asserts them: an adult from another family cannot read requests, routines or
stories, cannot start a child session, and cannot answer; a `view_only`
caregiver cannot answer; the last owner cannot be removed; a revoked caregiver
loses access immediately; the PIN is never returned to a client; a child session
cannot exceed its action list.

**These tests mirror the author's intent. They are not an independent review of
the SQL policies** — see privacy-compliance.md §5.
