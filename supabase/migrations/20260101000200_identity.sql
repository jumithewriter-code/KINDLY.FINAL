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
