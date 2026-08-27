-- ===========================================================================
-- KINDLY 0007 — notifications, audit trail, rate limiting, data export
-- ===========================================================================

create table public.notifications (
  id             uuid primary key default extensions.gen_random_uuid(),
  family_id      uuid not null references public.families (id) on delete cascade,
  -- Recipient. Exactly one adult per row so unread counts are per person.
  user_id        uuid not null references public.users (id) on delete cascade,
  kind           public.notification_kind not null,
  title          text not null check (char_length(btrim(title)) between 1 and 140),
  body           text check (char_length(body) <= 400),
  -- What it points at, so clicking a notification always lands somewhere real.
  request_id     uuid references public.requests (id) on delete cascade,
  story_id       uuid references public.stories (id) on delete cascade,
  child_id       uuid references public.child_profiles (id) on delete cascade,
  route          text check (char_length(route) <= 200),
  is_urgent      boolean not null default false,
  read_at        timestamptz,
  -- Push delivery is best-effort and never the only path for urgent requests.
  push_attempted_at timestamptz,
  push_result    text check (push_result in ('sent','failed','skipped_permission','skipped_quiet_hours','unsupported')),
  created_at     timestamptz not null default kindly.now()
);
comment on column public.notifications.push_result is
  'Push is advisory. Urgent requests are additionally surfaced in-app, in the request list, and through escalation.';

create index idx_notifications_user_unread on public.notifications (user_id, created_at desc) where read_at is null;
create index idx_notifications_user_all    on public.notifications (user_id, created_at desc);
create index idx_notifications_request     on public.notifications (request_id);

-- --------------------------------------------------------------------------
-- audit_events — everything security-relevant that happens to family data
-- --------------------------------------------------------------------------
create table public.audit_events (
  id             bigint generated always as identity primary key,
  family_id      uuid references public.families (id) on delete set null,
  actor_user_id  uuid references public.users (id) on delete set null,
  actor_kind     text not null default 'caregiver' check (actor_kind in ('caregiver','child','system','support')),
  action         text not null check (char_length(action) between 1 and 80),
  entity_type    text not null check (char_length(entity_type) between 1 and 60),
  entity_id      uuid,
  -- Structured, minimal. Never message bodies, never PINs, never tokens.
  detail         jsonb not null default '{}'::jsonb,
  ip_hash        text,     -- salted hash only
  user_agent_family text check (char_length(user_agent_family) <= 60),
  occurred_at    timestamptz not null default kindly.now()
);
comment on table public.audit_events is
  'Append-only. Retained for 24 months, then purged by kindly.purge_expired_audit(). Contains no message content.';

create index idx_audit_family_time on public.audit_events (family_id, occurred_at desc);
create index idx_audit_actor_time  on public.audit_events (actor_user_id, occurred_at desc);
create index idx_audit_action      on public.audit_events (action, occurred_at desc);

-- --------------------------------------------------------------------------
-- rate_limits — token buckets for auth and request endpoints
-- --------------------------------------------------------------------------
create table public.rate_limits (
  bucket_key    text primary key,               -- e.g. 'pin:<family>' / 'request:<child>'
  window_start  timestamptz not null default kindly.now(),
  hit_count     int not null default 0,
  blocked_until timestamptz
);
comment on table public.rate_limits is
  'Server-side counters. No client role has any policy on this table.';

-- --------------------------------------------------------------------------
-- data_exports / deletion_requests — GDPR & family control
-- --------------------------------------------------------------------------
create table public.data_export_jobs (
  id            uuid primary key default extensions.gen_random_uuid(),
  family_id     uuid not null references public.families (id) on delete cascade,
  requested_by  uuid not null references public.users (id) on delete cascade,
  scope         text not null default 'family' check (scope in ('family','child','account')),
  child_id      uuid references public.child_profiles (id) on delete cascade,
  status        text not null default 'queued' check (status in ('queued','running','ready','failed','expired')),
  storage_path  text,
  error         text,
  requested_at  timestamptz not null default kindly.now(),
  completed_at  timestamptz,
  expires_at    timestamptz
);

create table public.deletion_requests (
  id            uuid primary key default extensions.gen_random_uuid(),
  family_id     uuid references public.families (id) on delete cascade,
  child_id      uuid references public.child_profiles (id) on delete cascade,
  user_id       uuid references public.users (id) on delete cascade,
  scope         text not null check (scope in ('account','child','family')),
  requested_by  uuid not null references public.users (id) on delete cascade,
  reason        text check (char_length(reason) <= 300),
  status        text not null default 'pending' check (status in ('pending','cancelled','completed')),
  -- A grace period so an accidental deletion can be undone.
  effective_at  timestamptz not null default (kindly.now() + interval '7 days'),
  requested_at  timestamptz not null default kindly.now(),
  completed_at  timestamptz
);
comment on column public.deletion_requests.effective_at is
  'Seven-day grace window. Soft-deleted immediately, hard-deleted after this time by kindly.run_pending_deletions().';

create index idx_export_jobs_family    on public.data_export_jobs (family_id, requested_at desc);
create index idx_deletion_pending      on public.deletion_requests (effective_at) where status = 'pending';
