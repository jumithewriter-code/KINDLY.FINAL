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
