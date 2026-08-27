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
