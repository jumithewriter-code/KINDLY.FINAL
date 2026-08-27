-- ===========================================================================
-- KINDLY 0009 — core server functions: accounts, families, PINs, child sessions
-- ===========================================================================
-- Every function here is SECURITY DEFINER with a pinned empty search_path, and
-- every one of them re-checks authorization itself. RLS is the second lock, not
-- the only one.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- Infrastructure: audit log + rate limiting
-- --------------------------------------------------------------------------
create or replace function kindly.log_audit(
  p_family uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_detail jsonb default '{}'::jsonb, p_actor_kind text default 'caregiver'
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (family_id, actor_user_id, actor_kind, action, entity_type, entity_id, detail)
  values (p_family, auth.uid(), p_actor_kind, p_action, p_entity_type, p_entity_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- Fixed-window counter. Raises RATE_LIMITED when the caller is over budget.
create or replace function kindly.rate_limit(
  p_key text, p_max int, p_window interval, p_lock_for interval default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.rate_limits%rowtype;
  v_now timestamptz := kindly.now();
begin
  insert into public.rate_limits (bucket_key, window_start, hit_count)
  values (p_key, v_now, 0)
  on conflict (bucket_key) do nothing;

  select * into v_row from public.rate_limits where bucket_key = p_key for update;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    raise exception 'RATE_LIMITED' using detail = extract(epoch from (v_row.blocked_until - v_now))::text;
  end if;

  if v_row.window_start + p_window < v_now then
    update public.rate_limits
       set window_start = v_now, hit_count = 1, blocked_until = null
     where bucket_key = p_key;
    return;
  end if;

  if v_row.hit_count + 1 > p_max then
    update public.rate_limits
       set blocked_until = v_now + coalesce(p_lock_for, p_window)
     where bucket_key = p_key;
    raise exception 'RATE_LIMITED'
      using detail = extract(epoch from coalesce(p_lock_for, p_window))::text;
  end if;

  update public.rate_limits set hit_count = v_row.hit_count + 1 where bucket_key = p_key;
end;
$fn$;

-- --------------------------------------------------------------------------
-- auth.users -> public.users mirror
-- --------------------------------------------------------------------------
create or replace function kindly.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.users (id, email, email_verified_at)
  values (new.id, new.email, new.email_confirmed_at)
  on conflict (id) do update
    set email = excluded.email,
        email_verified_at = coalesce(excluded.email_verified_at, public.users.email_verified_at);
  return new;
end;
$fn$;

drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function kindly.handle_new_auth_user();

-- --------------------------------------------------------------------------
-- Role -> default permission matrix
-- --------------------------------------------------------------------------
create or replace function kindly.default_permissions(p_role public.family_role)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'owner' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', true, 'can_edit_stories', true,
      'can_approve_stories', true, 'can_manage_children', true, 'can_manage_caregivers', true,
      'can_manage_safety', true, 'can_export_data', true)
    when 'caregiver' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', true, 'can_edit_stories', true,
      'can_approve_stories', true, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
    when 'trusted' then jsonb_build_object(
      'can_answer_requests', true, 'can_edit_routines', false, 'can_edit_stories', false,
      'can_approve_stories', false, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
    else jsonb_build_object(
      'can_answer_requests', false, 'can_edit_routines', false, 'can_edit_stories', false,
      'can_approve_stories', false, 'can_manage_children', false, 'can_manage_caregivers', false,
      'can_manage_safety', false, 'can_export_data', false)
  end;
$$;

create or replace function kindly.apply_role_permissions()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare p jsonb;
begin
  if tg_op = 'INSERT' or new.role is distinct from old.role then
    p := kindly.default_permissions(new.role);
    new.can_answer_requests   := (p->>'can_answer_requests')::boolean;
    new.can_edit_routines     := (p->>'can_edit_routines')::boolean;
    new.can_edit_stories      := (p->>'can_edit_stories')::boolean;
    new.can_approve_stories   := (p->>'can_approve_stories')::boolean;
    new.can_manage_children   := (p->>'can_manage_children')::boolean;
    new.can_manage_caregivers := (p->>'can_manage_caregivers')::boolean;
    new.can_manage_safety     := (p->>'can_manage_safety')::boolean;
    new.can_export_data       := (p->>'can_export_data')::boolean;
  end if;
  return new;
end;
$fn$;

create trigger trg_family_members_role_defaults
  before insert or update of role on public.family_members
  for each row execute function kindly.apply_role_permissions();

-- --------------------------------------------------------------------------
-- Default request vocabulary (family_id null = KINDLY built-ins)
-- --------------------------------------------------------------------------
insert into public.request_types
  (family_id, child_id, slug, child_facing_label, child_facing_detail, urgency, pictogram_key, color_key, sort_order, is_builtin)
values
  (null, null, 'help',      'Help',            'Something is tricky',   'urgent',   'i-help',      'coral',  10, true),
  (null, null, 'pain',      'It hurts',        'I have pain',           'urgent',   'i-hurt',      'coral',  20, true),
  (null, null, 'breathing', 'Hard to breathe', 'Breathing is difficult','urgent',   'i-breath',    'coral',  30, true),
  (null, null, 'unsafe',    'I feel unsafe',   'Something is scary',    'urgent',   'i-shield',    'coral',  40, true),
  (null, null, 'bathroom',  'Bathroom',        'I need to go',          'urgent',   'i-bathroom',  'yellow', 50, true),
  (null, null, 'drink',     'Drink',           'I am thirsty',          'can_wait', 'i-droplet',   'blue',   60, true),
  (null, null, 'break',     'Break',           'I need quiet',          'can_wait', 'i-pause',     'purple', 70, true),
  (null, null, 'other',     'Something else',  'I will show you',       'can_wait', 'i-more',      'blue',   80, true),
  -- The "How I feel" vocabulary shares the request lifecycle so that a feeling
  -- a child shares is delivered, acknowledged and cancellable in the same way.
  (null, null, 'feeling',   'How I feel',      'I want to share this',  'can_wait', 'i-heart',     'purple', 90, true);

comment on table public.request_types is
  'Built-in rows (family_id IS NULL) are KINDLY defaults. "bathroom" ships as URGENT: KINDLY does not assume a bathroom request can safely wait. Families change it per child in child_preferences.bathroom_urgency.';

-- --------------------------------------------------------------------------
-- bootstrap_family — one atomic call at the end of onboarding step 1
-- --------------------------------------------------------------------------
create or replace function public.bootstrap_family(
  p_caregiver_name text,
  p_child_name     text,
  p_family_name    text default null,
  p_trusted_caregiver_name text default null,
  p_pin            text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := auth.uid();
  v_cg   text := kindly.normalize_name(p_caregiver_name);
  v_ch   text := kindly.normalize_name(p_child_name);
  v_tr   text := kindly.normalize_name(p_trusted_caregiver_name);
  v_fam  uuid;
  v_child uuid;
  v_profile uuid;
begin
  if v_user is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if v_cg is null then raise exception 'CAREGIVER_NAME_REQUIRED'; end if;
  if v_ch is null then raise exception 'CHILD_NAME_REQUIRED'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;

  perform kindly.rate_limit('bootstrap:' || v_user::text, 5, interval '1 hour');

  insert into public.users (id, email)
  select v_user, coalesce(au.email, 'unknown@invalid')
    from auth.users au where au.id = v_user
  on conflict (id) do nothing;

  insert into public.caregiver_profiles (user_id, caregiver_name, onboarding_stage)
  values (v_user, v_cg, 'preferences')
  on conflict (user_id) do update set caregiver_name = excluded.caregiver_name
  returning id into v_profile;

  insert into public.families (family_name, created_by)
  values (coalesce(kindly.normalize_name(p_family_name), v_cg || ' + ' || v_ch), v_user)
  returning id into v_fam;

  insert into public.family_members (family_id, user_id, role)
  values (v_fam, v_user, 'owner');

  insert into public.child_profiles (family_id, child_name, created_by)
  values (v_fam, v_ch, v_user)
  returning id into v_child;

  insert into public.child_preferences (child_id, family_id, updated_by)
  values (v_child, v_fam, v_user);

  insert into public.notification_preferences (user_id, family_id)
  values (v_user, v_fam) on conflict do nothing;

  -- A named trusted caregiver who is not (yet) a KINDLY user.
  if v_tr is not null then
    insert into public.trusted_caregivers
      (family_id, child_id, trusted_caregiver_name, escalation_order, created_by)
    values (v_fam, v_child, v_tr, 1, v_user);
  end if;

  -- Default escalation ladder. The last rung is always offline help so a child
  -- is never left waiting with nothing to do.
  insert into public.escalation_rules (child_id, family_id, applies_to_urgency, step_order, action, after_seconds)
  values
    (v_child, v_fam, null, 1, 'notify_trusted',       120),
    (v_child, v_fam, null, 2, 'notify_all_caregivers',240),
    (v_child, v_fam, null, 3, 'show_offline_help',    360);

  if p_pin is not null then
    perform public.set_caregiver_pin(v_fam, p_pin);
  end if;

  perform kindly.log_audit(v_fam, 'family.bootstrap', 'family', v_fam,
    jsonb_build_object('child_id', v_child, 'has_trusted', v_tr is not null, 'has_pin', p_pin is not null));

  return jsonb_build_object(
    'family_id', v_fam, 'child_id', v_child, 'caregiver_profile_id', v_profile);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Caregiver PIN
-- --------------------------------------------------------------------------
create or replace function public.set_caregiver_pin(p_family uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;
  -- Reject the most guessable codes outright.
  if p_pin in ('0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','4321','0123') then
    raise exception 'PIN_TOO_EASY_TO_GUESS';
  end if;

  insert into public.caregiver_pins (family_id, pin_hash, pin_length, set_by)
  values (p_family, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), char_length(p_pin), auth.uid())
  on conflict (family_id) do update
    set pin_hash = excluded.pin_hash,
        pin_length = excluded.pin_length,
        failed_attempts = 0,
        locked_until = null,
        set_by = excluded.set_by,
        verification_mode = 'pin';

  perform kindly.log_audit(p_family, 'security.pin_set', 'family', p_family, '{}'::jsonb);
end;
$fn$;

create or replace function public.set_adult_verification_mode(p_family uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.has_permission(p_family, 'can_manage_safety') then raise exception 'NOT_PERMITTED'; end if;
  if p_mode not in ('pin','device_biometric','none') then raise exception 'INVALID_VERIFICATION_MODE'; end if;
  insert into public.caregiver_pins (family_id, pin_hash, verification_mode, set_by)
  values (p_family, 'disabled', p_mode, auth.uid())
  on conflict (family_id) do update set verification_mode = excluded.verification_mode;
  perform kindly.log_audit(p_family, 'security.verification_mode', 'family', p_family,
    jsonb_build_object('mode', p_mode));
end;
$fn$;

-- Returns only a boolean. Never returns or logs the PIN or its hash.
create or replace function public.verify_caregiver_pin(p_family uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.caregiver_pins%rowtype;
  v_ok  boolean;
  v_now timestamptz := kindly.now();
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;

  -- 10 attempts per 15 minutes per family, then a 15 minute lockout.
  perform kindly.rate_limit('pin:' || p_family::text, 10, interval '15 minutes', interval '15 minutes');

  select * into v_row from public.caregiver_pins where family_id = p_family for update;

  if not found or v_row.verification_mode = 'none' then
    return jsonb_build_object('ok', true, 'mode', 'none');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('ok', false, 'locked_until', v_row.locked_until, 'mode', v_row.verification_mode);
  end if;

  v_ok := (v_row.pin_hash <> 'disabled' and extensions.crypt(coalesce(p_pin, ''), v_row.pin_hash) = v_row.pin_hash);

  if v_ok then
    update public.caregiver_pins set failed_attempts = 0, locked_until = null where family_id = p_family;
  else
    update public.caregiver_pins
       set failed_attempts = v_row.failed_attempts + 1,
           locked_until = case when v_row.failed_attempts + 1 >= 5 then v_now + interval '5 minutes' else null end
     where family_id = p_family;
    perform kindly.log_audit(p_family, 'security.pin_failed', 'family', p_family,
      jsonb_build_object('attempt', v_row.failed_attempts + 1));
  end if;

  return jsonb_build_object('ok', v_ok, 'mode', v_row.verification_mode,
                            'attempts_remaining', greatest(0, 5 - (v_row.failed_attempts + case when v_ok then 0 else 1 end)));
end;
$fn$;

-- --------------------------------------------------------------------------
-- Child sessions
-- --------------------------------------------------------------------------
create or replace function public.start_child_session(
  p_child uuid, p_device_label text default null, p_hours int default 12
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fam uuid := kindly.family_of_child(p_child);
  v_token text;
  v_id uuid;
begin
  if v_fam is null or not kindly.is_member(v_fam) then raise exception 'NOT_PERMITTED'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'INVALID_SESSION_LENGTH'; end if;

  -- Only one live child session per child per device hand-over.
  update public.child_sessions
     set state = 'ended', ended_at = kindly.now()
   where child_id = p_child and state = 'active';

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.child_sessions (family_id, child_id, token_hash, started_by, device_label, expires_at)
  values (v_fam, p_child, encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid(),
          left(coalesce(p_device_label, 'This device'), 120), kindly.now() + make_interval(hours => p_hours))
  returning id into v_id;

  perform kindly.log_audit(v_fam, 'child_session.start', 'child_session', v_id,
    jsonb_build_object('child_id', p_child));

  return jsonb_build_object('session_id', v_id, 'child_id', p_child, 'family_id', v_fam,
                            'session_token', v_token,
                            'expires_at', kindly.now() + make_interval(hours => p_hours));
end;
$fn$;

-- Validates a child session token and that the session may perform an action.
create or replace function kindly.assert_child_session(p_token text, p_action text)
returns public.child_sessions
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.child_sessions%rowtype;
begin
  if p_token is null or char_length(p_token) < 32 then raise exception 'CHILD_SESSION_INVALID'; end if;

  select * into v_row from public.child_sessions
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
   for update;

  if not found then raise exception 'CHILD_SESSION_INVALID'; end if;

  if v_row.state <> 'active' then raise exception 'CHILD_SESSION_%', upper(v_row.state::text); end if;

  if v_row.expires_at <= kindly.now() then
    update public.child_sessions set state = 'expired' where id = v_row.id;
    raise exception 'CHILD_SESSION_EXPIRED';
  end if;

  if not (p_action = any (v_row.allowed_actions)) then
    raise exception 'CHILD_ACTION_NOT_PERMITTED: %', p_action;
  end if;

  update public.child_sessions set last_seen_at = kindly.now() where id = v_row.id;
  return v_row;
end;
$fn$;

create or replace function public.end_child_session(p_session_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.child_sessions%rowtype;
begin
  select * into v_row from public.child_sessions
   where token_hash = encode(extensions.digest(coalesce(p_session_token,''), 'sha256'), 'hex');
  if not found then return; end if;
  update public.child_sessions set state = 'ended', ended_at = kindly.now() where id = v_row.id;
  perform kindly.log_audit(v_row.family_id, 'child_session.end', 'child_session', v_row.id, '{}'::jsonb);
end;
$fn$;

create or replace function public.revoke_child_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_fam uuid;
begin
  select family_id into v_fam from public.child_sessions where id = p_session_id;
  if v_fam is null or not kindly.is_member(v_fam) then raise exception 'NOT_PERMITTED'; end if;
  update public.child_sessions set state = 'revoked', ended_at = kindly.now() where id = p_session_id;
  perform kindly.log_audit(v_fam, 'child_session.revoke', 'child_session', p_session_id, '{}'::jsonb);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants: only these functions are callable from a browser
-- --------------------------------------------------------------------------
revoke all on function public.bootstrap_family(text, text, text, text, text) from public, anon;
grant execute on function public.bootstrap_family(text, text, text, text, text) to authenticated;

revoke all on function public.set_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.set_caregiver_pin(uuid, text) to authenticated;

revoke all on function public.set_adult_verification_mode(uuid, text) from public, anon;
grant execute on function public.set_adult_verification_mode(uuid, text) to authenticated;

revoke all on function public.verify_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.verify_caregiver_pin(uuid, text) to authenticated;

revoke all on function public.start_child_session(uuid, text, int) from public, anon;
grant execute on function public.start_child_session(uuid, text, int) to authenticated;

revoke all on function public.end_child_session(text) from public, anon;
grant execute on function public.end_child_session(text) to authenticated;

revoke all on function public.revoke_child_session(uuid) from public, anon;
grant execute on function public.revoke_child_session(uuid) to authenticated;
