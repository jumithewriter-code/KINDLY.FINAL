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
