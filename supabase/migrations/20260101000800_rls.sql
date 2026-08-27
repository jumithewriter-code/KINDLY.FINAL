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
