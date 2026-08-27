-- ===========================================================================
-- KINDLY seed / demo data  (LOCAL DEVELOPMENT ONLY)
-- ===========================================================================
-- Run automatically by `supabase db reset`.
--
-- The names below are DEMO DATA, entered the same way a real family would enter
-- them. Nothing in the application code contains a hardcoded person: every name
-- shown in the UI is read from caregiver_profiles.caregiver_name,
-- child_profiles.child_name or trusted_caregivers.trusted_caregiver_name.
--
-- The two demo sign-ins are:
--   rosa@example.test   / kindly-demo-1  (owner caregiver)
--   marcus@example.test / kindly-demo-1  (second caregiver)
-- ===========================================================================

do $seed$
declare
  v_owner   uuid := '11111111-1111-4111-8111-111111111111';
  v_second  uuid := '22222222-2222-4222-8222-222222222222';
  v_family  uuid;
  v_child_a uuid;
  v_child_b uuid;
  v_trusted uuid;
  v_routine uuid;
  v_story   uuid;
begin
  -- --- auth users -----------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'rosa@example.test', extensions.crypt('kindly-demo-1', extensions.gen_salt('bf')),
     now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
    (v_second, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
     'marcus@example.test', extensions.crypt('kindly-demo-1', extensions.gen_salt('bf')),
     now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}')
  on conflict (id) do nothing;

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values
    (extensions.gen_random_uuid(), v_owner, v_owner::text,
     format('{"sub":"%s","email":"rosa@example.test"}', v_owner)::jsonb, 'email', now(), now(), now()),
    (extensions.gen_random_uuid(), v_second, v_second::text,
     format('{"sub":"%s","email":"marcus@example.test"}', v_second)::jsonb, 'email', now(), now(), now())
  on conflict do nothing;

  insert into public.users (id, email, email_verified_at)
  values (v_owner, 'rosa@example.test', now()), (v_second, 'marcus@example.test', now())
  on conflict (id) do nothing;

  -- --- caregiver identities -------------------------------------------------
  insert into public.caregiver_profiles (user_id, caregiver_name, relationship_label, onboarding_stage)
  values (v_owner, 'Rosa', 'Mum', 'complete'),
         (v_second, 'Marcus', 'Dad', 'complete')
  on conflict (user_id) do nothing;

  -- --- family ---------------------------------------------------------------
  insert into public.families (family_name, created_by, emergency_instructions)
  values ('Rosa and Marcus', v_owner,
          'If you cannot reach a caregiver and someone is hurt or in danger, call your local emergency number.')
  returning id into v_family;

  insert into public.family_members (family_id, user_id, role)
  values (v_family, v_owner, 'owner'), (v_family, v_second, 'caregiver');

  insert into public.notification_preferences (user_id, family_id)
  values (v_owner, v_family), (v_second, v_family);

  perform public.set_caregiver_pin(v_family, '7391');

  -- --- two children, deliberately different profiles -------------------------
  insert into public.child_profiles (family_id, child_name, pronouns, safe_adult, safe_place, created_by)
  values (v_family, 'Léo', 'he/him', 'your teacher, Mr O''Neill', 'the quiet corner in the library', v_owner)
  returning id into v_child_a;

  insert into public.child_profiles (family_id, child_name, pronouns, safe_adult, safe_place, created_by)
  values (v_family, '小明', 'they/them', 'the school office', 'the reading tent', v_owner)
  returning id into v_child_b;

  insert into public.child_preferences (child_id, family_id, low_stimulation, countdowns_visible,
                                        symbol_system, processing_time_seconds, bathroom_urgency, updated_by)
  values (v_child_a, v_family, false, true,  'kindly_default', 10, 'urgent',   v_owner),
         (v_child_b, v_family, true,  false, 'photos',         30, 'can_wait', v_owner);

  insert into public.communication_methods (child_id, family_id, method, label, is_primary, sort_order)
  values (v_child_a, v_family, 'spoken_words', 'Words',     true,  0),
         (v_child_a, v_family, 'pictograms',   'Pictures',  false, 1),
         (v_child_a, v_family, 'gestures',     'Gestures',  false, 2),
         (v_child_b, v_family, 'aac_device',   'AAC device', true, 0),
         (v_child_b, v_family, 'photos',       'Photos',    false, 1);

  insert into public.sensory_preferences (child_id, family_id, category, kind, label, sort_order)
  values (v_child_a, v_family, 'sound',    'helps', 'Quiet spaces', 0),
         (v_child_a, v_family, 'touch',    'helps', 'Deep pressure', 1),
         (v_child_a, v_family, 'other',    'helps', 'Extra processing time', 2),
         (v_child_a, v_family, 'crowding', 'hard',  'Busy corridors', 3),
         (v_child_b, v_family, 'light',    'helps', 'Dim light', 0),
         (v_child_b, v_family, 'sound',    'hard',  'Sudden loud noises', 1);

  -- --- trusted caregivers ---------------------------------------------------
  insert into public.trusted_caregivers (family_id, child_id, user_id, trusted_caregiver_name,
                                         relationship_label, escalation_order, created_by)
  values (v_family, v_child_a, v_second, 'Marcus', 'Dad', 1, v_owner)
  returning id into v_trusted;

  insert into public.trusted_caregivers (family_id, child_id, trusted_caregiver_name,
                                         relationship_label, escalation_order, created_by)
  values (v_family, v_child_a, 'Grandma Ade', 'Grandmother', 2, v_owner),
         (v_family, v_child_b, 'Marcus', 'Dad', 1, v_owner);

  insert into public.escalation_rules (child_id, family_id, applies_to_urgency, step_order, action, after_seconds, trusted_caregiver_id)
  values (v_child_a, v_family, 'urgent',   1, 'notify_trusted',        45,  v_trusted),
         (v_child_a, v_family, 'urgent',   2, 'notify_all_caregivers', 90,  null),
         (v_child_a, v_family, 'urgent',   3, 'show_offline_help',     150, null),
         (v_child_a, v_family, 'can_wait', 1, 'notify_trusted',        180, v_trusted),
         (v_child_a, v_family, 'can_wait', 2, 'show_offline_help',     420, null),
         (v_child_b, v_family, null,       1, 'notify_trusted',        120, null),
         (v_child_b, v_family, null,       2, 'show_offline_help',     360, null);

  -- --- routines -------------------------------------------------------------
  insert into public.routines (family_id, child_id, title, description, icon_key, color_key, schedule_label,
                               schedule_days, schedule_time, transition_warning_seconds, sort_order, created_by)
  values (v_family, v_child_a, 'Morning check-in', 'A gentle sequence of steps to start the day.',
          'i-clock-3', 'yellow', 'Every weekday, 7:30 AM', array[1,2,3,4,5], '07:30', 60, 0, v_owner)
  returning id into v_routine;

  insert into public.routine_steps (routine_id, family_id, position, title, detail, pictogram_key, estimated_seconds, plans_changed_note)
  values (v_routine, v_family, 0, 'Wake up slowly', 'You can stay in bed for a few minutes.', 'i-clock-3', 300,
          'If today feels hard, we can start with breakfast instead.'),
         (v_routine, v_family, 1, 'Get dressed', 'Your clothes are on the chair.', 'i-user-round', 420, null),
         (v_routine, v_family, 2, 'Breakfast', 'You choose what you eat.', 'i-droplet', 900,
          'If you are not hungry, that is okay. We can take food with us.');

  insert into public.routines (family_id, child_id, title, description, icon_key, color_key, schedule_label, sort_order, created_by)
  values (v_family, v_child_a, 'Getting ready for school', 'A gentle sequence of steps.', 'i-clock-3', 'yellow', 'School days', 1, v_owner),
         (v_family, v_child_a, 'Wind-down time', 'A gentle sequence of steps.', 'i-clock-3', 'purple', 'Every evening', 2, v_owner),
         (v_family, v_child_b, 'After school', 'Coming home and settling.', 'i-clock-3', 'mint', 'Weekdays', 0, v_owner);

  -- --- an approved, assigned story -----------------------------------------
  insert into public.stories (family_id, child_id, title, scenario_key, status, source, format, person,
                              reading_level, target_page_count, inputs, created_by, approved_by, approved_at)
  values (v_family, v_child_a, 'Going to the dentist on Thursday', 'doctor_or_dentist', 'approved', 'manual',
          'text', 'first_person', 'simple', 6,
          jsonb_build_object('location', 'the dental clinic on Bridge Street',
                             'people', 'the dentist and one nurse',
                             'safe_adult', 'Rosa', 'safe_place', 'the waiting room chairs by the window'),
          v_owner, v_owner, now())
  returning id into v_story;

  insert into public.story_pages (story_id, family_id, position, section_key, heading, body, certainty)
  values
    (v_story, v_family, 0, 'title',      null, 'Going to the dentist on Thursday', 'fact'),
    (v_story, v_family, 1, 'situation',  'What this is about',
     'On Thursday I am going to the dentist. A dentist is a person who looks at teeth.', 'fact'),
    (v_story, v_family, 2, 'where_when', 'Where and when',
     'We will go to the dental clinic on Bridge Street. We will go in the afternoon.', 'fact'),
    (v_story, v_family, 3, 'who',        'Who may be there',
     'The dentist will be there. One nurse may be there. Rosa will stay with me.', 'possibility'),
    (v_story, v_family, 4, 'what_you_may_notice', 'What I may notice',
     'The room may have a bright light. The chair moves up and down. Some machines make a buzzing sound.', 'possibility'),
    (v_story, v_family, 5, 'choices',    'What I can do',
     'I can wear my headphones. I can hold my fidget. I can put my hand up to ask the dentist to stop. I do not have to talk if I do not want to.', 'choice'),
    (v_story, v_family, 6, 'asking_for_help', 'Asking for help',
     'I can say or show "stop". I can ask Rosa for a break. I can go to the waiting room chairs by the window.', 'choice'),
    (v_story, v_family, 7, 'ending',     'The ending',
     'The dentist visit will end. I do not know exactly how it will feel. Some parts may be uncomfortable. Rosa will be there and we will go home afterwards.', 'fact');

  insert into public.story_assignments (story_id, child_id, family_id, assigned_by)
  values (v_story, v_child_a, v_family, v_owner);

  insert into public.story_versions (story_id, family_id, version, snapshot, change_note, created_by, created_by_name)
  values (v_story, v_family, 1, kindly.story_snapshot(v_story), 'First version, written by hand', v_owner, 'Rosa');

  -- --- a draft that still needs review --------------------------------------
  insert into public.stories (family_id, child_id, title, scenario_key, status, source, format, person,
                              reading_level, inputs, created_by, requires_safety_review)
  values (v_family, v_child_a, 'When someone says no', 'someone_says_no', 'draft', 'manual', 'text',
          'first_person', 'simple', '{}'::jsonb, v_owner, false);

  raise notice 'KINDLY demo family seeded: family=%, children=% and %', v_family, v_child_a, v_child_b;
end
$seed$;
