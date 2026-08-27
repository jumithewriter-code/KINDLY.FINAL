-- ===========================================================================
-- KINDLY patch 01 — fix child_send_request
-- ===========================================================================
-- A CASE expression over string literals resolves to `text`, and Postgres will
-- not implicitly cast text to an enum when resolving a function call. The call
-- to kindly.record_event() therefore failed to find a matching signature, and
-- no request could be sent.
--
-- Safe to run on the schema you already applied: it only replaces one function.
-- ===========================================================================

begin;

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

revoke all on function public.child_send_request(text, uuid, text) from public, anon;
grant execute on function public.child_send_request(text, uuid, text) to authenticated;

commit;
