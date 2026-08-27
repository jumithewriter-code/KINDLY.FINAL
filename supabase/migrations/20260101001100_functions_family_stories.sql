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
