-- ===========================================================================
-- KINDLY 0013 — the grown-up code is mandatory
-- ===========================================================================
-- Three problems, one cause.
--
--   1. Onboarding let a caregiver skip the code.
--   2. The adult check still appeared for those families, asking for a code
--      that had never been set.
--   3. Worse, verify_caregiver_pin() FAILED OPEN: with no row in
--      caregiver_pins it returned ok=true for any code at all. The screen
--      looked like a lock and was not one.
--
-- A family space always contains a child's private communication, so the adult
-- check is not an optional extra. Every family now has a code.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. Verification no longer fails open
-- --------------------------------------------------------------------------
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

  perform kindly.rate_limit('pin:' || p_family::text, 10, interval '15 minutes', interval '15 minutes');

  select * into v_row from public.caregiver_pins where family_id = p_family for update;

  -- No code configured. Previously this returned ok=true, which meant the adult
  -- check accepted anything. Say so honestly instead and let the caller send
  -- the caregiver somewhere useful.
  if not found or v_row.pin_hash is null or v_row.pin_hash = 'disabled' then
    return jsonb_build_object('ok', false, 'mode', 'not_configured');
  end if;

  if v_row.verification_mode = 'device_biometric' then
    return jsonb_build_object('ok', false, 'mode', 'device_biometric');
  end if;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('ok', false, 'locked_until', v_row.locked_until, 'mode', v_row.verification_mode);
  end if;

  v_ok := (extensions.crypt(coalesce(p_pin, ''), v_row.pin_hash) = v_row.pin_hash);

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
-- 2. Let a client learn whether a code exists, without exposing the hash
-- --------------------------------------------------------------------------
-- caregiver_pins has no client policy, so the app cannot select from it at all.
-- It still needs to know whether a code is configured, to decide what the adult
-- check should show. This returns that one fact and nothing else.
create or replace function public.get_adult_verification(p_family uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_row public.caregiver_pins%rowtype;
begin
  if not kindly.is_member(p_family) then raise exception 'NOT_A_FAMILY_MEMBER'; end if;
  select * into v_row from public.caregiver_pins where family_id = p_family;
  return jsonb_build_object(
    'mode', coalesce(v_row.verification_mode, 'pin'),
    'is_configured', found and v_row.pin_hash is not null and v_row.pin_hash <> 'disabled',
    'locked_until', v_row.locked_until);
end;
$fn$;

-- --------------------------------------------------------------------------
-- 3. The code cannot be switched off
-- --------------------------------------------------------------------------
create or replace function public.set_adult_verification_mode(p_family uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not kindly.has_permission(p_family, 'can_manage_safety') then raise exception 'NOT_PERMITTED'; end if;
  -- 'none' is deliberately no longer accepted: a family space holds a child's
  -- private communication, and leaving the adult view unlocked is not a setting
  -- KINDLY offers. A family may choose *how* to verify, not whether.
  if p_mode not in ('pin', 'device_biometric') then raise exception 'INVALID_VERIFICATION_MODE'; end if;

  update public.caregiver_pins set verification_mode = p_mode where family_id = p_family;
  if not found then raise exception 'SET_A_CODE_FIRST'; end if;

  perform kindly.log_audit(p_family, 'security.verification_mode', 'family', p_family,
    jsonb_build_object('mode', p_mode));
end;
$fn$;

-- --------------------------------------------------------------------------
-- 4. A family cannot be created without one
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
  -- The code is required, not optional. Without it the adult check has nothing
  -- to check against.
  if p_pin is null then raise exception 'PIN_REQUIRED'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN_MUST_BE_4_TO_8_DIGITS'; end if;

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

  if v_tr is not null then
    insert into public.trusted_caregivers
      (family_id, child_id, trusted_caregiver_name, escalation_order, created_by)
    values (v_fam, v_child, v_tr, 1, v_user);
  end if;

  insert into public.escalation_rules (child_id, family_id, applies_to_urgency, step_order, action, after_seconds)
  values
    (v_child, v_fam, null, 1, 'notify_trusted',       120),
    (v_child, v_fam, null, 2, 'notify_all_caregivers',240),
    (v_child, v_fam, null, 3, 'show_offline_help',    360);

  perform public.set_caregiver_pin(v_fam, p_pin);

  perform kindly.log_audit(v_fam, 'family.bootstrap', 'family', v_fam,
    jsonb_build_object('child_id', v_child, 'has_trusted', v_tr is not null));

  return jsonb_build_object(
    'family_id', v_fam, 'child_id', v_child, 'caregiver_profile_id', v_profile);
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
revoke all on function public.get_adult_verification(uuid) from public, anon;
grant execute on function public.get_adult_verification(uuid) to authenticated;
revoke all on function public.verify_caregiver_pin(uuid, text) from public, anon;
grant execute on function public.verify_caregiver_pin(uuid, text) to authenticated;
revoke all on function public.set_adult_verification_mode(uuid, text) from public, anon;
grant execute on function public.set_adult_verification_mode(uuid, text) to authenticated;
revoke all on function public.bootstrap_family(text, text, text, text, text) from public, anon;
grant execute on function public.bootstrap_family(text, text, text, text, text) to authenticated;
