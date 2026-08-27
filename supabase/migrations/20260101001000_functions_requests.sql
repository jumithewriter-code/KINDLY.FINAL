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
    -- The cast is required: a CASE over string literals resolves to text,
    -- and Postgres will not implicitly cast text to an enum in function
    -- resolution (a bare literal would have been fine).
    (case when v_to = 'retrying' then 'retry_attempted' else 'status_changed' end)::public.request_event_kind,
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
