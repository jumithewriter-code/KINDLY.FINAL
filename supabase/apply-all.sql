-- ===========================================================================
-- KINDLY — complete schema, for the Supabase SQL Editor
-- ===========================================================================
-- Paste this whole file in and press Run.
--
-- It runs inside ONE transaction: if any statement fails, nothing at all is
-- applied and you get an error naming the problem. A half-applied security
-- schema is the one outcome worse than not starting.
--
-- About the editor's warnings:
--   * The only "destructive" statement is `drop trigger if exists` on
--     auth.users. On a fresh project it drops nothing; it exists so this
--     script can be safely re-run.
--   * Every table this creates has Row Level Security ENABLED and FORCED,
--     and is revoked from the anon role.
--
-- Demo data is deliberately NOT included: seed.sql creates accounts whose
-- passwords are published in the README.
-- ===========================================================================

begin;


-- ==== 20260101000100_extensions_and_enums.sql =====================

-- ===========================================================================
-- KINDLY 0001 — extensions, private schema, shared enums and utilities
-- ===========================================================================
-- Everything KINDLY owns that is *not* a user-facing table lives in the
-- `kindly` schema, which is never exposed through PostgREST. Only the tables in
-- `public` (all of them RLS-protected) and a small allowlist of RPC functions
-- are reachable from a browser.
-- ===========================================================================

create extension if not exists "pgcrypto"  with schema extensions;   -- gen_random_uuid, crypt, gen_salt
create extension if not exists "citext"    with schema extensions;   -- case-insensitive email
create extension if not exists "pg_trgm"   with schema extensions;   -- name search

create schema if not exists kindly;
revoke all on schema kindly from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- Enums
-- --------------------------------------------------------------------------

-- Roles a caregiver can hold inside one family.
--   owner        - created the family; full control incl. deletion + billing
--   caregiver    - day-to-day support: answer requests, edit routines/stories
--   trusted      - escalation target; answers requests, read-only elsewhere
--   view_only    - can see status but cannot answer or edit
create type public.family_role as enum ('owner', 'caregiver', 'trusted', 'view_only');

create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired', 'declined');

-- The full request lifecycle. `reviewing` is a *local* pre-send state that is
-- persisted so a child never loses a half-made request on refresh.
create type public.request_status as enum (
  'reviewing',      -- chosen, shown back to the child, not sent
  'sending',        -- write accepted, delivery not yet confirmed
  'retrying',       -- a previous attempt failed; trying again
  'failed',         -- delivery not confirmed (offline / interrupted / error)
  'delivered',      -- backend confirmed receipt. NOT "seen".
  'waiting',        -- delivered, nobody acknowledged inside the family window
  'escalated',      -- reassigned to a trusted caregiver
  'unavailable',    -- escalation exhausted; child is shown offline help
  'acknowledged',   -- a caregiver has responded
  'resolved',       -- finished
  'cancelled'       -- child changed their mind, or caregiver cancelled
);

create type public.request_urgency as enum ('urgent', 'can_wait');

-- Responses a caregiver may give. `delay` is forbidden on urgent requests by a
-- database-level check (see 0004) so an unsafe answer cannot be written at all.
create type public.response_kind as enum (
  'seen',
  'coming_now',
  'delay',
  'other_caregiver',
  'safe_adult',
  'safe_place'
);

create type public.request_event_kind as enum (
  'created', 'status_changed', 'response_recorded', 'assigned', 'escalated',
  'cancelled', 'resolved', 'delivery_confirmed', 'delivery_failed',
  'retry_attempted', 'note'
);

create type public.routine_run_status as enum ('running', 'paused', 'finished', 'abandoned', 'plans_changed');
create type public.routine_step_state  as enum ('pending', 'done', 'skipped', 'changed');

create type public.story_status  as enum ('draft', 'in_review', 'approved', 'archived');
create type public.story_source  as enum ('manual', 'generated');
create type public.story_format  as enum ('text', 'pictogram', 'photo', 'audio', 'mixed');
create type public.story_person  as enum ('first_person', 'third_person');

create type public.notification_kind as enum (
  'request_created', 'request_delivered', 'request_acknowledged', 'request_escalated',
  'request_cancelled', 'request_resolved', 'request_unanswered',
  'invitation_received', 'invitation_accepted', 'caregiver_removed',
  'story_ready_for_review', 'story_generation_failed', 'story_assigned',
  'child_story_feedback', 'system'
);

create type public.media_kind as enum ('pictogram', 'photo', 'audio', 'other');

create type public.child_session_state as enum ('active', 'ended', 'expired', 'revoked');

-- --------------------------------------------------------------------------
-- Shared utilities
-- --------------------------------------------------------------------------

-- Trim + collapse internal whitespace, preserving every Unicode letter,
-- apostrophe, hyphen, accent, emoji and non-Latin script.
create or replace function kindly.normalize_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')), '');
$$;

comment on function kindly.normalize_name(text) is
  'Collapses whitespace and trims. Returns NULL for empty/whitespace-only input so NOT NULL columns reject it.';

create or replace function kindly.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- A stable, monotonic "now" that tests can freeze.
create or replace function kindly.now()
returns timestamptz
language sql
stable
set search_path = ''
as $$ select coalesce(nullif(current_setting('kindly.frozen_now', true), '')::timestamptz, now()); $$;


-- ==== 20260101000200_identity.sql =================================

-- ===========================================================================
-- KINDLY 0002 — identity: users, caregivers, families, children
-- ===========================================================================
-- Caregiver identity and child identity are stored in *separate tables* and are
-- never derived from one another. `caregiver_profiles.caregiver_name`,
-- `child_profiles.child_name` and `trusted_caregivers.trusted_caregiver_name`
-- are the only sources of a displayed name anywhere in the product.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- users — an application-owned mirror of auth.users
-- --------------------------------------------------------------------------
create table public.users (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             extensions.citext not null,
  email_verified_at timestamptz,
  locale            text not null default 'en' check (char_length(locale) between 2 and 12),
  time_zone         text not null default 'UTC' check (char_length(time_zone) between 1 and 64),
  last_seen_at      timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz not null default kindly.now(),
  updated_at        timestamptz not null default kindly.now()
);
comment on table public.users is 'Application mirror of auth.users. Contains no credentials.';

-- --------------------------------------------------------------------------
-- caregiver_profiles — the adult identity
-- --------------------------------------------------------------------------
create table public.caregiver_profiles (
  id                  uuid primary key default extensions.gen_random_uuid(),
  user_id             uuid not null unique references public.users (id) on delete cascade,
  -- The name a child sees when this adult answers a request. Free-form Unicode.
  caregiver_name      text not null check (caregiver_name = kindly.normalize_name(caregiver_name)
                                           and char_length(caregiver_name) between 1 and 80),
  pronouns            text check (char_length(pronouns) <= 40),
  relationship_label  text check (char_length(relationship_label) <= 60), -- "Mum", "Support worker"
  avatar_media_id     uuid,          -- FK added in 0006 once media_assets exists
  onboarding_stage    text not null default 'names'
                      check (onboarding_stage in ('names','preferences','safety','notifications','complete')),
  onboarding_data     jsonb not null default '{}'::jsonb,  -- resumable draft, server-side
  deleted_at          timestamptz,
  created_at          timestamptz not null default kindly.now(),
  updated_at          timestamptz not null default kindly.now()
);
comment on column public.caregiver_profiles.caregiver_name is
  'Caregiver identity. NEVER reused as a child name. Normalized on write.';
comment on column public.caregiver_profiles.onboarding_data is
  'Server-side resumable onboarding draft so progress survives device changes.';

-- --------------------------------------------------------------------------
-- families
-- --------------------------------------------------------------------------
create table public.families (
  id             uuid primary key default extensions.gen_random_uuid(),
  family_name    text not null check (family_name = kindly.normalize_name(family_name)
                                      and char_length(family_name) between 1 and 120),
  created_by     uuid not null references public.users (id) on delete restrict,
  -- Family-wide safety configuration. Individual children may override.
  emergency_instructions text check (char_length(emergency_instructions) <= 2000),
  emergency_services_note text not null default
    'KINDLY is not an emergency service. In an emergency call your local emergency number.',
  deleted_at     timestamptz,
  created_at     timestamptz not null default kindly.now(),
  updated_at     timestamptz not null default kindly.now()
);

-- --------------------------------------------------------------------------
-- family_members — which adult may do what inside which family
-- --------------------------------------------------------------------------
create table public.family_members (
  id                    uuid primary key default extensions.gen_random_uuid(),
  family_id             uuid not null references public.families (id) on delete cascade,
  user_id               uuid not null references public.users (id) on delete cascade,
  role                  public.family_role not null default 'caregiver',
  -- Granular permissions, defaulted from the role by kindly.default_permissions().
  can_answer_requests   boolean not null default true,
  can_edit_routines     boolean not null default true,
  can_edit_stories      boolean not null default true,
  can_approve_stories   boolean not null default true,
  can_manage_children   boolean not null default false,
  can_manage_caregivers boolean not null default false,
  can_manage_safety     boolean not null default false,
  can_export_data       boolean not null default false,
  invited_by            uuid references public.users (id) on delete set null,
  joined_at             timestamptz not null default kindly.now(),
  revoked_at            timestamptz,
  revoked_by            uuid references public.users (id) on delete set null,
  created_at            timestamptz not null default kindly.now(),
  updated_at            timestamptz not null default kindly.now(),
  unique (family_id, user_id)
);
comment on table public.family_members is
  'One row per adult per family. revoked_at IS NOT NULL removes all access immediately.';

-- --------------------------------------------------------------------------
-- child_profiles — the child identity, deliberately separate from caregivers
-- --------------------------------------------------------------------------
create table public.child_profiles (
  id              uuid primary key default extensions.gen_random_uuid(),
  family_id       uuid not null references public.families (id) on delete cascade,
  child_name      text not null check (child_name = kindly.normalize_name(child_name)
                                       and char_length(child_name) between 1 and 80),
  pronouns        text check (char_length(pronouns) <= 40),
  birth_year      int check (birth_year between 1900 and 2200),
  avatar_media_id uuid,           -- FK added in 0006
  -- Safety configuration the child-facing offline help reads from.
  safe_adult      text check (char_length(safe_adult) <= 120),
  safe_place      text check (char_length(safe_place) <= 120),
  emergency_instructions text check (char_length(emergency_instructions) <= 2000),
  archived_at     timestamptz,
  deleted_at      timestamptz,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default kindly.now(),
  updated_at      timestamptz not null default kindly.now()
);
comment on column public.child_profiles.child_name is
  'Child identity. Never defaulted from a caregiver name, never a placeholder.';

-- --------------------------------------------------------------------------
-- trusted_caregivers — per-child escalation targets
-- --------------------------------------------------------------------------
-- A trusted caregiver may be an existing KINDLY user (user_id set) or simply a
-- named person the child knows (user_id null, e.g. a grandparent or teacher).
create table public.trusted_caregivers (
  id                      uuid primary key default extensions.gen_random_uuid(),
  family_id               uuid not null references public.families (id) on delete cascade,
  child_id                uuid not null references public.child_profiles (id) on delete cascade,
  user_id                 uuid references public.users (id) on delete set null,
  trusted_caregiver_name  text not null check (trusted_caregiver_name = kindly.normalize_name(trusted_caregiver_name)
                                               and char_length(trusted_caregiver_name) between 1 and 80),
  relationship_label      text check (char_length(relationship_label) <= 60),
  contact_note            text check (char_length(contact_note) <= 200),
  escalation_order        int not null default 1 check (escalation_order between 1 and 20),
  is_active               boolean not null default true,
  created_by              uuid references public.users (id) on delete set null,
  deleted_at              timestamptz,
  created_at              timestamptz not null default kindly.now(),
  updated_at              timestamptz not null default kindly.now()
);
comment on column public.trusted_caregivers.trusted_caregiver_name is
  'Third distinct name field. Never conflated with caregiver_name or child_name.';

-- --------------------------------------------------------------------------
-- caregiver_invitations
-- --------------------------------------------------------------------------
create table public.caregiver_invitations (
  id             uuid primary key default extensions.gen_random_uuid(),
  family_id      uuid not null references public.families (id) on delete cascade,
  invited_email  extensions.citext not null,
  invited_name   text check (invited_name = kindly.normalize_name(invited_name)),
  role           public.family_role not null default 'caregiver',
  -- Only a hash of the invitation token is stored; the raw token is emailed once.
  token_hash     text not null unique,
  status         public.invitation_status not null default 'pending',
  message        text check (char_length(message) <= 500),
  invited_by     uuid not null references public.users (id) on delete cascade,
  accepted_by    uuid references public.users (id) on delete set null,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  expires_at     timestamptz not null default (kindly.now() + interval '14 days'),
  created_at     timestamptz not null default kindly.now(),
  updated_at     timestamptz not null default kindly.now()
);
comment on column public.caregiver_invitations.token_hash is
  'sha256 of the invite token. The raw token never touches the database.';

-- --------------------------------------------------------------------------
-- caregiver_pins — adult verification when leaving child mode
-- --------------------------------------------------------------------------
-- Kept in its own table so that no SELECT on caregiver_profiles can ever leak a
-- PIN hash, and so the table can be locked down to *zero* client SELECT policies.
create table public.caregiver_pins (
  family_id       uuid primary key references public.families (id) on delete cascade,
  pin_hash        text not null,                  -- bcrypt via extensions.crypt()
  pin_length      int  not null default 4 check (pin_length between 4 and 8),
  verification_mode text not null default 'pin'
                    check (verification_mode in ('pin', 'device_biometric', 'none')),
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  set_by          uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default kindly.now(),
  updated_at      timestamptz not null default kindly.now()
);
comment on table public.caregiver_pins is
  'PIN hashes only. No SELECT policy exists for any client role - verification happens inside a SECURITY DEFINER function.';

-- --------------------------------------------------------------------------
-- child_sessions — a scoped, revocable child-mode session
-- --------------------------------------------------------------------------
create table public.child_sessions (
  id               uuid primary key default extensions.gen_random_uuid(),
  family_id        uuid not null references public.families (id) on delete cascade,
  child_id         uuid not null references public.child_profiles (id) on delete cascade,
  token_hash       text not null unique,          -- sha256 of the session token
  state            public.child_session_state not null default 'active',
  started_by       uuid not null references public.users (id) on delete cascade,
  device_label     text check (char_length(device_label) <= 120),
  -- The complete set of actions this session is permitted to perform. Enforced
  -- server-side by kindly.assert_child_session(); the client cannot widen it.
  allowed_actions  text[] not null default array[
                     'create_request','send_request','cancel_request','resolve_request',
                     'read_own_requests','read_own_routines','run_routine',
                     'read_assigned_stories','send_story_feedback','read_own_preferences'
                   ],
  started_at       timestamptz not null default kindly.now(),
  last_seen_at     timestamptz not null default kindly.now(),
  expires_at       timestamptz not null default (kindly.now() + interval '12 hours'),
  ended_at         timestamptz,
  created_at       timestamptz not null default kindly.now(),
  updated_at       timestamptz not null default kindly.now()
);
comment on table public.child_sessions is
  'Child mode runs under a scoped session token, never under a caregiver identity.';

-- --------------------------------------------------------------------------
-- updated_at triggers
-- --------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array[
    'users','caregiver_profiles','families','family_members','child_profiles',
    'trusted_caregivers','caregiver_invitations','caregiver_pins','child_sessions'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function kindly.touch_updated_at()',
      'trg_' || t || '_touch', t);
  end loop;
end $do$;

-- --------------------------------------------------------------------------
-- Indexes
-- --------------------------------------------------------------------------
create index idx_caregiver_profiles_user      on public.caregiver_profiles (user_id) where deleted_at is null;
create index idx_family_members_user_active   on public.family_members (user_id) where revoked_at is null;
create index idx_family_members_family_active on public.family_members (family_id) where revoked_at is null;
create index idx_child_profiles_family        on public.child_profiles (family_id) where deleted_at is null and archived_at is null;
create unique index idx_trusted_child_order   on public.trusted_caregivers (child_id, escalation_order) where deleted_at is null;
create index idx_trusted_child_active         on public.trusted_caregivers (child_id, escalation_order) where deleted_at is null and is_active;
create index idx_invitations_family_status    on public.caregiver_invitations (family_id, status);
create index idx_invitations_email_pending    on public.caregiver_invitations (invited_email) where status = 'pending';
create index idx_child_sessions_child_active  on public.child_sessions (child_id) where state = 'active';
create index idx_child_sessions_expiry        on public.child_sessions (expires_at) where state = 'active';


-- ==== 20260101000300_preferences.sql ==============================

-- ===========================================================================
-- KINDLY 0003 — preferences: how *this* child communicates and experiences
-- ===========================================================================
-- Preferences are per child, never global "autism settings". Nothing here is a
-- diagnosis, a score, or a target to improve. Defaults are conservative: no
-- sound, no vibration, no countdown, reduced motion honoured.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- child_preferences — display, motion, safety and escalation defaults
-- --------------------------------------------------------------------------
create table public.child_preferences (
  child_id                uuid primary key references public.child_profiles (id) on delete cascade,
  family_id               uuid not null references public.families (id) on delete cascade,

  -- Display and text
  text_scale              numeric(3,2) not null default 1.00 check (text_scale between 0.90 and 2.00),
  high_contrast           boolean not null default false,
  low_stimulation         boolean not null default false,
  symbol_system           text not null default 'kindly_default'
                          check (symbol_system in ('kindly_default','photos','custom','pcs_like','arasaac_like','text_only')),
  pair_text_with_symbols  boolean not null default true,

  -- Sound, vibration, motion, countdowns. Off by default; nothing surprises.
  sound_enabled           boolean not null default false,
  vibration_enabled       boolean not null default false,
  animation_enabled       boolean not null default false,
  countdowns_visible      boolean not null default false,
  read_aloud_enabled      boolean not null default false,
  read_aloud_rate         numeric(3,2) not null default 1.00 check (read_aloud_rate between 0.50 and 2.00),

  -- Processing time before any transition warning auto-advances (never forced).
  processing_time_seconds int not null default 10 check (processing_time_seconds between 0 and 600),
  transition_warnings     boolean not null default true,

  -- Requests
  escalation_delay_seconds     int not null default 120 check (escalation_delay_seconds between 15 and 1800),
  unavailable_delay_seconds    int not null default 120 check (unavailable_delay_seconds between 15 and 1800),
  bathroom_urgency        public.request_urgency not null default 'urgent',
  allow_custom_message    boolean not null default true,

  -- Notifications
  quiet_hours_start       time,
  quiet_hours_end         time,
  quiet_hours_allow_urgent boolean not null default true,

  updated_by              uuid references public.users (id) on delete set null,
  created_at              timestamptz not null default kindly.now(),
  updated_at              timestamptz not null default kindly.now()
);

comment on column public.child_preferences.bathroom_urgency is
  'Configurable per child. KINDLY does not assume a bathroom request can safely wait; the family (with their own clinicians) decides. Default is urgent.';
comment on column public.child_preferences.countdowns_visible is
  'Off by default. A visible countdown can be distressing; a delayed response falls back to a non-numeric progress bar when this is off.';

-- --------------------------------------------------------------------------
-- communication_methods — how this child prefers to communicate
-- --------------------------------------------------------------------------
create table public.communication_methods (
  id           uuid primary key default extensions.gen_random_uuid(),
  child_id     uuid not null references public.child_profiles (id) on delete cascade,
  family_id    uuid not null references public.families (id) on delete cascade,
  method       text not null check (method in (
                 'spoken_words','written_words','pictograms','photos','gestures',
                 'sign_language','aac_device','typing','yes_no_choices','other')),
  label        text not null check (label = kindly.normalize_name(label) and char_length(label) between 1 and 80),
  detail       text check (char_length(detail) <= 300),
  is_primary   boolean not null default false,
  sort_order   int not null default 0,
  deleted_at   timestamptz,
  created_at   timestamptz not null default kindly.now(),
  updated_at   timestamptz not null default kindly.now()
);
comment on table public.communication_methods is
  'KINDLY supports communication; it never requires speech or reading.';

-- --------------------------------------------------------------------------
-- sensory_preferences — what helps, what is hard, described not judged
-- --------------------------------------------------------------------------
create table public.sensory_preferences (
  id           uuid primary key default extensions.gen_random_uuid(),
  child_id     uuid not null references public.child_profiles (id) on delete cascade,
  family_id    uuid not null references public.families (id) on delete cascade,
  category     text not null check (category in ('sound','light','touch','movement','smell','taste','crowding','temperature','other')),
  -- 'helps' = a regulation support. 'hard' = something often difficult.
  kind         text not null check (kind in ('helps','hard')),
  label        text not null check (label = kindly.normalize_name(label) and char_length(label) between 1 and 120),
  detail       text check (char_length(detail) <= 300),
  sort_order   int not null default 0,
  deleted_at   timestamptz,
  created_at   timestamptz not null default kindly.now(),
  updated_at   timestamptz not null default kindly.now()
);

-- --------------------------------------------------------------------------
-- escalation_rules — per child, ordered, family-configured
-- --------------------------------------------------------------------------
create table public.escalation_rules (
  id                    uuid primary key default extensions.gen_random_uuid(),
  child_id              uuid not null references public.child_profiles (id) on delete cascade,
  family_id             uuid not null references public.families (id) on delete cascade,
  applies_to_urgency    public.request_urgency,     -- null = both
  step_order            int not null check (step_order between 1 and 20),
  -- What happens at this step.
  action                text not null check (action in ('notify_assigned','notify_trusted','notify_all_caregivers','show_offline_help')),
  trusted_caregiver_id  uuid references public.trusted_caregivers (id) on delete cascade,
  after_seconds         int not null check (after_seconds between 10 and 3600),
  is_active             boolean not null default true,
  created_at            timestamptz not null default kindly.now(),
  updated_at            timestamptz not null default kindly.now()
);
comment on table public.escalation_rules is
  'Ordered escalation ladder. The final step is always show_offline_help so a child is never left waiting indefinitely.';

-- --------------------------------------------------------------------------
-- notification_preferences — per caregiver per family
-- --------------------------------------------------------------------------
create table public.notification_preferences (
  id                      uuid primary key default extensions.gen_random_uuid(),
  user_id                 uuid not null references public.users (id) on delete cascade,
  family_id               uuid not null references public.families (id) on delete cascade,
  in_app_enabled          boolean not null default true,
  push_enabled            boolean not null default false,
  push_permission_state   text not null default 'default'
                          check (push_permission_state in ('default','granted','denied','unsupported')),
  push_subscription       jsonb,
  email_digest_enabled    boolean not null default false,
  quiet_hours_start       time,
  quiet_hours_end         time,
  -- Urgent requests always break quiet hours; this cannot be disabled.
  quiet_hours_allow_urgent boolean not null default true,
  created_at              timestamptz not null default kindly.now(),
  updated_at              timestamptz not null default kindly.now(),
  unique (user_id, family_id)
);
comment on column public.notification_preferences.quiet_hours_allow_urgent is
  'Always true in the UI. Urgent requests must never be silenced by a preference.';

-- --------------------------------------------------------------------------
-- Triggers and indexes
-- --------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array[
    'child_preferences','communication_methods','sensory_preferences',
    'escalation_rules','notification_preferences'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function kindly.touch_updated_at()',
      'trg_' || t || '_touch', t);
  end loop;
end $do$;

create index idx_comm_methods_child   on public.communication_methods (child_id, sort_order) where deleted_at is null;
create index idx_sensory_child        on public.sensory_preferences (child_id, kind, sort_order) where deleted_at is null;
-- One rule per child, per urgency scope, per step. Expressed as two partial
-- indexes rather than coalesce(applies_to_urgency::text, 'both'): casting an
-- enum to text calls enum_out, which is STABLE rather than IMMUTABLE, and
-- Postgres rejects it in an index expression.
create unique index idx_escalation_child_order
  on public.escalation_rules (child_id, applies_to_urgency, step_order)
  where applies_to_urgency is not null;

-- A NULL urgency means "applies to both", and UNIQUE treats NULLs as distinct,
-- so that case needs its own index to be constrained at all.
create unique index idx_escalation_child_order_both
  on public.escalation_rules (child_id, step_order)
  where applies_to_urgency is null;
create index idx_escalation_child     on public.escalation_rules (child_id, step_order) where is_active;
create index idx_notif_prefs_user     on public.notification_preferences (user_id, family_id);


-- ==== 20260101000400_requests.sql =================================

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


-- ==== 20260101000500_routines.sql =================================

-- ===========================================================================
-- KINDLY 0005 — routines
-- ===========================================================================
-- A routine is a shared plan, not a compliance checklist. There is no score, no
-- streak and no penalty: a skipped step is recorded neutrally, and "plans
-- changed" is a first-class outcome rather than a failure.
-- ===========================================================================

create table public.routines (
  id                 uuid primary key default extensions.gen_random_uuid(),
  family_id          uuid not null references public.families (id) on delete cascade,
  child_id           uuid not null references public.child_profiles (id) on delete cascade,
  title              text not null check (title = kindly.normalize_name(title)
                                          and char_length(title) between 1 and 100),
  description        text check (char_length(description) <= 500),
  icon_key           text check (char_length(icon_key) <= 60),
  color_key          text not null default 'yellow' check (color_key in ('coral','blue','purple','yellow','mint','peach')),
  -- Free-text schedule label shown to caregivers ("Every weekday, 7:30 AM").
  schedule_label     text check (char_length(schedule_label) <= 120),
  schedule_days      int[] check (schedule_days <@ array[0,1,2,3,4,5,6]),
  schedule_time      time,
  -- Neurodiversity-affirming behaviour switches, per routine.
  allow_reorder      boolean not null default true,
  allow_skip         boolean not null default true,
  transition_warning_seconds int not null default 60 check (transition_warning_seconds between 0 and 900),
  sort_order         int not null default 0,
  archived_at        timestamptz,
  deleted_at         timestamptz,
  created_by         uuid references public.users (id) on delete set null,
  created_at         timestamptz not null default kindly.now(),
  updated_at         timestamptz not null default kindly.now()
);

create table public.routine_steps (
  id                 uuid primary key default extensions.gen_random_uuid(),
  routine_id         uuid not null references public.routines (id) on delete cascade,
  family_id          uuid not null references public.families (id) on delete cascade,
  position           int not null check (position >= 0),
  title              text not null check (char_length(btrim(title)) between 1 and 100),
  detail             text check (char_length(detail) <= 300),
  pictogram_key      text check (char_length(pictogram_key) <= 60),
  pictogram_media_id uuid,                      -- FK added in 0006
  photo_media_id     uuid,                      -- FK added in 0006
  audio_media_id     uuid,                      -- FK added in 0006
  estimated_seconds  int check (estimated_seconds between 0 and 7200),
  is_optional        boolean not null default false,
  -- What to offer if the day does not go to plan.
  plans_changed_note text check (char_length(plans_changed_note) <= 300),
  deleted_at         timestamptz,
  created_at         timestamptz not null default kindly.now(),
  updated_at         timestamptz not null default kindly.now()
);

create unique index idx_routine_steps_position
  on public.routine_steps (routine_id, position) where deleted_at is null;

create table public.routine_runs (
  id               uuid primary key default extensions.gen_random_uuid(),
  routine_id       uuid not null references public.routines (id) on delete cascade,
  family_id        uuid not null references public.families (id) on delete cascade,
  child_id         uuid not null references public.child_profiles (id) on delete cascade,
  child_session_id uuid references public.child_sessions (id) on delete set null,
  status           public.routine_run_status not null default 'running',
  current_step_id  uuid references public.routine_steps (id) on delete set null,
  -- Per-step outcomes: [{ step_id, state, at }]. Skipped is neutral.
  step_states      jsonb not null default '[]'::jsonb,
  started_at       timestamptz not null default kindly.now(),
  paused_at        timestamptz,
  finished_at      timestamptz,
  plans_changed_at timestamptz,
  started_by_kind  text not null default 'child' check (started_by_kind in ('child','caregiver')),
  started_by_user  uuid references public.users (id) on delete set null,
  created_at       timestamptz not null default kindly.now(),
  updated_at       timestamptz not null default kindly.now()
);
comment on column public.routine_runs.step_states is
  'Neutral record of what happened. Never aggregated into a score or a streak.';

create index idx_routines_child      on public.routines (child_id, sort_order) where deleted_at is null and archived_at is null;
create index idx_routines_family     on public.routines (family_id) where deleted_at is null;
create index idx_routine_steps_route on public.routine_steps (routine_id, position) where deleted_at is null;
create index idx_routine_runs_child  on public.routine_runs (child_id, started_at desc);
create unique index idx_routine_runs_one_active
  on public.routine_runs (routine_id) where status in ('running','paused');

do $do$
declare t text;
begin
  foreach t in array array['routines','routine_steps','routine_runs'] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function kindly.touch_updated_at()',
      'trg_' || t || '_touch', t);
  end loop;
end $do$;


-- ==== 20260101000600_stories_media.sql ============================

-- ===========================================================================
-- KINDLY 0006 — media assets, social-scenario stories, versions, feedback
-- ===========================================================================
-- No generated content reaches child mode without a caregiver approving it:
-- `stories.status` must be 'approved' AND a story_assignments row must exist.
-- Both facts are enforced by RLS and by kindly.approve_story() / assign_story().
-- ===========================================================================

-- --------------------------------------------------------------------------
-- media_assets — custom pictograms, family-approved photos, audio
-- --------------------------------------------------------------------------
create table public.media_assets (
  id             uuid primary key default extensions.gen_random_uuid(),
  family_id      uuid not null references public.families (id) on delete cascade,
  child_id       uuid references public.child_profiles (id) on delete set null,
  kind           public.media_kind not null,
  -- Path inside the private `kindly-media` storage bucket. Always served
  -- through a short-lived signed URL; the bucket itself is not public.
  storage_path   text not null unique check (char_length(storage_path) between 3 and 400),
  mime_type      text not null check (mime_type in (
                   'image/png','image/jpeg','image/webp','image/svg+xml',
                   'audio/mpeg','audio/ogg','audio/wav','audio/mp4')),
  byte_size      bigint not null check (byte_size > 0 and byte_size <= 20971520), -- 20 MB
  width          int check (width > 0),
  height         int check (height > 0),
  duration_ms    int check (duration_ms > 0),
  -- Required. A pictogram or photo with no text alternative is not usable.
  alt_text       text not null check (char_length(btrim(alt_text)) between 1 and 300),
  caption        text check (char_length(caption) <= 300),
  approved_by    uuid references public.users (id) on delete set null,
  approved_at    timestamptz,
  uploaded_by    uuid not null references public.users (id) on delete cascade,
  deleted_at     timestamptz,
  created_at     timestamptz not null default kindly.now(),
  updated_at     timestamptz not null default kindly.now()
);
comment on column public.media_assets.alt_text is
  'Mandatory. Meaning is never carried by an image alone.';

create index idx_media_family on public.media_assets (family_id, kind) where deleted_at is null;
create index idx_media_child  on public.media_assets (child_id, kind) where deleted_at is null;

-- Deferred foreign keys from earlier migrations.
alter table public.caregiver_profiles
  add constraint caregiver_profiles_avatar_fk foreign key (avatar_media_id) references public.media_assets (id) on delete set null;
alter table public.child_profiles
  add constraint child_profiles_avatar_fk foreign key (avatar_media_id) references public.media_assets (id) on delete set null;
alter table public.request_types
  add constraint request_types_pictogram_fk foreign key (pictogram_media_id) references public.media_assets (id) on delete set null;
alter table public.requests
  add constraint requests_pictogram_fk foreign key (pictogram_media_id) references public.media_assets (id) on delete set null;
alter table public.routine_steps
  add constraint routine_steps_pictogram_fk foreign key (pictogram_media_id) references public.media_assets (id) on delete set null,
  add constraint routine_steps_photo_fk     foreign key (photo_media_id)     references public.media_assets (id) on delete set null,
  add constraint routine_steps_audio_fk     foreign key (audio_media_id)     references public.media_assets (id) on delete set null;

-- --------------------------------------------------------------------------
-- stories — social narratives, always caregiver-owned drafts first
-- --------------------------------------------------------------------------
create table public.stories (
  id                 uuid primary key default extensions.gen_random_uuid(),
  family_id          uuid not null references public.families (id) on delete cascade,
  child_id           uuid not null references public.child_profiles (id) on delete cascade,
  title              text not null check (char_length(btrim(title)) between 1 and 120),
  scenario_key       text not null check (char_length(scenario_key) between 1 and 60),
  status             public.story_status not null default 'draft',
  source             public.story_source not null default 'manual',
  format             public.story_format not null default 'text',
  person             public.story_person not null default 'first_person',
  reading_level      text not null default 'simple'
                     check (reading_level in ('pre_reader','simple','developing','confident')),
  target_page_count  int not null default 8 check (target_page_count between 3 and 20),

  -- The caregiver's inputs, kept so a story can be regenerated or explained.
  inputs             jsonb not null default '{}'::jsonb,

  -- Generation provenance. Required for every generated story.
  generation_model         text,
  generation_prompt_version text,
  generated_at             timestamptz,
  generation_error         text,

  -- Automated language review results: [{ page_index, span, rule, severity, note }]
  review_flags       jsonb not null default '[]'::jsonb,
  -- Set when the scenario itself needs a careful adult read (abuse, danger,
  -- medical care, self-harm, violence, emergencies).
  requires_safety_review boolean not null default false,

  approved_by        uuid references public.users (id) on delete set null,
  approved_at        timestamptz,
  archived_at        timestamptz,
  deleted_at         timestamptz,
  created_by         uuid references public.users (id) on delete set null,
  version            int not null default 1 check (version >= 1),
  created_at         timestamptz not null default kindly.now(),
  updated_at         timestamptz not null default kindly.now(),

  constraint stories_generated_needs_provenance check (
    source <> 'generated' or status = 'draft'
    or (generation_model is not null and generation_prompt_version is not null and generated_at is not null)),
  constraint stories_approved_needs_approver check (
    status <> 'approved' or (approved_by is not null and approved_at is not null))
);
comment on constraint stories_approved_needs_approver on public.stories is
  'A story cannot be approved without recording which caregiver approved it and when.';

create table public.story_pages (
  id             uuid primary key default extensions.gen_random_uuid(),
  story_id       uuid not null references public.stories (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  position       int not null check (position >= 0),
  -- One of the twelve structural sections (see docs/architecture.md).
  section_key    text not null check (section_key in (
                   'title','situation','where_when','who','what_you_may_notice',
                   'what_may_change','feelings','choices','sensory_options',
                   'asking_for_help','afterwards','ending','custom')),
  heading        text check (char_length(heading) <= 120),
  body           text not null check (char_length(btrim(body)) between 1 and 1200),
  -- Distinguishes fact from possibility so the child is never promised an outcome.
  certainty      text not null default 'fact' check (certainty in ('fact','possibility','choice')),
  pictogram_key  text check (char_length(pictogram_key) <= 60),
  image_media_id uuid references public.media_assets (id) on delete set null,
  audio_media_id uuid references public.media_assets (id) on delete set null,
  alt_text       text check (char_length(alt_text) <= 300),
  review_flags   jsonb not null default '[]'::jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default kindly.now(),
  updated_at     timestamptz not null default kindly.now()
);

create unique index idx_story_pages_position on public.story_pages (story_id, position) where deleted_at is null;

-- Immutable snapshots so caregivers can see what changed and who approved what.
create table public.story_versions (
  id            uuid primary key default extensions.gen_random_uuid(),
  story_id      uuid not null references public.stories (id) on delete cascade,
  family_id     uuid not null references public.families (id) on delete cascade,
  version       int not null check (version >= 1),
  snapshot      jsonb not null,
  change_note   text check (char_length(change_note) <= 300),
  created_by    uuid references public.users (id) on delete set null,
  created_by_name text,
  created_at    timestamptz not null default kindly.now(),
  unique (story_id, version)
);

-- Which approved stories a specific child can actually open.
create table public.story_assignments (
  id             uuid primary key default extensions.gen_random_uuid(),
  story_id       uuid not null references public.stories (id) on delete cascade,
  child_id       uuid not null references public.child_profiles (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  assigned_by    uuid references public.users (id) on delete set null,
  assigned_at    timestamptz not null default kindly.now(),
  withdrawn_at   timestamptz,
  withdrawn_by   uuid references public.users (id) on delete set null,
  unique (story_id, child_id)
);

-- Where the child got to. Position only — never a completion score.
create table public.story_progress (
  id             uuid primary key default extensions.gen_random_uuid(),
  story_id       uuid not null references public.stories (id) on delete cascade,
  child_id       uuid not null references public.child_profiles (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  last_page      int not null default 0 check (last_page >= 0),
  last_opened_at timestamptz not null default kindly.now(),
  unique (story_id, child_id)
);
comment on table public.story_progress is
  'Remembers where the child was. Deliberately stores no completion or comprehension measure.';

-- The child's own responses to a story, sent only with explicit confirmation.
create table public.story_feedback (
  id             uuid primary key default extensions.gen_random_uuid(),
  story_id       uuid not null references public.stories (id) on delete cascade,
  child_id       uuid not null references public.child_profiles (id) on delete cascade,
  family_id      uuid not null references public.families (id) on delete cascade,
  child_session_id uuid references public.child_sessions (id) on delete set null,
  page_position  int check (page_position >= 0),
  kind           text not null check (kind in ('this_is_different','i_have_a_question','i_need_a_break','i_do_not_want_this_story')),
  note           text check (char_length(note) <= 300),
  created_at     timestamptz not null default kindly.now(),
  seen_at        timestamptz,
  seen_by        uuid references public.users (id) on delete set null
);

create index idx_stories_child_status on public.stories (child_id, status, updated_at desc) where deleted_at is null;
create index idx_stories_family       on public.stories (family_id, status) where deleted_at is null;
create index idx_story_pages_story    on public.story_pages (story_id, position) where deleted_at is null;
create index idx_story_assign_child   on public.story_assignments (child_id) where withdrawn_at is null;
create index idx_story_feedback_family on public.story_feedback (family_id, created_at desc) where seen_at is null;

do $do$
declare t text;
begin
  foreach t in array array['media_assets','stories','story_pages'] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function kindly.touch_updated_at()',
      'trg_' || t || '_touch', t);
  end loop;
end $do$;


-- ==== 20260101000700_notifications_audit.sql ======================

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


-- ==== 20260101000800_rls.sql ======================================

-- ===========================================================================
-- KINDLY 0008 — Row Level Security on every table holding user data
-- ===========================================================================
-- Model:
--   * Every private table has RLS enabled and FORCEd (so even the table owner
--     is subject to it outside of SECURITY DEFINER functions).
--   * Access is derived from an *active* row in family_members. Revoking a
--     caregiver sets revoked_at, which removes access on the next statement.
--   * Helper predicates are SECURITY DEFINER + STABLE so that policies on
--     family_members itself do not recurse.
--   * caregiver_pins, rate_limits and child_sessions.token_hash are reachable
--     by no client policy at all.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Predicates
-- --------------------------------------------------------------------------
create or replace function kindly.uid()
returns uuid language sql stable set search_path = '' as
$$ select auth.uid(); $$;

create or replace function kindly.is_member(p_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.family_members fm
      join public.families f on f.id = fm.family_id
     where fm.family_id = p_family
       and fm.user_id = auth.uid()
       and fm.revoked_at is null
       and f.deleted_at is null
  );
$$;

create or replace function kindly.member_role(p_family uuid)
returns public.family_role
language sql
stable
security definer
set search_path = ''
as $$
  select fm.role
    from public.family_members fm
   where fm.family_id = p_family
     and fm.user_id = auth.uid()
     and fm.revoked_at is null
   limit 1;
$$;

-- Granular permission check. `p_permission` is a column name on family_members.
create or replace function kindly.has_permission(p_family uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare v_result boolean;
begin
  if p_permission not in (
    'can_answer_requests','can_edit_routines','can_edit_stories','can_approve_stories',
    'can_manage_children','can_manage_caregivers','can_manage_safety','can_export_data'
  ) then
    raise exception 'UNKNOWN_PERMISSION: %', p_permission;
  end if;

  execute format(
    'select coalesce(bool_or(%I), false) from public.family_members
      where family_id = $1 and user_id = auth.uid() and revoked_at is null', p_permission)
    into v_result using p_family;

  return coalesce(v_result, false);
end;
$fn$;

create or replace function kindly.family_of_child(p_child uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select c.family_id from public.child_profiles c where c.id = p_child; $$;

create or replace function kindly.can_access_child(p_child uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select kindly.is_member(kindly.family_of_child(p_child)); $$;

grant execute on function kindly.is_member(uuid), kindly.member_role(uuid),
                          kindly.has_permission(uuid, text), kindly.can_access_child(uuid),
                          kindly.family_of_child(uuid), kindly.uid()
  to authenticated;

-- --------------------------------------------------------------------------
-- Enable + force RLS everywhere
-- --------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array[
    'users','caregiver_profiles','families','family_members','child_profiles',
    'trusted_caregivers','caregiver_invitations','caregiver_pins','child_sessions',
    'child_preferences','communication_methods','sensory_preferences','escalation_rules',
    'notification_preferences','request_types','requests','request_responses','request_events',
    'routines','routine_steps','routine_runs','media_assets','stories','story_pages',
    'story_versions','story_assignments','story_progress','story_feedback',
    'notifications','audit_events','rate_limits','data_export_jobs','deletion_requests'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    -- Nothing is reachable by anonymous visitors.
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $do$;

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
create policy users_select_self on public.users
  for select to authenticated using (id = auth.uid());

-- Adults in the same family can see each other's row (needed to render "who is
-- helping"), but only the non-sensitive columns exposed by the v_family_people view.
create policy users_update_self on public.users
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy users_insert_self on public.users
  for insert to authenticated with check (id = auth.uid());

-- --------------------------------------------------------------------------
-- caregiver_profiles
-- --------------------------------------------------------------------------
create policy caregiver_profiles_select on public.caregiver_profiles
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.family_members mine
      join public.family_members theirs on theirs.family_id = mine.family_id
      where mine.user_id = auth.uid() and mine.revoked_at is null
        and theirs.user_id = public.caregiver_profiles.user_id and theirs.revoked_at is null
    )
  );

create policy caregiver_profiles_insert_self on public.caregiver_profiles
  for insert to authenticated with check (user_id = auth.uid());

create policy caregiver_profiles_update_self on public.caregiver_profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- families
-- --------------------------------------------------------------------------
create policy families_select on public.families
  for select to authenticated using (kindly.is_member(id) and deleted_at is null);

create policy families_insert on public.families
  for insert to authenticated with check (created_by = auth.uid());

create policy families_update on public.families
  for update to authenticated
  using (kindly.has_permission(id, 'can_manage_safety'))
  with check (kindly.has_permission(id, 'can_manage_safety'));

-- --------------------------------------------------------------------------
-- family_members
-- --------------------------------------------------------------------------
create policy family_members_select on public.family_members
  for select to authenticated using (kindly.is_member(family_id) or user_id = auth.uid());

-- Bootstrapping the first membership (the owner) is allowed; every subsequent
-- membership is created by kindly.accept_invitation() with elevated rights.
create policy family_members_insert_owner on public.family_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.families f where f.id = family_id and f.created_by = auth.uid())
  );

create policy family_members_update_manager on public.family_members
  for update to authenticated
  using (kindly.has_permission(family_id, 'can_manage_caregivers'))
  with check (kindly.has_permission(family_id, 'can_manage_caregivers'));

-- --------------------------------------------------------------------------
-- child_profiles
-- --------------------------------------------------------------------------
create policy child_profiles_select on public.child_profiles
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);

create policy child_profiles_insert on public.child_profiles
  for insert to authenticated with check (kindly.has_permission(family_id, 'can_manage_children'));

create policy child_profiles_update on public.child_profiles
  for update to authenticated
  using (kindly.has_permission(family_id, 'can_manage_children'))
  with check (kindly.has_permission(family_id, 'can_manage_children'));

-- --------------------------------------------------------------------------
-- trusted_caregivers
-- --------------------------------------------------------------------------
create policy trusted_select on public.trusted_caregivers
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy trusted_write on public.trusted_caregivers
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_manage_caregivers'))
  with check (kindly.has_permission(family_id, 'can_manage_caregivers'));

-- --------------------------------------------------------------------------
-- caregiver_invitations — the invitee is matched by verified email
-- --------------------------------------------------------------------------
create policy invitations_select on public.caregiver_invitations
  for select to authenticated
  using (
    kindly.is_member(family_id)
    or invited_email = (select u.email from public.users u where u.id = auth.uid())
  );

create policy invitations_insert on public.caregiver_invitations
  for insert to authenticated
  with check (kindly.has_permission(family_id, 'can_manage_caregivers') and invited_by = auth.uid());

create policy invitations_update on public.caregiver_invitations
  for update to authenticated
  using (kindly.has_permission(family_id, 'can_manage_caregivers'))
  with check (kindly.has_permission(family_id, 'can_manage_caregivers'));

-- --------------------------------------------------------------------------
-- caregiver_pins — deliberately unreachable from any client
-- --------------------------------------------------------------------------
-- No policies are created. Every operation happens inside SECURITY DEFINER
-- functions (kindly.set_caregiver_pin / kindly.verify_caregiver_pin), so a PIN
-- hash can never be selected, even by the family owner.
revoke all on public.caregiver_pins from authenticated, anon;
revoke all on public.rate_limits    from authenticated, anon;

-- --------------------------------------------------------------------------
-- child_sessions — caregivers may see and revoke, never read the token hash
-- --------------------------------------------------------------------------
create policy child_sessions_select on public.child_sessions
  for select to authenticated using (kindly.is_member(family_id));
create policy child_sessions_update on public.child_sessions
  for update to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

revoke select (token_hash) on public.child_sessions from authenticated;

-- --------------------------------------------------------------------------
-- Preferences (child-scoped)
-- --------------------------------------------------------------------------
create policy child_prefs_select on public.child_preferences
  for select to authenticated using (kindly.is_member(family_id));
create policy child_prefs_write on public.child_preferences
  for all to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

create policy comm_methods_select on public.communication_methods
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy comm_methods_write on public.communication_methods
  for all to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

create policy sensory_select on public.sensory_preferences
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy sensory_write on public.sensory_preferences
  for all to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

create policy escalation_select on public.escalation_rules
  for select to authenticated using (kindly.is_member(family_id));
create policy escalation_write on public.escalation_rules
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_manage_safety'))
  with check (kindly.has_permission(family_id, 'can_manage_safety'));

create policy notif_prefs_rw on public.notification_preferences
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and kindly.is_member(family_id));

-- --------------------------------------------------------------------------
-- request_types — KINDLY defaults are readable by everyone signed in
-- --------------------------------------------------------------------------
create policy request_types_select on public.request_types
  for select to authenticated
  using (deleted_at is null and (family_id is null or kindly.is_member(family_id)));
create policy request_types_write on public.request_types
  for all to authenticated
  using (family_id is not null and kindly.is_member(family_id))
  with check (family_id is not null and kindly.is_member(family_id) and is_builtin = false);

-- --------------------------------------------------------------------------
-- requests — readable by the family; writable only through RPCs
-- --------------------------------------------------------------------------
create policy requests_select on public.requests
  for select to authenticated using (kindly.is_member(family_id));

-- No INSERT/UPDATE/DELETE policies. Every mutation goes through a SECURITY
-- DEFINER function that validates the transition, the assignment and the
-- urgency rules. This is what makes "delivered" impossible to fake.

create policy request_responses_select on public.request_responses
  for select to authenticated using (kindly.is_member(family_id));

create policy request_events_select on public.request_events
  for select to authenticated using (kindly.is_member(family_id));
-- request_events is append-only: no insert/update/delete policy for clients.

-- --------------------------------------------------------------------------
-- routines
-- --------------------------------------------------------------------------
create policy routines_select on public.routines
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy routines_write on public.routines
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_edit_routines'))
  with check (kindly.has_permission(family_id, 'can_edit_routines'));

create policy routine_steps_select on public.routine_steps
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy routine_steps_write on public.routine_steps
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_edit_routines'))
  with check (kindly.has_permission(family_id, 'can_edit_routines'));

create policy routine_runs_select on public.routine_runs
  for select to authenticated using (kindly.is_member(family_id));
create policy routine_runs_write on public.routine_runs
  for all to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

-- --------------------------------------------------------------------------
-- media assets — rows are readable; bytes need a signed URL
-- --------------------------------------------------------------------------
create policy media_select on public.media_assets
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy media_insert on public.media_assets
  for insert to authenticated with check (kindly.is_member(family_id) and uploaded_by = auth.uid());
create policy media_update on public.media_assets
  for update to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

-- --------------------------------------------------------------------------
-- stories
-- --------------------------------------------------------------------------
create policy stories_select on public.stories
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy stories_write on public.stories
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_edit_stories'))
  with check (kindly.has_permission(family_id, 'can_edit_stories'));

create policy story_pages_select on public.story_pages
  for select to authenticated using (kindly.is_member(family_id) and deleted_at is null);
create policy story_pages_write on public.story_pages
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_edit_stories'))
  with check (kindly.has_permission(family_id, 'can_edit_stories'));

create policy story_versions_select on public.story_versions
  for select to authenticated using (kindly.is_member(family_id));
create policy story_versions_insert on public.story_versions
  for insert to authenticated with check (kindly.has_permission(family_id, 'can_edit_stories'));

create policy story_assign_select on public.story_assignments
  for select to authenticated using (kindly.is_member(family_id));
create policy story_assign_write on public.story_assignments
  for all to authenticated
  using (kindly.has_permission(family_id, 'can_approve_stories'))
  with check (kindly.has_permission(family_id, 'can_approve_stories'));

create policy story_progress_select on public.story_progress
  for select to authenticated using (kindly.is_member(family_id));
create policy story_progress_write on public.story_progress
  for all to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));

create policy story_feedback_select on public.story_feedback
  for select to authenticated using (kindly.is_member(family_id));
create policy story_feedback_update on public.story_feedback
  for update to authenticated
  using (kindly.is_member(family_id)) with check (kindly.is_member(family_id));
-- Inserts happen through kindly.child_send_story_feedback().

-- --------------------------------------------------------------------------
-- notifications — strictly per recipient
-- --------------------------------------------------------------------------
create policy notifications_select on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------------------------
-- audit_events — read-only, family scoped, append-only from the server
-- --------------------------------------------------------------------------
create policy audit_select on public.audit_events
  for select to authenticated
  using (family_id is not null and kindly.has_permission(family_id, 'can_manage_caregivers'));

-- --------------------------------------------------------------------------
-- exports and deletions
-- --------------------------------------------------------------------------
create policy exports_select on public.data_export_jobs
  for select to authenticated using (requested_by = auth.uid() and kindly.is_member(family_id));
create policy exports_insert on public.data_export_jobs
  for insert to authenticated
  with check (requested_by = auth.uid() and kindly.has_permission(family_id, 'can_export_data'));

create policy deletions_select on public.deletion_requests
  for select to authenticated using (requested_by = auth.uid() or (family_id is not null and kindly.is_member(family_id)));
create policy deletions_insert on public.deletion_requests
  for insert to authenticated with check (requested_by = auth.uid());
create policy deletions_update on public.deletion_requests
  for update to authenticated
  using (requested_by = auth.uid()) with check (requested_by = auth.uid());

-- --------------------------------------------------------------------------
-- Private storage bucket for pictograms, photos and audio
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kindly-media', 'kindly-media', false, 20971520,
  array['image/png','image/jpeg','image/webp','image/svg+xml','audio/mpeg','audio/ogg','audio/wav','audio/mp4']
)
on conflict (id) do nothing;

-- Objects live under `<family_id>/<child_id|shared>/<uuid>.<ext>`; access is
-- granted only to active members of that family, and always via signed URLs.
create policy kindly_media_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'kindly-media'
    and kindly.is_member(nullif(split_part(name, '/', 1), '')::uuid)
  );

create policy kindly_media_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'kindly-media'
    and kindly.is_member(nullif(split_part(name, '/', 1), '')::uuid)
  );

create policy kindly_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'kindly-media'
    and kindly.is_member(nullif(split_part(name, '/', 1), '')::uuid)
  );


-- ==== 20260101000900_functions_core.sql ===========================

-- ===========================================================================
-- KINDLY 0009 — core server functions: accounts, families, PINs, child sessions
-- ===========================================================================
-- Every function here is SECURITY DEFINER with a pinned empty search_path, and
-- every one of them re-checks authorization itself. RLS is the second lock, not
-- the only one.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Infrastructure: audit log + rate limiting
-- --------------------------------------------------------------------------
create or replace function kindly.log_audit(
  p_family uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_detail jsonb default '{}'::jsonb, p_actor_kind text default 'caregiver'
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, entity_type, entity_id, detail)
  values (p_family, auth.uid(), p_actor_kind, p_action, p_entity_type, p_entity_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- Fixed-window counter. Raises RATE_LIMITED when the caller is over budget.
create or replace function kindly.rate_limit(
  p_key text, p_max int, p_window interval, p_lock_for interval default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.rate_limits%rowtype;
  v_now timestamptz := kindly.now();
begin
  insert into public.rate_limits (bucket_key, window_start, hit_count)
  values (p_key, v_now, 0)
  on conflict (bucket_key) do nothing;

  select * into v_row from public.rate_limits where bucket_key = p_key for update;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    raise exception 'RATE_LIMITED' using detail = extract(epoch from (v_row.blocked_until - v_now))::text;
  end if;

  if v_row.window_start + p_window < v_now then
    update public.rate_limits
       set window_start = v_now, hit_count = 1, blocked_until = null
     where bucket_key = p_key;
    return;
  end if;

  if v_row.hit_count + 1 > p_max then
    update public.rate_limits
       set blocked_until = v_now + coalesce(p_lock_for, p_window)
     where bucket_key = p_key;
    raise exception 'RATE_LIMITED'
      using detail = extract(epoch from coalesce(p_lock_for, p_window))::text;
  end if;

  update public.rate_limits set hit_count = v_row.hit_count + 1 where bucket_key = p_key;
end;
$fn$;

-- --------------------------------------------------------------------------
-- auth.users -> public.users mirror
-- --------------------------------------------------------------------------
create or replace function kindly.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.users (id, email, email_verified_at)
  values (new.id, new.email, new.email_confirmed_at)
  on conflict (id) do update
    set email = excluded.email,
        email_verified_at = coalesce(excluded.email_verified_at, public.users.email_verified_at);
  return new;
end;
$fn$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function kindly.handle_new_auth_user();

-- --------------------------------------------------------------------------
-- Role -> default permission matrix
-- --------------------------------------------------------------------------
create or replace function kindly.default_permissions(p_role public.family_role)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'owner' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', true, 'can_edit_stories', true,
      'can_approve_stories', true, 'can_manage_children', true, 'can_manage_caregivers', true,
      'can_manage_safety', true, 'can_export_data', true)
    when 'caregiver' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', true, 'can_edit_stories', true,
      'can_approve_stories', true, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
    when 'trusted' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', false, 'can_edit_stories', false,
      'can_approve_stories', false, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
    else jsonb_build_object(
      'can_answer_requests', false, 'can_edit_routines', false, 'can_edit_stories', false,
      'can_approve_stories', false, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
  end;
$$;

create or replace function kindly.apply_role_permissions()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare p jsonb;
begin
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    p := kindly.default_permissions(new.role);
    new.can_answer_requests   := (p->>'can_answer_requests')::boolean;
    new.can_edit_routines     := (p->>'can_edit_routines')::boolean;
    new.can_edit_stories      := (p->>'can_edit_stories')::boolean;
    new.can_approve_stories   := (p->>'can_approve_stories')::boolean;
    new.can_manage_children   := (p->>'can_manage_children')::boolean;
    new.can_manage_caregivers := (p->>'can_manage_caregivers')::boolean;
    new.can_manage_safety     := (p->>'can_manage_safety')::boolean;
    new.can_export_data       := (p->>'can_export_data')::boolean;
  end if;
  return new;
end;
$fn$;

create trigger trg_family_members_role_defaults
  before insert or update of role on public.family_members
  for each row execute function kindly.apply_role_permissions();

-- --------------------------------------------------------------------------
-- Default request vocabulary (family_id null = KINDLY built-ins)
-- --------------------------------------------------------------------------
insert into public.request_types
  (family_id, child_id, slug, child_facing_label, child_facing_detail, urgency, pictogram_key, color_key, sort_order, is_builtin)
values
  (null, null, 'help',      'Help',            'Something is tricky',   'urgent',   'i-help',      'coral',  10, true),
  (null, null, 'pain',      'It hurts',        'I have pain',           'urgent',   'i-hurt',      'coral',  20, true),
  (null, null, 'breathing', 'Hard to breathe', 'Breathing is difficult','urgent',   'i-breath',    'coral',  30, true),
  (null, null, 'unsafe',    'I feel unsafe',   'Something is scary',    'urgent',   'i-shield',    'coral',  40, true),
  (null, null, 'bathroom',  'Bathroom',        'I need to go',          'urgent',   'i-bathroom',  'yellow', 50, true),
  (null, null, 'drink',     'Drink',           'I am thirsty',          'can_wait', 'i-droplet',   'blue',   60, true),
  (null, null, 'break',     'Break',           'I need quiet',          'can_wait', 'i-pause',     'purple', 70, true),
  (null, null, 'other',     'Something else',  'I will show you',       'can_wait', 'i-more',      'blue',   80, true),
  -- The "How I feel" vocabulary shares the request lifecycle so that a feeling
  -- a child shares is delivered, acknowledged and cancellable in the same way.
  (null, null, 'feeling',   'How I feel',      'I want to share this',  'can_wait', 'i-heart',     'purple', 90, true);

comment on table public.request_types is
  'Built-in rows (family_id IS NULL) are KINDLY defaults. "bathroom" ships as URGENT: KINDLY does not assume a bathroom request can safely wait. Families change it per child in child_preferences.bathroom_urgency.';

-- --------------------------------------------------------------------------
-- bootstrap_family — one atomic call at the end of onboarding step 1
-- --------------------------------------------------------------------------
create or replace function public.bootstrap_family(
  p_caregiver_name text,
  p_child_name     text,
  p_family_name    text default null,
  p_trusted_caregiver_name text default null,
  p_pin            text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_cg   text := kindly.normalize_name(p_caregiver_name);
  v_ch   text := kindly.normalize_name(p_child_name);
  v_tr   text := kindly.normalize_name(p_trusted_caregiver_name);
  v_fam  uuid;
  v_child uuid;
  v_profile uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if v_cg is null then raise exception 'CAREGIVER_NAME_REQUIRED'; end if;
  if v_ch is null then raise exception 'CHILD_NAME_REQUIRED'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;

  perform kindly.rate_limit('bootstrap:' || v_user::text, 5, interval '1 hour');

  insert into public.users (id, email)
  select v_user, coalesce(au.email, 'unknown@invalid')
    from auth.users au where au.id = v_user
  on conflict (id) do nothing;

  insert into public.caregiver_profiles (user_id, caregiver_name, onboarding_stage)
  values (v_user, v_cg, 'preferences')
  on conflict (user_id) do update set caregiver_name = excluded.caregiver_name
  returning id into v_profile;

  insert into public.families (family_name, created_by)
  values (coalesce(kindly.normalize_name(p_family_name), v_cg || ' + ' || v_ch), v_user)
  returning id into v_fam;

  insert into public.family_members (family_id, user_id, role)
  values (v_fam, v_user, 'owner');

  insert into public.child_profiles (family_id, child_name, created_by)
  values (v_fam, v_ch, v_user)
  returning id into v_child;

  insert into public.child_preferences (child_id, family_id, updated_by)
  values (v_child, v_fam, v_user);

  insert into public.notification_preferences (user_id, family_id)
  values (v_user, v_fam) on conflict do nothing;

  -- A named trusted caregiver who is not (yet) a KINDLY user.
  if v_tr is not null then
    insert into public.trusted_caregivers
      (family_id, child_id, trusted_caregiver_name, escalation_order, created_by)
    values (v_fam, v_child, v_tr, 1, v_user);
  end if;

  -- Default escalation ladder. The last rung is always offline help so a child
  -- is never left waiting with nothing to do.
  insert into public.escalation_rules (child_id, family_id, applies_to_urgency, step_order, action, after_seconds)
  values
    (v_child, v_fam, null, 1, 'notify_trusted',       120),
    (v_child, v_fam, null, 2, 'notify_all_caregivers',240),
    (v_child, v_fam, null, 3, 'show_offline_help',    360);

  if p_pin is not null then
    perform public.set_caregiver_pin(v_fam, p_pin);
  end if;

  perform kindly.log_audit(v_fam, 'family.bootstrap', 'family', v_fam,
    jsonb_build_object('child_id', v_child, 'has_trusted', v_tr is not null, 'has_pin', p_pin is not null));

  return jsonb_build_object(
    'family_id', v_fam, 'child_id', v_child, 'caregiver_profile_id', v_profile);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Caregiver PIN
-- --------------------------------------------------------------------------
create or replace function public.set_caregiver_pin(p_family uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;
  -- Reject the most guessable codes outright.
  if p_pin in ('0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','0123') then
    raise exception 'PIN_TOO_EASY_TO_GUESS';
  end if;

  insert into public.caregiver_pins (family_id, pin_hash, pin_length, set_by)
  values (p_family, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), char_length(p_pin), auth.uid())
  on conflict (family_id) do update
    set pin_hash = excluded.pin_hash,
        pin_length = excluded.pin_length,
        failed_attempts = 0,
        locked_until = null,
        set_by = excluded.set_by,
        verification_mode = 'pin';

  perform kindly.log_audit(p_family, 'security.pin_set', 'family', p_family, '{}'::jsonb);
end;
$fn$;

create or replace function public.set_adult_verification_mode(p_family uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.has_permission(p_family, 'can_manage_safety') then raise exception 'NOT_PERMITTED'; end if;
  if p_mode not in ('pin','device_biometric','none') then raise exception 'INVALID_VERIFICATION_MODE'; end if;
  insert into public.caregiver_pins (family_id, pin_hash, verification_mode, set_by)
  values (p_family, 'disabled', p_mode, auth.uid())
  on conflict (family_id) do update set verification_mode = excluded.verification_mode;
  perform kindly.log_audit(p_family, 'security.verification_mode', 'family', p_family,
    jsonb_build_object('mode', p_mode));
end;
$fn$;

-- Returns only a boolean. Never returns or logs the PIN or its hash.
create or replace function public.verify_caregiver_pin(p_family uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.caregiver_pins%rowtype;
  v_ok  boolean;
  v_now timestamptz := kindly.now();
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;

  -- 10 attempts per 15 minutes per family, then a 15 minute lockout.
  perform kindly.rate_limit('pin:' || p_family::text, 10, interval '15 minutes', interval '15 minutes');

  select * into v_row from public.caregiver_pins where family_id = p_family for update;

  if not found or v_row.verification_mode = 'none' then
    return jsonb_build_object('ok', true, 'mode', 'none');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('ok', false, 'locked_until', v_row.locked_until, 'mode', v_row.verification_mode);
  end if;

  v_ok := (v_row.pin_hash <> 'disabled' and extensions.crypt(coalesce(p_pin, ''), v_row.pin_hash) = v_row.pin_hash);

  if v_ok then
    update public.caregiver_pins set failed_attempts = 0, locked_until = null where family_id = p_family;
  else
    update public.caregiver_pins
       set failed_attempts = v_row.failed_attempts + 1,
           locked_until = case when v_row.failed_attempts + 1 >= 5 then v_now + interval '5 minutes' else null end
     where family_id = p_family;
    perform kindly.log_audit(p_family, 'security.pin_failed', 'family', p_family,
      jsonb_build_object('attempt', v_row.failed_attempts + 1));
  end if;

  return jsonb_build_object('ok', v_ok, 'mode', v_row.verification_mode,
                            'attempts_remaining', greatest(0, 5 - (v_row.failed_attempts + case when v_ok then 0 else 1 end)));
end;
$fn$;

-- --------------------------------------------------------------------------
-- Child sessions
-- --------------------------------------------------------------------------
create or replace function public.start_child_session(
  p_child uuid, p_device_label text default null, p_hours int default 12
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fam uuid := kindly.family_of_child(p_child);
  v_token text;
  v_id uuid;
begin
  if v_fam is null or not kindly.is_member(v_fam) then raise exception 'NOT_PERMITTED'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'INVALID_SESSION_LENGTH'; end if;

  -- Only one live child session per child per device hand-over.
  update public.child_sessions
     set state = 'ended', ended_at = kindly.now()
   where child_id = p_child and state = 'active';

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.child_sessions (family_id, child_id, token_hash, started_by, device_label, expires_at)
  values (v_fam, p_child, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(),
          left(coalesce(p_device_label, 'This device'), 120), kindly.now() + make_interval(hours => p_hours))
  returning id into v_id;

  perform kindly.log_audit(v_fam, 'child_session.start', 'child_session', v_id,
    jsonb_build_object('child_id', p_child));

  return jsonb_build_object('session_id', v_id, 'child_id', p_child, 'family_id', v_fam,
                            'session_token', v_token,
                            'expires_at', kindly.now() + make_interval(hours => p_hours));
end;
$fn$;

-- Validates a child session token and that the session may perform an action.
create or replace function kindly.assert_child_session(p_token text, p_action text)
returns public.child_sessions
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.child_sessions%rowtype;
begin
  if p_token is null or char_length(p_token) < 32 then raise exception 'CHILD_SESSION_INVALID'; end if;

  select * into v_row from public.child_sessions
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
   for update;

  if not found then raise exception 'CHILD_SESSION_INVALID'; end if;

  if v_row.state <> 'active' then raise exception 'CHILD_SESSION_%', upper(v_row.state::text); end if;

  if v_row.expires_at <= kindly.now() then
    update public.child_sessions set state = 'expired' where id = v_row.id;
    raise exception 'CHILD_SESSION_EXPIRED';
  end if;

  if not (p_action = any (v_row.allowed_actions)) then
    raise exception 'CHILD_ACTION_NOT_PERMITTED: %', p_action;
  end if;

  update public.child_sessions set last_seen_at = kindly.now() where id = v_row.id;
  return v_row;
end;
$fn$;

create or replace function public.end_child_session(p_session_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.child_sessions%rowtype;
begin
  select * into v_row from public.child_sessions
   where token_hash = encode(extensions.digest(coalesce(p_session_token,''), 'sha256'), 'hex');
  if not found then return; end if;
  update public.child_sessions set state = 'ended', ended_at = kindly.now() where id = v_row.id;
  perform kindly.log_audit(v_row.family_id, 'child_session.end', 'child_session', v_row.id, '{}'::jsonb);
end;
$fn$;

create or replace function public.revoke_child_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_fam uuid;
begin
  select family_id into v_fam from public.child_sessions where id = p_session_id;
  if v_fam is null or not kindly.is_member(v_fam) then raise exception 'NOT_PERMITTED'; end if;
  update public.child_sessions set state = 'revoked', ended_at = kindly.now() where id = p_session_id;
  perform kindly.log_audit(v_fam, 'child_session.revoke', 'child_session', p_session_id, '{}'::jsonb);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants: only these functions are callable from a browser
-- --------------------------------------------------------------------------
revoke all on function public.bootstrap_family(text, text, text, text, text) from public, anon;
grant execute on function public.bootstrap_family(text, text, text, text, text) to authenticated;

revoke all on function public.set_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.set_caregiver_pin(uuid, text) to authenticated;

revoke all on function public.set_adult_verification_mode(uuid, text) from public, anon;
grant execute on function public.set_adult_verification_mode(uuid, text) to authenticated;

revoke all on function public.verify_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.verify_caregiver_pin(uuid, text) to authenticated;

revoke all on function public.start_child_session(uuid, text, int) from public, anon;
grant execute on function public.start_child_session(uuid, text, int) to authenticated;

revoke all on function public.end_child_session(text) from public, anon;
grant execute on function public.end_child_session(text) to authenticated;

revoke all on function public.revoke_child_session(uuid) from public, anon;
grant execute on function public.revoke_child_session(uuid) to authenticated;


-- ==== 20260101001000_functions_requests.sql =======================

-- ===========================================================================
-- KINDLY 0010 — the help-request lifecycle, server side
-- ===========================================================================
-- Guarantees implemented here:
--   * "Delivered" means: durably stored AND routed to at least one adult who is
--     permitted to answer. The client cannot set it.
--   * "Acknowledged" means: a request_responses row exists. Nothing else.
--   * Exactly one caregiver owns an open request at a time (SELECT ... FOR
--     UPDATE plus an assignment check) so two adults cannot give a child two
--     different answers.
--   * Urgent requests reject `delay` responses at three levels: enum-shaped
--     inputs, this function, and a table trigger.
--   * Every transition writes a request_events row.
-- ===========================================================================

create or replace function kindly.allowed_transition(
  p_from public.request_status, p_to public.request_status
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'reviewing'    then p_to in ('sending','cancelled')
    when 'sending'      then p_to in ('delivered','failed','cancelled','unavailable')
    when 'retrying'     then p_to in ('delivered','failed','cancelled','unavailable')
    when 'failed'       then p_to in ('retrying','cancelled','resolved')
    when 'delivered'    then p_to in ('acknowledged','waiting','escalated','cancelled','resolved')
    when 'waiting'      then p_to in ('escalated','unavailable','acknowledged','cancelled','resolved')
    when 'escalated'    then p_to in ('acknowledged','unavailable','waiting','cancelled','resolved')
    when 'unavailable'  then p_to in ('retrying','acknowledged','cancelled','resolved')
    when 'acknowledged' then p_to in ('acknowledged','escalated','resolved','cancelled')
    else false
  end;
$$;
comment on function kindly.allowed_transition(public.request_status, public.request_status) is
  'Single source of truth for the request state machine. Mirrored byte-for-byte in src/lib/requests/stateMachine.ts and asserted by a unit test.';

create or replace function kindly.record_event(
  p_request uuid, p_family uuid, p_kind public.request_event_kind,
  p_from public.request_status, p_to public.request_status,
  p_actor_kind text, p_actor_name text, p_detail jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.request_events
    (request_id, family_id, kind, from_status, to_status, actor_user_id, actor_kind, actor_name, detail)
  values (p_request, p_family, p_kind, p_from, p_to, auth.uid(), p_actor_kind, p_actor_name, coalesce(p_detail,'{}'::jsonb));
$$;

-- Who, right now, may answer for this family? Ordered deterministically.
create or replace function kindly.eligible_responders(p_family uuid)
returns table (user_id uuid, caregiver_name text, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select fm.user_id,
         coalesce(cp.caregiver_name, 'A caregiver'),
         fm.joined_at
    from public.family_members fm
    left join public.caregiver_profiles cp on cp.user_id = fm.user_id and cp.deleted_at is null
   where fm.family_id = p_family
     and fm.revoked_at is null
     and fm.can_answer_requests
   order by fm.joined_at, fm.user_id;
$$;

-- --------------------------------------------------------------------------
-- child_create_request — step 1 of the confirmation flow ("Review")
-- --------------------------------------------------------------------------
create or replace function public.child_create_request(
  p_session_token text,
  p_type_slug     text,
  p_dedupe_key    text,
  p_custom_message text default null,
  p_device_label  text default null,
  p_connection_state text default 'online',
  -- Used by the "How I feel" vocabulary, which shares the request lifecycle:
  -- the child-facing label becomes the feeling the child chose.
  p_label_override text default null,
  p_detail_override text default null
) returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s     public.child_sessions%rowtype;
  v_type  public.request_types%rowtype;
  v_prefs public.child_preferences%rowtype;
  v_urg   public.request_urgency;
  v_req   public.requests%rowtype;
  v_msg   text := kindly.normalize_name(p_custom_message);
  v_label text;
  v_detail text;
begin
  v_s := kindly.assert_child_session(p_session_token, 'create_request');

  -- 30 request creations per child per 10 minutes: generous for a child,
  -- narrow enough to stop a runaway loop.
  perform kindly.rate_limit('req_create:' || v_s.child_id::text, 30, interval '10 minutes');

  if p_dedupe_key is null or char_length(p_dedupe_key) < 8 then raise exception 'DEDUPE_KEY_REQUIRED'; end if;

  -- Idempotent: the same tap-intent always returns the same request.
  select * into v_req from public.requests
   where child_id = v_s.child_id and client_dedupe_key = p_dedupe_key;
  if found then return v_req; end if;

  -- Family/child override first, then the KINDLY built-in.
  select * into v_type from public.request_types
   where slug = p_type_slug and deleted_at is null and is_active
     and (child_id = v_s.child_id or (child_id is null and family_id = v_s.family_id) or (child_id is null and family_id is null))
   order by (child_id is not null) desc, (family_id is not null) desc
   limit 1;
  if not found then raise exception 'UNKNOWN_REQUEST_TYPE: %', p_type_slug; end if;

  select * into v_prefs from public.child_preferences where child_id = v_s.child_id;

  v_urg := v_type.urgency;
  -- Bathroom urgency is a per-child family decision, never a KINDLY assumption.
  if v_type.slug = 'bathroom' and v_prefs.child_id is not null then
    v_urg := v_prefs.bathroom_urgency;
  end if;

  if v_msg is not null and v_prefs.child_id is not null and not v_prefs.allow_custom_message then
    v_msg := null;
  end if;

  v_label  := coalesce(left(kindly.normalize_name(p_label_override), 40), v_type.child_facing_label);
  v_detail := coalesce(left(kindly.normalize_name(p_detail_override), 80), v_type.child_facing_detail);

  -- An identical open request already exists: hand that one back instead of
  -- creating a second. This is what makes repeated tapping harmless.
  select * into v_req from public.requests
   where child_id = v_s.child_id and type_slug = v_type.slug and child_facing_label = v_label
     and status in ('reviewing','sending','retrying','failed','delivered','waiting','escalated','unavailable','acknowledged');
  if found then return v_req; end if;

  insert into public.requests (
    family_id, child_id, child_session_id, request_type_id, type_slug,
    child_facing_label, child_facing_detail, urgency, pictogram_key, pictogram_media_id,
    custom_message, status, device_label, connection_state, client_dedupe_key)
  values (
    v_s.family_id, v_s.child_id, v_s.id, v_type.id, v_type.slug,
    v_label, v_detail, v_urg, v_type.pictogram_key, v_type.pictogram_media_id,
    v_msg, 'reviewing', left(coalesce(p_device_label, v_s.device_label), 120),
    case when p_connection_state in ('online','offline') then p_connection_state else 'unknown' end,
    p_dedupe_key)
  returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'created', null, 'reviewing', 'child', null,
    jsonb_build_object('type_slug', v_type.slug, 'urgency', v_urg));

  return v_req;
end;
$fn$;

-- --------------------------------------------------------------------------
-- child_send_request — the only path to "delivered"
-- --------------------------------------------------------------------------
create or replace function public.child_send_request(
  p_session_token text,
  p_request_id    uuid,
  p_connection_state text default 'online'
) returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s        public.child_sessions%rowtype;
  v_req      public.requests%rowtype;
  v_from     public.request_status;
  v_to       public.request_status;
  v_child    text;
  v_assignee record;
  v_count    int := 0;
begin
  v_s := kindly.assert_child_session(p_session_token, 'send_request');
  perform kindly.rate_limit('req_send:' || v_s.child_id::text, 40, interval '10 minutes');

  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.child_id <> v_s.child_id then raise exception 'REQUEST_NOT_FOUND'; end if;

  v_from := v_req.status;
  v_to := case when v_from = 'reviewing' then 'sending' else 'retrying' end;

  if not kindly.allowed_transition(v_from, v_to) then
    -- Already in flight or already delivered: return the truth, do not double-send.
    return v_req;
  end if;

  select child_name into v_child from public.child_profiles where id = v_req.child_id;

  update public.requests
     set status = v_to,
         sending_started_at = coalesce(sending_started_at, kindly.now()),
         attempts = attempts + 1,
         failure_reason = null,
         connection_state = case when p_connection_state in ('online','offline') then p_connection_state else 'unknown' end,
         lock_version = lock_version + 1
   where id = v_req.id
   returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id,
    case when v_to = 'retrying' then 'retry_attempted' else 'status_changed' end,
    v_from, v_to, 'child', v_child, jsonb_build_object('attempt', v_req.attempts));

  -- Route to every adult who may answer. Assignment prefers the adult who
  -- started this child session (they handed over the device), then seniority.
  for v_assignee in
    select * from kindly.eligible_responders(v_req.family_id)
     order by (user_id = v_s.started_by) desc, joined_at, user_id
  loop
    if v_count = 0 then
      update public.requests
         set assigned_to_user_id = v_assignee.user_id,
             assigned_to_name = v_assignee.caregiver_name
       where id = v_req.id
       returning * into v_req;
    end if;

    insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
    values (v_req.family_id, v_assignee.user_id, 'request_created',
            coalesce(v_child, 'Your child') || ' asked for: ' || v_req.child_facing_label,
            case when v_req.urgency = 'urgent' then 'Urgent request. Please answer now.'
                 else 'This can wait a little, but please answer.' end,
            v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text,
            v_req.urgency = 'urgent');
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    -- Nobody in this family can answer. Never claim delivery; show offline help.
    update public.requests
       set status = 'unavailable', unavailable_at = kindly.now(), lock_version = lock_version + 1
     where id = v_req.id returning * into v_req;
    perform kindly.record_event(v_req.id, v_req.family_id, 'delivery_failed', v_to, 'unavailable',
      'system', null, jsonb_build_object('reason', 'no_eligible_responder'));
    return v_req;
  end if;

  -- Durably stored and routed: this is what "Delivered" means in KINDLY.
  update public.requests
     set status = 'delivered', delivered_at = kindly.now(), lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'delivery_confirmed', v_to, 'delivered',
    'system', null, jsonb_build_object('notified', v_count));

  return v_req;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Cancellation by the child ("I changed my mind")
-- --------------------------------------------------------------------------
create or replace function public.child_cancel_request(p_session_token text, p_request_id uuid)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s   public.child_sessions%rowtype;
  v_req public.requests%rowtype;
  v_from public.request_status;
  v_child text;
  v_r record;
begin
  v_s := kindly.assert_child_session(p_session_token, 'cancel_request');

  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.child_id <> v_s.child_id then raise exception 'REQUEST_NOT_FOUND'; end if;

  v_from := v_req.status;
  if not kindly.allowed_transition(v_from, 'cancelled') then return v_req; end if;

  select child_name into v_child from public.child_profiles where id = v_req.child_id;

  update public.requests
     set status = 'cancelled', cancelled_at = kindly.now(), cancelled_by = 'child',
         lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'cancelled', v_from, 'cancelled', 'child', v_child,
    jsonb_build_object('was_delivered', v_req.delivered_at is not null));

  -- If an adult was already told about it, tell them it was withdrawn.
  if v_req.delivered_at is not null then
    for v_r in select * from kindly.eligible_responders(v_req.family_id) loop
      insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route)
      values (v_req.family_id, v_r.user_id, 'request_cancelled',
              coalesce(v_child, 'Your child') || ' changed their mind',
              'The request "' || v_req.child_facing_label || '" was cancelled. No answer is needed now.',
              v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text);
    end loop;
  end if;

  return v_req;
end;
$fn$;

create or replace function public.child_resolve_request(p_session_token text, p_request_id uuid)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s public.child_sessions%rowtype;
  v_req public.requests%rowtype;
  v_from public.request_status;
  v_child text;
begin
  v_s := kindly.assert_child_session(p_session_token, 'resolve_request');
  select * into v_req from public.requests where id = p_request_id for update;
  if not found or v_req.child_id <> v_s.child_id then raise exception 'REQUEST_NOT_FOUND'; end if;

  v_from := v_req.status;
  if not kindly.allowed_transition(v_from, 'resolved') then return v_req; end if;

  select child_name into v_child from public.child_profiles where id = v_req.child_id;

  update public.requests
     set status = 'resolved', resolved_at = kindly.now(), lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'resolved', v_from, 'resolved', 'child', v_child, '{}'::jsonb);
  return v_req;
end;
$fn$;

-- --------------------------------------------------------------------------
-- respond_to_request — the caregiver side
-- --------------------------------------------------------------------------
create or replace function public.respond_to_request(
  p_request_id   uuid,
  p_kind         public.response_kind,
  p_delay_minutes int default null,
  p_message      text default null
) returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req  public.requests%rowtype;
  v_from public.request_status;
  v_name text;
  v_trusted public.trusted_caregivers%rowtype;
  v_responder_name text;
  v_trusted_id uuid;
  v_due timestamptz;
  v_msg text := kindly.normalize_name(p_message);
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select * into v_req from public.requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if not kindly.is_member(v_req.family_id) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  if not kindly.has_permission(v_req.family_id, 'can_answer_requests') then raise exception 'NOT_PERMITTED_TO_ANSWER'; end if;

  perform kindly.rate_limit('respond:' || auth.uid()::text, 60, interval '5 minutes');

  v_from := v_req.status;
  if v_from in ('resolved','cancelled') then raise exception 'REQUEST_ALREADY_CLOSED'; end if;
  if v_req.delivered_at is null then raise exception 'REQUEST_NOT_DELIVERED_YET'; end if;

  -- Conflict prevention: only the assigned adult answers, so the child never
  -- receives two different answers to the same request.
  if v_req.assigned_to_user_id is not null and v_req.assigned_to_user_id <> auth.uid() then
    raise exception 'REQUEST_ASSIGNED_ELSEWHERE'
      using detail = coalesce(v_req.assigned_to_name, 'another caregiver');
  end if;

  -- SAFETY: an urgent request may never be answered with "in N minutes".
  if v_req.urgency = 'urgent' and p_kind = 'delay' then
    raise exception 'URGENT_REQUEST_CANNOT_BE_DELAYED';
  end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();
  v_responder_name := coalesce(v_name, 'A caregiver');

  if p_kind = 'other_caregiver' then
    select * into v_trusted from public.trusted_caregivers
     where child_id = v_req.child_id and deleted_at is null and is_active
     order by escalation_order limit 1;
    if not found then raise exception 'NO_TRUSTED_CAREGIVER_CONFIGURED'; end if;
    v_trusted_id := v_trusted.id;
    v_responder_name := v_trusted.trusted_caregiver_name;
  end if;

  if p_kind = 'delay' then
    if p_delay_minutes is null or p_delay_minutes < 1 or p_delay_minutes > 120 then
      raise exception 'DELAY_MINUTES_OUT_OF_RANGE';
    end if;
    v_due := kindly.now() + make_interval(mins => p_delay_minutes);
  end if;

  update public.request_responses set is_current = false
   where request_id = v_req.id and is_current;

  insert into public.request_responses
    (request_id, family_id, kind, delay_minutes, due_at, message,
     responder_user_id, responder_trusted_id, responder_name, is_current)
  values (v_req.id, v_req.family_id, p_kind,
          case when p_kind = 'delay' then p_delay_minutes end, v_due, v_msg,
          auth.uid(), v_trusted_id, v_responder_name, true);

  update public.requests
     set status = 'acknowledged',
         acknowledged_at = coalesce(acknowledged_at, kindly.now()),
         assigned_to_user_id = case when p_kind = 'other_caregiver' then v_trusted.user_id else auth.uid() end,
         assigned_to_trusted_id = case when p_kind = 'other_caregiver' then v_trusted_id else assigned_to_trusted_id end,
         assigned_to_name = v_responder_name,
         lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'response_recorded', v_from, 'acknowledged',
    'caregiver', coalesce(v_name, 'A caregiver'),
    jsonb_build_object('kind', p_kind, 'delay_minutes', p_delay_minutes, 'responder_name', v_responder_name));

  if p_kind = 'other_caregiver' then
    insert into public.request_events (request_id, family_id, kind, from_status, to_status, actor_user_id, actor_kind, actor_name, detail)
    values (v_req.id, v_req.family_id, 'assigned', 'acknowledged', 'acknowledged', auth.uid(), 'caregiver',
            coalesce(v_name, 'A caregiver'),
            jsonb_build_object('to', v_responder_name, 'reason', 'Reassigned by caregiver'));
  end if;

  return v_req;
end;
$fn$;

-- Take an escalated/reassigned request back so you can answer it yourself.
create or replace function public.claim_request(p_request_id uuid)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_name text;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if not kindly.has_permission(v_req.family_id, 'can_answer_requests') then raise exception 'NOT_PERMITTED_TO_ANSWER'; end if;
  if v_req.status in ('resolved','cancelled') then raise exception 'REQUEST_ALREADY_CLOSED'; end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  update public.requests
     set assigned_to_user_id = auth.uid(),
         assigned_to_trusted_id = null,
         assigned_to_name = coalesce(v_name, 'A caregiver'),
         lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'assigned', v_req.status, v_req.status,
    'caregiver', coalesce(v_name,'A caregiver'),
    jsonb_build_object('to', coalesce(v_name,'A caregiver'), 'reason', 'Taken back'));
  return v_req;
end;
$fn$;

create or replace function public.escalate_request(p_request_id uuid, p_trusted_id uuid default null)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_from public.request_status;
  v_t public.trusted_caregivers%rowtype;
  v_name text;
  v_r record;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if not kindly.has_permission(v_req.family_id, 'can_answer_requests') then raise exception 'NOT_PERMITTED_TO_ANSWER'; end if;

  v_from := v_req.status;
  if not kindly.allowed_transition(v_from, 'escalated') then raise exception 'INVALID_TRANSITION: % -> escalated', v_from; end if;

  if p_trusted_id is null then
    select * into v_t from public.trusted_caregivers
     where child_id = v_req.child_id and deleted_at is null and is_active
     order by escalation_order limit 1;
  else
    select * into v_t from public.trusted_caregivers where id = p_trusted_id and child_id = v_req.child_id;
  end if;
  if not found then raise exception 'NO_TRUSTED_CAREGIVER_CONFIGURED'; end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  update public.requests
     set status = 'escalated', escalated_at = kindly.now(),
         assigned_to_user_id = v_t.user_id, assigned_to_trusted_id = v_t.id,
         assigned_to_name = v_t.trusted_caregiver_name,
         lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'escalated', v_from, 'escalated',
    'caregiver', coalesce(v_name,'A caregiver'),
    jsonb_build_object('to', v_t.trusted_caregiver_name, 'reason', 'Escalated by caregiver'));

  for v_r in select * from kindly.eligible_responders(v_req.family_id) loop
    insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
    values (v_req.family_id, v_r.user_id, 'request_escalated',
            'Passed to ' || v_t.trusted_caregiver_name,
            'The request "' || v_req.child_facing_label || '" is now with ' || v_t.trusted_caregiver_name || '.',
            v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text, v_req.urgency = 'urgent');
  end loop;

  return v_req;
end;
$fn$;

create or replace function public.resolve_request(p_request_id uuid, p_confirm_urgent boolean default false)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_from public.request_status;
  v_name text;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if not kindly.has_permission(v_req.family_id, 'can_answer_requests') then raise exception 'NOT_PERMITTED_TO_ANSWER'; end if;

  v_from := v_req.status;
  if not kindly.allowed_transition(v_from, 'resolved') then raise exception 'INVALID_TRANSITION: % -> resolved', v_from; end if;

  -- Closing an urgent request needs an explicit confirmation that the child is
  -- safe and no longer waiting.
  if v_req.urgency = 'urgent' and not coalesce(p_confirm_urgent, false) then
    raise exception 'URGENT_RESOLVE_NEEDS_CONFIRMATION';
  end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  update public.requests
     set status = 'resolved', resolved_at = kindly.now(), lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'resolved', v_from, 'resolved',
    'caregiver', coalesce(v_name,'A caregiver'), '{}'::jsonb);
  return v_req;
end;
$fn$;

create or replace function public.cancel_request_as_caregiver(p_request_id uuid, p_reason text default null)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_from public.request_status;
  v_name text;
begin
  select * into v_req from public.requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if not kindly.has_permission(v_req.family_id, 'can_answer_requests') then raise exception 'NOT_PERMITTED_TO_ANSWER'; end if;
  v_from := v_req.status;
  if not kindly.allowed_transition(v_from, 'cancelled') then raise exception 'INVALID_TRANSITION'; end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  update public.requests
     set status = 'cancelled', cancelled_at = kindly.now(), cancelled_by = 'caregiver',
         lock_version = lock_version + 1
   where id = v_req.id returning * into v_req;

  perform kindly.record_event(v_req.id, v_req.family_id, 'cancelled', v_from, 'cancelled',
    'caregiver', coalesce(v_name,'A caregiver'), jsonb_build_object('reason', left(coalesce(p_reason,''), 200)));
  return v_req;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Escalation sweep — applies each family's own configured ladder
-- --------------------------------------------------------------------------
-- Safe for any family member to call (it only ever applies that family's rules)
-- and idempotent, so it can be driven by pg_cron in production and by a client
-- heartbeat in development. See docs/architecture.md.
create or replace function public.tick_request_escalations(p_family uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_rule public.escalation_rules%rowtype;
  v_t public.trusted_caregivers%rowtype;
  v_elapsed int;
  v_changed int := 0;
  v_r record;
  v_child text;
begin
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;

  for v_req in
    select * from public.requests
     where family_id = p_family
       and status in ('delivered','waiting','escalated','sending','retrying')
     order by created_at
     for update skip locked
  loop
    -- A write that was accepted but never confirmed. Never leave it hanging.
    if v_req.status in ('sending','retrying')
       and kindly.now() - coalesce(v_req.sending_started_at, v_req.created_at) > interval '60 seconds' then
      update public.requests
         set status = 'failed', failure_reason = 'interrupted', lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'delivery_failed', v_req.status, 'failed',
        'system', null, jsonb_build_object('reason','interrupted'));
      v_changed := v_changed + 1;
      continue;
    end if;

    if v_req.delivered_at is null then continue; end if;
    v_elapsed := floor(extract(epoch from (kindly.now() - v_req.delivered_at)))::int;

    select * into v_rule from public.escalation_rules
     where child_id = v_req.child_id and is_active
       and (applies_to_urgency is null or applies_to_urgency = v_req.urgency)
       and after_seconds <= v_elapsed
     order by step_order desc
     limit 1;

    if not found then continue; end if;

    select child_name into v_child from public.child_profiles where id = v_req.child_id;

    if v_rule.action = 'notify_trusted' and v_req.status = 'delivered' then
      update public.requests set status = 'waiting', waiting_since = kindly.now(), lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'status_changed', 'delivered', 'waiting',
        'system', null, jsonb_build_object('after_seconds', v_elapsed));
      v_changed := v_changed + 1;

    elsif v_rule.action in ('notify_trusted','notify_all_caregivers') and v_req.status = 'waiting' then
      select * into v_t from public.trusted_caregivers
       where child_id = v_req.child_id and deleted_at is null and is_active
         and (v_rule.trusted_caregiver_id is null or id = v_rule.trusted_caregiver_id)
       order by escalation_order limit 1;

      if found then
        update public.requests
           set status = 'escalated', escalated_at = kindly.now(),
               assigned_to_user_id = v_t.user_id, assigned_to_trusted_id = v_t.id,
               assigned_to_name = v_t.trusted_caregiver_name, lock_version = lock_version + 1
         where id = v_req.id;
        perform kindly.record_event(v_req.id, p_family, 'escalated', 'waiting', 'escalated',
          'system', null, jsonb_build_object('to', v_t.trusted_caregiver_name, 'reason', 'No answer in time'));
        for v_r in select * from kindly.eligible_responders(p_family) loop
          insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
          values (p_family, v_r.user_id, 'request_escalated',
                  'No answer yet for ' || coalesce(v_child,'your child'),
                  'The request "' || v_req.child_facing_label || '" was passed to ' || v_t.trusted_caregiver_name || '.',
                  v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text, v_req.urgency = 'urgent');
        end loop;
      else
        update public.requests set status = 'unavailable', unavailable_at = kindly.now(), lock_version = lock_version + 1
         where id = v_req.id;
        perform kindly.record_event(v_req.id, p_family, 'status_changed', 'waiting', 'unavailable',
          'system', null, jsonb_build_object('reason','no_trusted_caregiver'));
      end if;
      v_changed := v_changed + 1;

    elsif v_rule.action = 'show_offline_help' and v_req.status in ('waiting','escalated') then
      update public.requests set status = 'unavailable', unavailable_at = kindly.now(), lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'status_changed', v_req.status, 'unavailable',
        'system', null, jsonb_build_object('after_seconds', v_elapsed));
      for v_r in select * from kindly.eligible_responders(p_family) loop
        insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
        values (p_family, v_r.user_id, 'request_unanswered',
                'Still no answer for ' || coalesce(v_child,'your child'),
                'KINDLY has shown offline help. Please check on them.',
                v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text, true);
      end loop;
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
do $do$
declare f text;
begin
  foreach f in array array[
    'public.child_create_request(text, text, text, text, text, text, text, text)',
    'public.child_send_request(text, uuid, text)',
    'public.child_cancel_request(text, uuid)',
    'public.child_resolve_request(text, uuid)',
    'public.respond_to_request(uuid, public.response_kind, int, text)',
    'public.claim_request(uuid)',
    'public.escalate_request(uuid, uuid)',
    'public.resolve_request(uuid, boolean)',
    'public.cancel_request_as_caregiver(uuid, text)',
    'public.tick_request_escalations(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $do$;


-- ==== 20260101001100_functions_family_stories.sql =================

-- ===========================================================================
-- KINDLY 0011 — invitations, caregiver management, story approval, child reads,
--                notifications, export and deletion, realtime
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Invitations
-- --------------------------------------------------------------------------
create or replace function public.create_caregiver_invitation(
  p_family uuid, p_email text, p_role public.family_role default 'caregiver',
  p_invited_name text default null, p_message text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_token text;
  v_id uuid;
begin
  if not kindly.has_permission(p_family, 'can_manage_caregivers') then raise exception 'NOT_PERMITTED'; end if;
  if p_email is null or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'INVALID_EMAIL';
  end if;
  if p_role = 'owner' then raise exception 'CANNOT_INVITE_AS_OWNER'; end if;

  perform kindly.rate_limit('invite:' || p_family::text, 20, interval '1 hour');

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.caregiver_invitations
    (family_id, invited_email, invited_name, role, token_hash, message, invited_by)
  values (p_family, p_email, kindly.normalize_name(p_invited_name), p_role,
          encode(extensions.digest(v_token, 'sha256'), 'hex'), left(coalesce(p_message,''), 500), auth.uid())
  returning id into v_id;

  perform kindly.log_audit(p_family, 'caregiver.invited', 'invitation', v_id,
    jsonb_build_object('role', p_role));

  -- The raw token is returned exactly once, to be emailed by the caller.
  return jsonb_build_object('invitation_id', v_id, 'token', v_token);
end;
$fn$;

create or replace function public.accept_caregiver_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_inv public.caregiver_invitations%rowtype;
  v_email extensions.citext;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform kindly.rate_limit('invite_accept:' || auth.uid()::text, 10, interval '1 hour');

  select * into v_inv from public.caregiver_invitations
   where token_hash = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
   for update;
  if not found then raise exception 'INVITATION_NOT_FOUND'; end if;
  if v_inv.status <> 'pending' then raise exception 'INVITATION_%', upper(v_inv.status::text); end if;
  if v_inv.expires_at <= kindly.now() then
    update public.caregiver_invitations set status = 'expired' where id = v_inv.id;
    raise exception 'INVITATION_EXPIRED';
  end if;

  select email into v_email from public.users where id = auth.uid();
  if v_email is distinct from v_inv.invited_email then raise exception 'INVITATION_EMAIL_MISMATCH'; end if;

  insert into public.family_members (family_id, user_id, role, invited_by)
  values (v_inv.family_id, auth.uid(), v_inv.role, v_inv.invited_by)
  on conflict (family_id, user_id) do update
    set revoked_at = null, revoked_by = null, role = excluded.role;

  insert into public.notification_preferences (user_id, family_id)
  values (auth.uid(), v_inv.family_id) on conflict do nothing;

  update public.caregiver_invitations
     set status = 'accepted', accepted_by = auth.uid(), accepted_at = kindly.now()
   where id = v_inv.id;

  perform kindly.log_audit(v_inv.family_id, 'caregiver.joined', 'family_member', null,
    jsonb_build_object('role', v_inv.role));

  insert into public.notifications (family_id, user_id, kind, title, body, route)
  select v_inv.family_id, fm.user_id, 'invitation_accepted',
         'A caregiver joined your family space',
         coalesce(cp.caregiver_name, 'A new caregiver') || ' can now help.',
         '/app/settings/caregivers'
    from public.family_members fm
    left join public.caregiver_profiles cp on cp.user_id = auth.uid()
   where fm.family_id = v_inv.family_id and fm.revoked_at is null and fm.user_id <> auth.uid();

  return jsonb_build_object('family_id', v_inv.family_id, 'role', v_inv.role);
end;
$fn$;

create or replace function public.revoke_caregiver_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_fam uuid;
begin
  select family_id into v_fam from public.caregiver_invitations where id = p_invitation;
  if v_fam is null or not kindly.has_permission(v_fam, 'can_manage_caregivers') then raise exception 'NOT_PERMITTED'; end if;
  update public.caregiver_invitations set status = 'revoked', revoked_at = kindly.now() where id = p_invitation;
  perform kindly.log_audit(v_fam, 'caregiver.invitation_revoked', 'invitation', p_invitation, '{}'::jsonb);
end;
$fn$;

create or replace function public.revoke_caregiver_access(p_family uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_owner_count int;
begin
  if not kindly.has_permission(p_family, 'can_manage_caregivers') then raise exception 'NOT_PERMITTED'; end if;

  select count(*) into v_owner_count from public.family_members
   where family_id = p_family and role = 'owner' and revoked_at is null and user_id <> p_user;
  if v_owner_count = 0 then raise exception 'CANNOT_REMOVE_LAST_OWNER'; end if;

  update public.family_members
     set revoked_at = kindly.now(), revoked_by = auth.uid()
   where family_id = p_family and user_id = p_user and revoked_at is null;

  -- Any request currently assigned to that adult goes back to the family.
  update public.requests
     set assigned_to_user_id = null, assigned_to_name = null, lock_version = lock_version + 1
   where family_id = p_family and assigned_to_user_id = p_user
     and status in ('delivered','waiting','escalated','unavailable','acknowledged');

  insert into public.notifications (family_id, user_id, kind, title, body, route)
  values (p_family, p_user, 'caregiver_removed', 'Your access to this family space ended',
          'You can no longer see or answer requests for this family.', '/app');

  perform kindly.log_audit(p_family, 'caregiver.revoked', 'family_member', null,
    jsonb_build_object('removed_user', p_user));
end;
$fn$;

create or replace function public.update_caregiver_role(p_family uuid, p_user uuid, p_role public.family_role)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.has_permission(p_family, 'can_manage_caregivers') then raise exception 'NOT_PERMITTED'; end if;
  if p_user = auth.uid() and p_role <> 'owner' then
    if (select count(*) from public.family_members
         where family_id = p_family and role = 'owner' and revoked_at is null and user_id <> p_user) = 0 then
      raise exception 'CANNOT_REMOVE_LAST_OWNER';
    end if;
  end if;
  update public.family_members set role = p_role
   where family_id = p_family and user_id = p_user and revoked_at is null;
  perform kindly.log_audit(p_family, 'caregiver.role_changed', 'family_member', null,
    jsonb_build_object('user', p_user, 'role', p_role));
end;
$fn$;

-- --------------------------------------------------------------------------
-- Stories: versioning, approval, assignment
-- --------------------------------------------------------------------------
create or replace function kindly.story_snapshot(p_story uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'story', to_jsonb(s) - 'inputs',
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.position)
        from public.story_pages p where p.story_id = s.id and p.deleted_at is null), '[]'::jsonb))
    from public.stories s where s.id = p_story;
$$;

create or replace function public.save_story_version(p_story uuid, p_change_note text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fam uuid; v_ver int; v_name text;
begin
  select family_id, version into v_fam, v_ver from public.stories where id = p_story;
  if v_fam is null or not kindly.has_permission(v_fam, 'can_edit_stories') then raise exception 'NOT_PERMITTED'; end if;
  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  insert into public.story_versions (story_id, family_id, version, snapshot, change_note, created_by, created_by_name)
  values (p_story, v_fam, v_ver, kindly.story_snapshot(p_story), left(coalesce(p_change_note,''),300), auth.uid(), v_name)
  on conflict (story_id, version) do update set snapshot = excluded.snapshot, change_note = excluded.change_note;

  update public.stories set version = v_ver + 1 where id = p_story;
  return v_ver + 1;
end;
$fn$;

create or replace function public.approve_story(p_story uuid, p_acknowledge_flags boolean default false)
returns public.stories
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_story public.stories%rowtype;
  v_name text;
  v_pages int;
begin
  select * into v_story from public.stories where id = p_story for update;
  if not found then raise exception 'STORY_NOT_FOUND'; end if;
  if not kindly.has_permission(v_story.family_id, 'can_approve_stories') then raise exception 'NOT_PERMITTED'; end if;

  select count(*) into v_pages from public.story_pages where story_id = p_story and deleted_at is null;
  if v_pages < 3 then raise exception 'STORY_TOO_SHORT'; end if;

  -- A story carrying safety flags cannot be approved by accident.
  if (v_story.requires_safety_review or jsonb_array_length(v_story.review_flags) > 0)
     and not coalesce(p_acknowledge_flags, false) then
    raise exception 'STORY_HAS_UNREVIEWED_FLAGS';
  end if;

  select caregiver_name into v_name from public.caregiver_profiles where user_id = auth.uid();

  perform public.save_story_version(p_story, 'Approved by ' || coalesce(v_name, 'a caregiver'));

  update public.stories
     set status = 'approved', approved_by = auth.uid(), approved_at = kindly.now()
   where id = p_story returning * into v_story;

  perform kindly.log_audit(v_story.family_id, 'story.approved', 'story', p_story,
    jsonb_build_object('version', v_story.version, 'had_flags', jsonb_array_length(v_story.review_flags) > 0));
  return v_story;
end;
$fn$;

create or replace function public.assign_story(p_story uuid, p_child uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_story public.stories%rowtype;
begin
  select * into v_story from public.stories where id = p_story;
  if not found then raise exception 'STORY_NOT_FOUND'; end if;
  if not kindly.has_permission(v_story.family_id, 'can_approve_stories') then raise exception 'NOT_PERMITTED'; end if;
  -- The rule the whole story pipeline exists to protect.
  if v_story.status <> 'approved' then raise exception 'STORY_NOT_APPROVED'; end if;
  if kindly.family_of_child(p_child) <> v_story.family_id then raise exception 'CHILD_NOT_IN_FAMILY'; end if;

  insert into public.story_assignments (story_id, child_id, family_id, assigned_by)
  values (p_story, p_child, v_story.family_id, auth.uid())
  on conflict (story_id, child_id) do update set withdrawn_at = null, withdrawn_by = null, assigned_at = kindly.now();

  perform kindly.log_audit(v_story.family_id, 'story.assigned', 'story', p_story, jsonb_build_object('child_id', p_child));
end;
$fn$;

create or replace function public.withdraw_story(p_story uuid, p_child uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_fam uuid;
begin
  select family_id into v_fam from public.stories where id = p_story;
  if v_fam is null or not kindly.has_permission(v_fam, 'can_approve_stories') then raise exception 'NOT_PERMITTED'; end if;
  update public.story_assignments
     set withdrawn_at = kindly.now(), withdrawn_by = auth.uid()
   where story_id = p_story and child_id = p_child;
  perform kindly.log_audit(v_fam, 'story.withdrawn', 'story', p_story, jsonb_build_object('child_id', p_child));
end;
$fn$;

-- --------------------------------------------------------------------------
-- Child-mode reads — the only data a child session may pull
-- --------------------------------------------------------------------------
create or replace function public.child_get_space(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s public.child_sessions%rowtype;
  v_child public.child_profiles%rowtype;
  v_prefs public.child_preferences%rowtype;
begin
  v_s := kindly.assert_child_session(p_session_token, 'read_own_preferences');
  select * into v_child from public.child_profiles where id = v_s.child_id;
  select * into v_prefs from public.child_preferences where child_id = v_s.child_id;

  return jsonb_build_object(
    'child', jsonb_build_object(
      'id', v_child.id, 'child_name', v_child.child_name, 'pronouns', v_child.pronouns,
      'safe_adult', v_child.safe_adult, 'safe_place', v_child.safe_place,
      'emergency_instructions', coalesce(v_child.emergency_instructions,
        (select emergency_instructions from public.families where id = v_s.family_id))),
    'preferences', to_jsonb(v_prefs),
    'request_types', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', t.slug, 'child_facing_label', t.child_facing_label,
               'child_facing_detail', t.child_facing_detail,
               'urgency', case when t.slug = 'bathroom' and v_prefs.child_id is not null
                               then v_prefs.bathroom_urgency else t.urgency end,
               'pictogram_key', t.pictogram_key, 'pictogram_media_id', t.pictogram_media_id,
               'color_key', t.color_key, 'sort_order', t.sort_order) order by t.sort_order)
        from public.request_types t
       where t.deleted_at is null and t.is_active
         and (t.child_id = v_s.child_id
              or (t.child_id is null and t.family_id = v_s.family_id)
              or (t.child_id is null and t.family_id is null
                  and not exists (select 1 from public.request_types o
                                   where o.slug = t.slug and o.deleted_at is null
                                     and (o.child_id = v_s.child_id or o.family_id = v_s.family_id))))
      ), '[]'::jsonb),
    'trusted_caregivers', coalesce((
      select jsonb_agg(jsonb_build_object('trusted_caregiver_name', tc.trusted_caregiver_name,
                                          'escalation_order', tc.escalation_order)
                       order by tc.escalation_order)
        from public.trusted_caregivers tc
       where tc.child_id = v_s.child_id and tc.deleted_at is null and tc.is_active), '[]'::jsonb),
    'session', jsonb_build_object('id', v_s.id, 'child_id', v_s.child_id, 'expires_at', v_s.expires_at));
end;
$fn$;

create or replace function public.child_get_requests(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_s public.child_sessions%rowtype;
begin
  v_s := kindly.assert_child_session(p_session_token, 'read_own_requests');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'request', to_jsonb(r) - 'device_label' - 'client_dedupe_key',
      'response', (select to_jsonb(rr) from public.request_responses rr
                    where rr.request_id = r.id and rr.is_current limit 1))
      order by r.created_at desc)
      from public.requests r
     where r.child_id = v_s.child_id
       and (r.status not in ('resolved','cancelled') or r.updated_at > kindly.now() - interval '1 hour')
  ), '[]'::jsonb);
end;
$fn$;

create or replace function public.child_get_stories(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_s public.child_sessions%rowtype;
begin
  v_s := kindly.assert_child_session(p_session_token, 'read_assigned_stories');
  -- Approved AND assigned AND not withdrawn. Nothing else can be returned.
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'title', s.title, 'scenario_key', s.scenario_key, 'format', s.format,
      'last_page', coalesce(pr.last_page, 0),
      'pages', (select jsonb_agg(jsonb_build_object(
                         'position', p.position, 'section_key', p.section_key, 'heading', p.heading,
                         'body', p.body, 'certainty', p.certainty, 'pictogram_key', p.pictogram_key,
                         'image_media_id', p.image_media_id, 'audio_media_id', p.audio_media_id,
                         'alt_text', p.alt_text) order by p.position)
                  from public.story_pages p where p.story_id = s.id and p.deleted_at is null))
      order by a.assigned_at desc)
      from public.stories s
      join public.story_assignments a on a.story_id = s.id and a.child_id = v_s.child_id and a.withdrawn_at is null
      left join public.story_progress pr on pr.story_id = s.id and pr.child_id = v_s.child_id
     where s.status = 'approved' and s.deleted_at is null and s.archived_at is null
  ), '[]'::jsonb);
end;
$fn$;

create or replace function public.child_get_routines(p_session_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_s public.child_sessions%rowtype;
begin
  v_s := kindly.assert_child_session(p_session_token, 'read_own_routines');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'title', r.title, 'icon_key', r.icon_key, 'color_key', r.color_key,
      'schedule_label', r.schedule_label, 'allow_skip', r.allow_skip,
      'transition_warning_seconds', r.transition_warning_seconds,
      'steps', (select jsonb_agg(jsonb_build_object(
                        'id', st.id, 'position', st.position, 'title', st.title, 'detail', st.detail,
                        'pictogram_key', st.pictogram_key, 'photo_media_id', st.photo_media_id,
                        'audio_media_id', st.audio_media_id, 'is_optional', st.is_optional,
                        'plans_changed_note', st.plans_changed_note) order by st.position)
                 from public.routine_steps st where st.routine_id = r.id and st.deleted_at is null),
      'active_run', (select to_jsonb(run) from public.routine_runs run
                      where run.routine_id = r.id and run.status in ('running','paused') limit 1))
      order by r.sort_order, r.created_at)
      from public.routines r
     where r.child_id = v_s.child_id and r.deleted_at is null and r.archived_at is null
  ), '[]'::jsonb);
end;
$fn$;

create or replace function public.child_set_story_progress(p_session_token text, p_story uuid, p_page int)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_s public.child_sessions%rowtype;
begin
  v_s := kindly.assert_child_session(p_session_token, 'read_assigned_stories');
  if not exists (select 1 from public.story_assignments a
                  where a.story_id = p_story and a.child_id = v_s.child_id and a.withdrawn_at is null) then
    raise exception 'STORY_NOT_ASSIGNED';
  end if;
  insert into public.story_progress (story_id, child_id, family_id, last_page, last_opened_at)
  values (p_story, v_s.child_id, v_s.family_id, greatest(0, coalesce(p_page,0)), kindly.now())
  on conflict (story_id, child_id) do update
    set last_page = excluded.last_page, last_opened_at = excluded.last_opened_at;
end;
$fn$;

create or replace function public.child_send_story_feedback(
  p_session_token text, p_story uuid, p_kind text, p_page int default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_s public.child_sessions%rowtype;
  v_child text; v_title text; v_r record;
begin
  v_s := kindly.assert_child_session(p_session_token, 'send_story_feedback');
  perform kindly.rate_limit('story_fb:' || v_s.child_id::text, 30, interval '10 minutes');
  if p_kind not in ('this_is_different','i_have_a_question','i_need_a_break','i_do_not_want_this_story') then
    raise exception 'INVALID_FEEDBACK_KIND';
  end if;

  insert into public.story_feedback (story_id, child_id, family_id, child_session_id, page_position, kind)
  values (p_story, v_s.child_id, v_s.family_id, v_s.id, p_page, p_kind);

  select child_name into v_child from public.child_profiles where id = v_s.child_id;
  select title into v_title from public.stories where id = p_story;

  for v_r in select * from kindly.eligible_responders(v_s.family_id) loop
    insert into public.notifications (family_id, user_id, kind, title, body, story_id, child_id, route)
    values (v_s.family_id, v_r.user_id, 'child_story_feedback',
            coalesce(v_child, 'Your child') || ' told you something about a story',
            coalesce(v_title, 'A story') || ' — ' || replace(p_kind, '_', ' '),
            p_story, v_s.child_id, '/app/stories/' || p_story::text);
  end loop;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Notifications
-- --------------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.notifications
     set read_at = kindly.now()
   where user_id = auth.uid() and read_at is null
     and (p_ids is null or id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Export and deletion
-- --------------------------------------------------------------------------
create or replace function public.export_family_data(p_family uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_out jsonb;
begin
  if not kindly.has_permission(p_family, 'can_export_data') then raise exception 'NOT_PERMITTED'; end if;
  perform kindly.rate_limit('export:' || p_family::text, 5, interval '1 hour');

  select jsonb_build_object(
    'exported_at', kindly.now(),
    'family', (select to_jsonb(f) from public.families f where f.id = p_family),
    'caregivers', (select coalesce(jsonb_agg(jsonb_build_object(
                     'caregiver_name', cp.caregiver_name, 'role', fm.role,
                     'joined_at', fm.joined_at, 'revoked_at', fm.revoked_at)), '[]'::jsonb)
                    from public.family_members fm
                    left join public.caregiver_profiles cp on cp.user_id = fm.user_id
                   where fm.family_id = p_family),
    'children', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from public.child_profiles c where c.family_id = p_family),
    'child_preferences', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from public.child_preferences p where p.family_id = p_family),
    'communication_methods', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.communication_methods m where m.family_id = p_family),
    'sensory_preferences', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.sensory_preferences s where s.family_id = p_family),
    'trusted_caregivers', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.trusted_caregivers t where t.family_id = p_family),
    'escalation_rules', (select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) from public.escalation_rules e where e.family_id = p_family),
    'requests', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from public.requests r where r.family_id = p_family),
    'request_responses', (select coalesce(jsonb_agg(to_jsonb(rr)), '[]'::jsonb) from public.request_responses rr where rr.family_id = p_family),
    'request_events', (select coalesce(jsonb_agg(to_jsonb(ev)), '[]'::jsonb) from public.request_events ev where ev.family_id = p_family),
    'routines', (select coalesce(jsonb_agg(to_jsonb(ro)), '[]'::jsonb) from public.routines ro where ro.family_id = p_family),
    'routine_steps', (select coalesce(jsonb_agg(to_jsonb(rs)), '[]'::jsonb) from public.routine_steps rs where rs.family_id = p_family),
    'routine_runs', (select coalesce(jsonb_agg(to_jsonb(rn)), '[]'::jsonb) from public.routine_runs rn where rn.family_id = p_family),
    'stories', (select coalesce(jsonb_agg(to_jsonb(st)), '[]'::jsonb) from public.stories st where st.family_id = p_family),
    'story_pages', (select coalesce(jsonb_agg(to_jsonb(sp)), '[]'::jsonb) from public.story_pages sp where sp.family_id = p_family),
    'story_versions', (select coalesce(jsonb_agg(to_jsonb(sv)), '[]'::jsonb) from public.story_versions sv where sv.family_id = p_family),
    'media_assets', (select coalesce(jsonb_agg(to_jsonb(ma)), '[]'::jsonb) from public.media_assets ma where ma.family_id = p_family),
    'audit_events', (select coalesce(jsonb_agg(to_jsonb(ae)), '[]'::jsonb) from public.audit_events ae where ae.family_id = p_family)
  ) into v_out;

  perform kindly.log_audit(p_family, 'data.exported', 'family', p_family, '{}'::jsonb);
  return v_out;
end;
$fn$;

create or replace function public.request_deletion(p_scope text, p_family uuid default null, p_child uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_scope not in ('account','child','family') then raise exception 'INVALID_SCOPE'; end if;

  if p_scope = 'child' then
    if p_child is null or not kindly.has_permission(kindly.family_of_child(p_child), 'can_manage_children') then
      raise exception 'NOT_PERMITTED';
    end if;
    update public.child_profiles set deleted_at = kindly.now() where id = p_child;
    update public.child_sessions set state = 'revoked', ended_at = kindly.now() where child_id = p_child and state = 'active';
    p_family := kindly.family_of_child(p_child);
  elsif p_scope = 'family' then
    if p_family is null or kindly.member_role(p_family) <> 'owner' then raise exception 'NOT_PERMITTED'; end if;
    update public.families set deleted_at = kindly.now() where id = p_family;
  else
    update public.users set deleted_at = kindly.now() where id = auth.uid();
  end if;

  insert into public.deletion_requests (family_id, child_id, user_id, scope, requested_by)
  values (p_family, p_child, case when p_scope = 'account' then auth.uid() end, p_scope, auth.uid())
  returning id into v_id;

  perform kindly.log_audit(p_family, 'data.deletion_requested', 'deletion_request', v_id,
    jsonb_build_object('scope', p_scope));
  return v_id;
end;
$fn$;

create or replace function public.cancel_deletion(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.deletion_requests%rowtype;
begin
  select * into v_row from public.deletion_requests where id = p_id and requested_by = auth.uid();
  if not found then raise exception 'NOT_FOUND'; end if;
  if v_row.status <> 'pending' then raise exception 'ALREADY_%', upper(v_row.status); end if;

  update public.deletion_requests set status = 'cancelled' where id = p_id;
  if v_row.child_id is not null then update public.child_profiles set deleted_at = null where id = v_row.child_id; end if;
  if v_row.scope = 'family' and v_row.family_id is not null then update public.families set deleted_at = null where id = v_row.family_id; end if;
  if v_row.scope = 'account' then update public.users set deleted_at = null where id = auth.uid(); end if;

  perform kindly.log_audit(v_row.family_id, 'data.deletion_cancelled', 'deletion_request', p_id, '{}'::jsonb);
end;
$fn$;

-- Retention: audit history is kept for 24 months, then purged.
create or replace function kindly.purge_expired_audit()
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_n int;
begin
  delete from public.audit_events where occurred_at < kindly.now() - interval '24 months';
  get diagnostics v_n = row_count;
  delete from public.child_sessions where state <> 'active' and updated_at < kindly.now() - interval '90 days';
  delete from public.rate_limits where window_start < kindly.now() - interval '7 days'
    and (blocked_until is null or blocked_until < kindly.now());
  return v_n;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Realtime — child and caregiver screens stay in step
-- --------------------------------------------------------------------------
alter publication supabase_realtime add table public.requests;
alter publication supabase_realtime add table public.request_responses;
alter publication supabase_realtime add table public.request_events;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.story_assignments;
alter publication supabase_realtime add table public.routine_runs;

-- REPLICA IDENTITY FULL so that RLS-filtered realtime can evaluate old rows.
alter table public.requests            replica identity full;
alter table public.request_responses   replica identity full;
alter table public.notifications       replica identity full;
alter table public.routine_runs        replica identity full;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
do $do$
declare f text;
begin
  foreach f in array array[
    'public.create_caregiver_invitation(uuid, text, public.family_role, text, text)',
    'public.accept_caregiver_invitation(text)',
    'public.revoke_caregiver_invitation(uuid)',
    'public.revoke_caregiver_access(uuid, uuid)',
    'public.update_caregiver_role(uuid, uuid, public.family_role)',
    'public.save_story_version(uuid, text)',
    'public.approve_story(uuid, boolean)',
    'public.assign_story(uuid, uuid)',
    'public.withdraw_story(uuid, uuid)',
    'public.child_get_space(text)',
    'public.child_get_requests(text)',
    'public.child_get_stories(text)',
    'public.child_get_routines(text)',
    'public.child_set_story_progress(text, uuid, int)',
    'public.child_send_story_feedback(text, uuid, text, int)',
    'public.mark_notifications_read(uuid[])',
    'public.export_family_data(uuid)',
    'public.request_deletion(text, uuid, uuid)',
    'public.cancel_deletion(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $do$;


-- ==== 20260101001200_scheduled_jobs.sql ===========================

-- ===========================================================================
-- KINDLY 0012 — scheduled work: deletion, retention, escalation
-- ===========================================================================
-- Three things must happen whether or not anybody has KINDLY open:
--
--   1. a request nobody answers must escalate, and eventually show the child
--      offline help — otherwise a child waits with nothing to do;
--   2. data a family asked to delete must actually be destroyed once the grace
--      window closes — otherwise "delete my account" is a lie;
--   3. audit history must age out on schedule.
--
-- Until this migration, (1) ran only from a caregiver's browser and (2) was
-- documented but not implemented. Both are closed here.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. Escalation, for every family, from the server
-- --------------------------------------------------------------------------
-- public.tick_request_escalations() checks kindly.is_member(), which is correct
-- for a caregiver calling it from the app but wrong for a scheduler that has no
-- user. This is the same logic without that check, callable only by the
-- scheduler; it is NOT granted to any client role.
create or replace function kindly.sweep_all_escalations()
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_family record;
  v_total int := 0;
begin
  for v_family in
    select id from public.families where deleted_at is null
  loop
    -- Reuse the per-family logic by impersonating nobody: the function's own
    -- membership check is bypassed by calling the internal implementation.
    v_total := v_total + kindly.escalate_family(v_family.id);
  end loop;
  return v_total;
end;
$fn$;

-- The membership-free core. public.tick_request_escalations() delegates to it
-- after checking membership, so there is exactly one copy of the rules.
create or replace function kindly.escalate_family(p_family uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_req public.requests%rowtype;
  v_rule public.escalation_rules%rowtype;
  v_t public.trusted_caregivers%rowtype;
  v_elapsed int;
  v_changed int := 0;
  v_r record;
  v_child text;
begin
  for v_req in
    select * from public.requests
     where family_id = p_family
       and status in ('delivered','waiting','escalated','sending','retrying')
     order by created_at
     for update skip locked
  loop
    -- A write that was accepted but never confirmed. Never leave it hanging.
    if v_req.status in ('sending','retrying')
       and kindly.now() - coalesce(v_req.sending_started_at, v_req.created_at) > interval '60 seconds' then
      update public.requests
         set status = 'failed', failure_reason = 'interrupted', lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'delivery_failed', v_req.status, 'failed',
        'system', null, jsonb_build_object('reason','interrupted'));
      v_changed := v_changed + 1;
      continue;
    end if;

    if v_req.delivered_at is null then continue; end if;
    v_elapsed := floor(extract(epoch from (kindly.now() - v_req.delivered_at)))::int;

    select * into v_rule from public.escalation_rules
     where child_id = v_req.child_id and is_active
       and (applies_to_urgency is null or applies_to_urgency = v_req.urgency)
       and after_seconds <= v_elapsed
     order by step_order desc
     limit 1;
    if not found then continue; end if;

    select child_name into v_child from public.child_profiles where id = v_req.child_id;

    if v_rule.action = 'notify_trusted' and v_req.status = 'delivered' then
      update public.requests set status = 'waiting', waiting_since = kindly.now(), lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'status_changed', 'delivered', 'waiting',
        'system', null, jsonb_build_object('after_seconds', v_elapsed));
      v_changed := v_changed + 1;

    elsif v_rule.action in ('notify_trusted','notify_all_caregivers') and v_req.status = 'waiting' then
      select * into v_t from public.trusted_caregivers
       where child_id = v_req.child_id and deleted_at is null and is_active
         and (v_rule.trusted_caregiver_id is null or id = v_rule.trusted_caregiver_id)
       order by escalation_order limit 1;

      if found then
        update public.requests
           set status = 'escalated', escalated_at = kindly.now(),
               assigned_to_user_id = v_t.user_id, assigned_to_trusted_id = v_t.id,
               assigned_to_name = v_t.trusted_caregiver_name, lock_version = lock_version + 1
         where id = v_req.id;
        perform kindly.record_event(v_req.id, p_family, 'escalated', 'waiting', 'escalated',
          'system', null, jsonb_build_object('to', v_t.trusted_caregiver_name, 'reason', 'No answer in time'));
        for v_r in select * from kindly.eligible_responders(p_family) loop
          insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
          values (p_family, v_r.user_id, 'request_escalated',
                  'No answer yet for ' || coalesce(v_child,'your child'),
                  'The request "' || v_req.child_facing_label || '" was passed to ' || v_t.trusted_caregiver_name || '.',
                  v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text, v_req.urgency = 'urgent');
        end loop;
      else
        update public.requests set status = 'unavailable', unavailable_at = kindly.now(), lock_version = lock_version + 1
         where id = v_req.id;
        perform kindly.record_event(v_req.id, p_family, 'status_changed', 'waiting', 'unavailable',
          'system', null, jsonb_build_object('reason','no_trusted_caregiver'));
      end if;
      v_changed := v_changed + 1;

    elsif v_rule.action = 'show_offline_help' and v_req.status in ('waiting','escalated') then
      update public.requests set status = 'unavailable', unavailable_at = kindly.now(), lock_version = lock_version + 1
       where id = v_req.id;
      perform kindly.record_event(v_req.id, p_family, 'status_changed', v_req.status, 'unavailable',
        'system', null, jsonb_build_object('after_seconds', v_elapsed));
      for v_r in select * from kindly.eligible_responders(p_family) loop
        insert into public.notifications (family_id, user_id, kind, title, body, request_id, child_id, route, is_urgent)
        values (p_family, v_r.user_id, 'request_unanswered',
                'Still no answer for ' || coalesce(v_child,'your child'),
                'KINDLY has shown offline help. Please check on them.',
                v_req.id, v_req.child_id, '/app/requests/' || v_req.id::text, true);
      end loop;
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$fn$;

-- The client-facing wrapper now delegates, so the rules exist in one place only.
create or replace function public.tick_request_escalations(p_family uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  return kindly.escalate_family(p_family);
end;
$fn$;

revoke all on function public.tick_request_escalations(uuid) from public, anon;
grant execute on function public.tick_request_escalations(uuid) to authenticated;
revoke all on function kindly.sweep_all_escalations() from public, anon, authenticated;
revoke all on function kindly.escalate_family(uuid) from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- 2. Deletion: actually destroy data once the grace window closes
-- --------------------------------------------------------------------------
-- `request_deletion()` soft-deletes immediately and sets effective_at seven days
-- out, so an accidental deletion can be undone. This is the other half: after
-- that window, the data is really gone.
create or replace function kindly.run_pending_deletions()
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.deletion_requests%rowtype;
  v_done int := 0;
begin
  for v_row in
    select * from public.deletion_requests
     where status = 'pending' and effective_at <= kindly.now()
     order by effective_at
     for update skip locked
  loop
    if v_row.scope = 'child' and v_row.child_id is not null then
      -- ON DELETE CASCADE carries away preferences, communication methods,
      -- sensory notes, trusted caregivers, escalation rules, requests (and
      -- their responses and events), routines, runs, stories, pages, progress
      -- and feedback. Media rows go too; the objects are removed below.
      delete from public.child_profiles where id = v_row.child_id;

    elsif v_row.scope = 'family' and v_row.family_id is not null then
      delete from public.families where id = v_row.family_id;

    elsif v_row.scope = 'account' and v_row.user_id is not null then
      -- Families this person solely owns go with them; families with another
      -- owner keep working, and their membership is simply removed.
      delete from public.families f
       where f.created_by = v_row.user_id
         and not exists (
           select 1 from public.family_members fm
            where fm.family_id = f.id and fm.user_id <> v_row.user_id
              and fm.role = 'owner' and fm.revoked_at is null);
      delete from auth.users where id = v_row.user_id;
    end if;

    update public.deletion_requests
       set status = 'completed', completed_at = kindly.now()
     where id = v_row.id;

    -- The audit entry deliberately outlives the data: it records that a
    -- deletion happened, and carries no personal content.
    perform kindly.log_audit(v_row.family_id, 'data.deletion_completed',
      'deletion_request', v_row.id, jsonb_build_object('scope', v_row.scope), 'system');

    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$fn$;

comment on function kindly.run_pending_deletions() is
  'Hard-deletes data whose seven-day grace window has closed. Without this scheduled, an erasure request cannot be honoured in full.';

-- Storage objects are not reachable by ON DELETE CASCADE, so orphaned media is
-- collected separately. Returns the paths for the caller to remove from the
-- bucket; the rows themselves are already gone.
create or replace function kindly.orphaned_media_paths()
returns setof text
language sql
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'kindly-media'
     and not exists (
       select 1 from public.media_assets m where m.storage_path = o.name);
$$;

revoke all on function kindly.run_pending_deletions() from public, anon, authenticated;
revoke all on function kindly.orphaned_media_paths() from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- 3. Scheduling
-- --------------------------------------------------------------------------
-- pg_cron is available on Supabase but must be enabled per project. Wrapped so
-- that a local stack without the extension still applies this migration.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Escalation every 15 seconds. pg_cron takes a 5-field cron expression or
    -- an interval string; the interval form is what sub-minute work needs.
    perform cron.unschedule('kindly-escalations')
      where exists (select 1 from cron.job where jobname = 'kindly-escalations');
    perform cron.schedule('kindly-escalations', '15 seconds',
      $job$ select kindly.sweep_all_escalations(); $job$);

    -- Deletions and retention, nightly at 03:10 UTC.
    perform cron.unschedule('kindly-deletions')
      where exists (select 1 from cron.job where jobname = 'kindly-deletions');
    perform cron.schedule('kindly-deletions', '10 3 * * *',
      $job$ select kindly.run_pending_deletions(); $job$);

    perform cron.unschedule('kindly-retention')
      where exists (select 1 from cron.job where jobname = 'kindly-retention');
    perform cron.schedule('kindly-retention', '20 3 * * *',
      $job$ select kindly.purge_expired_audit(); $job$);

    raise notice 'KINDLY scheduled jobs installed.';
  else
    raise warning 'pg_cron is not available. Escalation will only run while a caregiver has KINDLY open, and deletions will not complete. See docs/limitations-and-safety.md.';
  end if;
end
$do$;


commit;

-- ==== 20260101001300_mandatory_adult_code.sql ==================

-- ===========================================================================
-- KINDLY 0013 — the grown-up code is mandatory
-- ===========================================================================
-- Three problems, one cause.
--
--   1. Onboarding let a caregiver skip the code.
--   2. The adult check still appeared for those families, asking for a code
--      that had never been set.
--   3. Worse, verify_caregiver_pin() FAILED OPEN: with no row in
--      caregiver_pins it returned ok=true for any code at all. The screen
--      looked like a lock and was not one.
--
-- A family space always contains a child's private communication, so the adult
-- check is not an optional extra. Every family now has a code.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. Verification no longer fails open
-- --------------------------------------------------------------------------
create or replace function public.verify_caregiver_pin(p_family uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.caregiver_pins%rowtype;
  v_ok  boolean;
  v_now timestamptz := kindly.now();
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;

  perform kindly.rate_limit('pin:' || p_family::text, 10, interval '15 minutes', interval '15 minutes');

  select * into v_row from public.caregiver_pins where family_id = p_family for update;

  -- No code configured. Previously this returned ok=true, which meant the adult
  -- check accepted anything. Say so honestly instead and let the caller send
  -- the caregiver somewhere useful.
  if not found or v_row.pin_hash is null or v_row.pin_hash = 'disabled' then
    return jsonb_build_object('ok', false, 'mode', 'not_configured');
  end if;

  if v_row.verification_mode = 'device_biometric' then
    return jsonb_build_object('ok', false, 'mode', 'device_biometric');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('ok', false, 'locked_until', v_row.locked_until, 'mode', v_row.verification_mode);
  end if;

  v_ok := (extensions.crypt(coalesce(p_pin, ''), v_row.pin_hash) = v_row.pin_hash);

  if v_ok then
    update public.caregiver_pins set failed_attempts = 0, locked_until = null where family_id = p_family;
  else
    update public.caregiver_pins
       set failed_attempts = v_row.failed_attempts + 1,
           locked_until = case when v_row.failed_attempts + 1 >= 5 then v_now + interval '5 minutes' else null end
     where family_id = p_family;
    perform kindly.log_audit(p_family, 'security.pin_failed', 'family', p_family,
      jsonb_build_object('attempt', v_row.failed_attempts + 1));
  end if;

  return jsonb_build_object('ok', v_ok, 'mode', v_row.verification_mode,
                            'attempts_remaining', greatest(0, 5 - (v_row.failed_attempts + case when v_ok then 0 else 1 end)));
end;
$fn$;

-- --------------------------------------------------------------------------
-- 2. Let a client learn whether a code exists, without exposing the hash
-- --------------------------------------------------------------------------
-- caregiver_pins has no client policy, so the app cannot select from it at all.
-- It still needs to know whether a code is configured, to decide what the adult
-- check should show. This returns that one fact and nothing else.
create or replace function public.get_adult_verification(p_family uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.caregiver_pins%rowtype;
begin
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  select * into v_row from public.caregiver_pins where family_id = p_family;
  return jsonb_build_object(
    'mode', coalesce(v_row.verification_mode, 'pin'),
    'is_configured', found and v_row.pin_hash is not null and v_row.pin_hash <> 'disabled',
    'locked_until', v_row.locked_until);
end;
$fn$;

-- --------------------------------------------------------------------------
-- 3. The code cannot be switched off
-- --------------------------------------------------------------------------
create or replace function public.set_adult_verification_mode(p_family uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.has_permission(p_family, 'can_manage_safety') then raise exception 'NOT_PERMITTED'; end if;
  -- 'none' is deliberately no longer accepted: a family space holds a child's
  -- private communication, and leaving the adult view unlocked is not a setting
  -- KINDLY offers. A family may choose *how* to verify, not whether.
  if p_mode not in ('pin', 'device_biometric') then raise exception 'INVALID_VERIFICATION_MODE'; end if;

  update public.caregiver_pins set verification_mode = p_mode where family_id = p_family;
  if not found then raise exception 'SET_A_CODE_FIRST'; end if;

  perform kindly.log_audit(p_family, 'security.verification_mode', 'family', p_family,
    jsonb_build_object('mode', p_mode));
end;
$fn$;

-- --------------------------------------------------------------------------
-- 4. A family cannot be created without one
-- --------------------------------------------------------------------------
create or replace function public.bootstrap_family(
  p_caregiver_name text,
  p_child_name     text,
  p_family_name    text default null,
  p_trusted_caregiver_name text default null,
  p_pin            text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_cg   text := kindly.normalize_name(p_caregiver_name);
  v_ch   text := kindly.normalize_name(p_child_name);
  v_tr   text := kindly.normalize_name(p_trusted_caregiver_name);
  v_fam  uuid;
  v_child uuid;
  v_profile uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if v_cg is null then raise exception 'CAREGIVER_NAME_REQUIRED'; end if;
  if v_ch is null then raise exception 'CHILD_NAME_REQUIRED'; end if;
  -- The code is required, not optional. Without it the adult check has nothing
  -- to check against.
  if p_pin is null then raise exception 'PIN_REQUIRED'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;

  perform kindly.rate_limit('bootstrap:' || v_user::text, 5, interval '1 hour');

  insert into public.users (id, email)
  select v_user, coalesce(au.email, 'unknown@invalid')
    from auth.users au where au.id = v_user
  on conflict (id) do nothing;

  insert into public.caregiver_profiles (user_id, caregiver_name, onboarding_stage)
  values (v_user, v_cg, 'preferences')
  on conflict (user_id) do update set caregiver_name = excluded.caregiver_name
  returning id into v_profile;

  insert into public.families (family_name, created_by)
  values (coalesce(kindly.normalize_name(p_family_name), v_cg || ' + ' || v_ch), v_user)
  returning id into v_fam;

  insert into public.family_members (family_id, user_id, role)
  values (v_fam, v_user, 'owner');

  insert into public.child_profiles (family_id, child_name, created_by)
  values (v_fam, v_ch, v_user)
  returning id into v_child;

  insert into public.child_preferences (child_id, family_id, updated_by)
  values (v_child, v_fam, v_user);

  insert into public.notification_preferences (user_id, family_id)
  values (v_user, v_fam) on conflict do nothing;

  if v_tr is not null then
    insert into public.trusted_caregivers
      (family_id, child_id, trusted_caregiver_name, escalation_order, created_by)
    values (v_fam, v_child, v_tr, 1, v_user);
  end if;

  insert into public.escalation_rules (child_id, family_id, applies_to_urgency, step_order, action, after_seconds)
  values
    (v_child, v_fam, null, 1, 'notify_trusted',       120),
    (v_child, v_fam, null, 2, 'notify_all_caregivers',240),
    (v_child, v_fam, null, 3, 'show_offline_help',    360);

  perform public.set_caregiver_pin(v_fam, p_pin);

  perform kindly.log_audit(v_fam, 'family.bootstrap', 'family', v_fam,
    jsonb_build_object('child_id', v_child, 'has_trusted', v_tr is not null));

  return jsonb_build_object(
    'family_id', v_fam, 'child_id', v_child, 'caregiver_profile_id', v_profile);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
revoke all on function public.get_adult_verification(uuid) from public, anon;
grant execute on function public.get_adult_verification(uuid) to authenticated;
revoke all on function public.verify_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.verify_caregiver_pin(uuid, text) to authenticated;
revoke all on function public.set_adult_verification_mode(uuid, text) from public, anon;
grant execute on function public.set_adult_verification_mode(uuid, text) to authenticated;
revoke all on function public.bootstrap_family(text, text, text, text, text) from public, anon;
grant execute on function public.bootstrap_family(text, text, text, text, text) to authenticated;
