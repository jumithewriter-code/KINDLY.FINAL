-- ===========================================================================
-- KINDLY 0004 — the help-request system
-- ===========================================================================
-- Reliability rules encoded here, not merely in the UI:
--   * delivered_at is only ever written inside public.child_send_request();
--     the client cannot claim delivery.
--   * acknowledged_at is only ever written alongside a request_responses row.
--   * a partial unique index makes a duplicate open request of the same type
--     impossible, so repeated tapping cannot create two requests.
--   * a CHECK constraint makes `delay` responses to urgent requests
--     unrepresentable in the database.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- request_types — family-configurable request vocabulary
-- --------------------------------------------------------------------------
create table public.request_types (
  id                 uuid primary key default extensions.gen_random_uuid(),
  family_id          uuid references public.families (id) on delete cascade, -- null = KINDLY default
  child_id           uuid references public.child_profiles (id) on delete cascade, -- null = whole family
  slug               text not null check (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- The words the child actually sees. Short and literal.
  child_facing_label text not null check (char_length(btrim(child_facing_label)) between 1 and 40),
  child_facing_detail text check (char_length(child_facing_detail) <= 80),
  urgency            public.request_urgency not null default 'can_wait',
  -- Built-in symbol id (e.g. "i-droplet") or a media_assets row for a custom
  -- pictogram / family-approved photo.
  pictogram_key      text check (char_length(pictogram_key) <= 60),
  pictogram_media_id uuid,                       -- FK added in 0006
  color_key          text not null default 'blue' check (color_key in ('coral','blue','purple','yellow','mint','peach')),
  sort_order         int not null default 0,
  is_active          boolean not null default true,
  is_builtin         boolean not null default false,
  created_by         uuid references public.users (id) on delete set null,
  deleted_at         timestamptz,
  created_at         timestamptz not null default kindly.now(),
  updated_at         timestamptz not null default kindly.now()
);
comment on table public.request_types is
  'The child-facing request vocabulary. Families may add, hide, relabel and re-picture entries; urgency of each is family-configurable (see bathroom guidance in docs/limitations-and-safety.md).';

create unique index idx_request_types_scope
  on public.request_types (coalesce(family_id, '00000000-0000-0000-0000-000000000000'::uuid),
                           coalesce(child_id,  '00000000-0000-0000-0000-000000000000'::uuid),
                           slug)
  where deleted_at is null;

-- --------------------------------------------------------------------------
-- requests
-- --------------------------------------------------------------------------
create table public.requests (
  id                  uuid primary key default extensions.gen_random_uuid(),
  family_id           uuid not null references public.families (id) on delete cascade,
  child_id            uuid not null references public.child_profiles (id) on delete cascade,
  child_session_id    uuid references public.child_sessions (id) on delete set null,
  request_type_id     uuid references public.request_types (id) on delete set null,

  -- Denormalized so the record still reads correctly if the type is later
  -- relabelled or removed. The child's words at the moment they asked.
  type_slug           text not null,
  child_facing_label  text not null check (char_length(btrim(child_facing_label)) between 1 and 40),
  child_facing_detail text check (char_length(child_facing_detail) <= 80),
  urgency             public.request_urgency not null,
  pictogram_key       text,
  pictogram_media_id  uuid,                       -- FK added in 0006
  custom_message      text check (char_length(custom_message) <= 300),

  status              public.request_status not null default 'reviewing',

  -- Lifecycle timestamps. Each one is written by exactly one server function.
  created_at          timestamptz not null default kindly.now(),
  sending_started_at  timestamptz,
  delivered_at        timestamptz,
  acknowledged_at     timestamptz,
  resolved_at         timestamptz,
  cancelled_at        timestamptz,
  waiting_since       timestamptz,
  escalated_at        timestamptz,
  unavailable_at      timestamptz,

  assigned_to_user_id uuid references public.users (id) on delete set null,
  assigned_to_trusted_id uuid references public.trusted_caregivers (id) on delete set null,
  -- Snapshot of the display name shown to the child, so revoking a caregiver
  -- later never rewrites what the child was told at the time.
  assigned_to_name    text,

  attempts            int not null default 0 check (attempts >= 0 and attempts <= 20),
  failure_reason      text check (failure_reason in ('offline','interrupted','server_error','timeout')),
  cancelled_by        text check (cancelled_by in ('child','caregiver','system')),

  -- Device / connection context, only what is needed to explain a failure.
  device_label        text check (char_length(device_label) <= 120),
  connection_state    text check (connection_state in ('online','offline','unknown')),

  -- Idempotency: the client sends a stable key per tap-intent.
  client_dedupe_key   text check (char_length(client_dedupe_key) between 8 and 64),

  -- Optimistic-concurrency guard for competing caregiver actions.
  lock_version        int not null default 0,

  updated_at          timestamptz not null default kindly.now(),

  -- Delivery may only be claimed once and never before sending started.
  constraint requests_delivery_order check (
    delivered_at is null or (sending_started_at is not null and delivered_at >= sending_started_at)),
  constraint requests_ack_order check (
    acknowledged_at is null or (delivered_at is not null and acknowledged_at >= delivered_at)),
  -- Any status at or past "delivered" must actually have a delivery timestamp.
  constraint requests_delivered_requires_timestamp check (
    status not in ('delivered','waiting','escalated','unavailable','acknowledged')
    or delivered_at is not null),
  constraint requests_acknowledged_requires_timestamp check (
    status <> 'acknowledged' or acknowledged_at is not null)
);

comment on column public.requests.delivered_at is
  'Written only inside public.child_send_request(), and only once the request is stored and routed to an adult who can answer. The UI must never render "Delivered" without it.';
comment on column public.requests.assigned_to_name is
  'Name snapshot. Prevents a later rename or revocation from rewriting history the child already saw.';

-- One open request per (child, type, child-facing label). Repeated tapping is
-- therefore a no-op, while two different feelings ("Tired" / "Sore") remain
-- distinct messages.
create unique index idx_requests_one_open_per_type
  on public.requests (child_id, type_slug, child_facing_label)
  where status in ('reviewing','sending','retrying','failed','delivered','waiting','escalated','unavailable','acknowledged');

-- Idempotency key scoped to the child.
create unique index idx_requests_dedupe
  on public.requests (child_id, client_dedupe_key)
  where client_dedupe_key is not null;

create index idx_requests_family_open on public.requests (family_id, created_at desc)
  where status in ('sending','retrying','failed','delivered','waiting','escalated','unavailable','acknowledged');
create index idx_requests_child_recent on public.requests (child_id, created_at desc);
create index idx_requests_assigned     on public.requests (assigned_to_user_id, status) where assigned_to_user_id is not null;
create index idx_requests_escalation_sweep on public.requests (status, delivered_at)
  where status in ('delivered','waiting','escalated');

-- --------------------------------------------------------------------------
-- request_responses — what a caregiver actually said
-- --------------------------------------------------------------------------
create table public.request_responses (
  id                  uuid primary key default extensions.gen_random_uuid(),
  request_id          uuid not null references public.requests (id) on delete cascade,
  family_id           uuid not null references public.families (id) on delete cascade,
  kind                public.response_kind not null,
  -- Only meaningful for `delay`.
  delay_minutes       int check (delay_minutes between 1 and 120),
  due_at              timestamptz,
  -- Free-text addition, e.g. "Meet me in the kitchen".
  message             text check (char_length(message) <= 200),
  responder_user_id   uuid references public.users (id) on delete set null,
  responder_trusted_id uuid references public.trusted_caregivers (id) on delete set null,
  responder_name      text not null,             -- snapshot, never a placeholder
  is_current          boolean not null default true,
  created_at          timestamptz not null default kindly.now(),

  -- SAFETY: a delayed / "not right now" answer is not representable for an
  -- urgent request. Enforced again in kindly.respond_to_request().
  constraint response_delay_shape check (
    (kind = 'delay' and delay_minutes is not null and due_at is not null)
    or (kind <> 'delay' and delay_minutes is null and due_at is null))
);
comment on constraint response_delay_shape on public.request_responses is
  'Delay responses must carry a duration. Urgency restriction is enforced by trigger trg_response_urgency_guard.';

create index idx_responses_request on public.request_responses (request_id, created_at desc);
create unique index idx_responses_one_current on public.request_responses (request_id) where is_current;

-- Database-level guard: no delay response to an urgent request, ever.
create or replace function kindly.guard_response_urgency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_urgency public.request_urgency;
begin
  select r.urgency into v_urgency from public.requests r where r.id = new.request_id;
  if v_urgency = 'urgent' and new.kind = 'delay' then
    raise exception 'URGENT_REQUEST_CANNOT_BE_DELAYED'
      using hint = 'Urgent requests must receive an immediate action: coming now, another trusted caregiver, safe adult, or safe place.';
  end if;
  return new;
end;
$fn$;

create trigger trg_response_urgency_guard
  before insert or update on public.request_responses
  for each row execute function kindly.guard_response_urgency();

-- --------------------------------------------------------------------------
-- request_events — the audit history of every significant transition
-- --------------------------------------------------------------------------
create table public.request_events (
  id             bigint generated always as identity primary key,
  request_id     uuid not null references public.requests (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  kind           public.request_event_kind not null,
  from_status    public.request_status,
  to_status      public.request_status,
  actor_user_id  uuid references public.users (id) on delete set null,
  actor_kind     text not null default 'system' check (actor_kind in ('child','caregiver','system')),
  actor_name     text,
  -- Structured detail. Never contains the child's custom message text.
  detail         jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default kindly.now()
);
comment on table public.request_events is
  'Append-only audit history. No UPDATE or DELETE policy exists for any client role.';
comment on column public.request_events.detail is
  'Structured metadata only. Free-text the child wrote is deliberately excluded (see docs/privacy-compliance.md).';

create index idx_request_events_request on public.request_events (request_id, occurred_at);
create index idx_request_events_family  on public.request_events (family_id, occurred_at desc);

create trigger trg_requests_touch before update on public.requests
  for each row execute function kindly.touch_updated_at();
create trigger trg_request_types_touch before update on public.request_types
  for each row execute function kindly.touch_updated_at();
