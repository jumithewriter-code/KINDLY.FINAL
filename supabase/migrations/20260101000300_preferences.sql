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
