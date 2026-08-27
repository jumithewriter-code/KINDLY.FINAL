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
