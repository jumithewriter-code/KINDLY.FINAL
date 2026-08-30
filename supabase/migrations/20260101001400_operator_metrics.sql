-- ===========================================================================
-- KINDLY 0014 — operator metrics
-- ===========================================================================
-- A dashboard for whoever runs KINDLY, answering "is this working?" without
-- answering "what did this child ask for?".
--
-- The rule this file exists to enforce: an operator sees counts and durations,
-- never a name, never a message, never an identifier that could be joined back
-- to a family. There is deliberately no way to widen it from the client — the
-- shape of the response is fixed here, so a curious front end cannot ask for
-- more than this returns.
--
-- The function is SECURITY DEFINER because aggregating across families
-- necessarily crosses the boundary RLS draws. Only aggregates ever leave it.
-- ===========================================================================

-- --------------------------------------------------------------------------
-- 1. Who is an operator
-- --------------------------------------------------------------------------
-- Kept in the private kindly schema with no client policy at all, exactly like
-- caregiver_pins. A caregiver cannot read this table, cannot discover who is on
-- it, and above all cannot add themselves to it. Rows are inserted by hand,
-- from the SQL editor, by someone who already has database access.
create table if not exists kindly.operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default kindly.now()
);

alter table kindly.operators enable row level security;
alter table kindly.operators force row level security;
revoke all on kindly.operators from anon, authenticated;

create or replace function kindly.is_operator(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (select 1 from kindly.operators o where o.user_id = p_user);
$fn$;

-- Lets the app decide whether to show the link, without revealing the table.
create or replace function public.am_i_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select kindly.is_operator();
$fn$;

-- --------------------------------------------------------------------------
-- 2. The metrics
-- --------------------------------------------------------------------------
create or replace function public.operator_metrics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_now      timestamptz := kindly.now();
  v_families int;
  v_result   jsonb;
  -- Below this many families, a "requests by type" breakdown stops being a
  -- statistic and becomes a description of one child's day. Totals stay; the
  -- breakdown is withheld until there are enough families to hide in.
  k_min_families constant int := 5;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not kindly.is_operator() then raise exception 'NOT_PERMITTED'; end if;

  select count(*) into v_families from public.families;

  select jsonb_build_object(
    'generated_at', v_now,

    'reach', jsonb_build_object(
      'families',   v_families,
      'children',   (select count(*) from public.child_profiles),
      'caregivers', (select count(distinct user_id) from public.family_members),
      'trusted',    (select count(*) from public.trusted_caregivers),
      'families_added_7d', (select count(*) from public.families
                             where created_at > v_now - interval '7 days')
    ),

    -- Whether the product does the one thing it exists to do: carry a request
    -- from a child to an adult who answers it.
    'requests', (
      select jsonb_build_object(
        'total',        count(*),
        'last_24h',     count(*) filter (where created_at > v_now - interval '24 hours'),
        'last_7d',      count(*) filter (where created_at > v_now - interval '7 days'),
        'urgent_7d',    count(*) filter (where created_at > v_now - interval '7 days'
                                           and urgency = 'urgent'),
        'answered_7d',  count(*) filter (where created_at > v_now - interval '7 days'
                                           and acknowledged_at is not null),
        'resolved_7d',  count(*) filter (where created_at > v_now - interval '7 days'
                                           and resolved_at is not null),
        'cancelled_7d', count(*) filter (where created_at > v_now - interval '7 days'
                                           and cancelled_at is not null)
      )
      from public.requests
    ),

    -- The numbers that describe a child waiting. These are the ones worth
    -- watching: an escalation means the assigned adult did not answer in time,
    -- and unavailable means nobody did and the child was shown offline help.
    'waiting', jsonb_build_object(
      'escalated_7d', (select count(*) from public.requests
                        where escalated_at is not null
                          and created_at > v_now - interval '7 days'),
      'unavailable_7d', (select count(*) from public.requests
                          where unavailable_at is not null
                            and created_at > v_now - interval '7 days'),
      'failed_7d', (select count(*) from public.requests
                     where status = 'failed'
                       and created_at > v_now - interval '7 days'),
      'open_now', (select count(*) from public.requests
                    where status in ('sending','retrying','delivered',
                                     'waiting','escalated','acknowledged')),
      -- Seconds from a request reaching a caregiver's device to a caregiver
      -- responding. Median, not mean: one forgotten tab should neither flatter
      -- nor ruin the picture.
      'median_answer_seconds', (
        select round(percentile_cont(0.5) within group (
                 order by extract(epoch from (acknowledged_at - delivered_at))))
          from public.requests
         where acknowledged_at is not null and delivered_at is not null
           and created_at > v_now - interval '7 days'
      ),
      'p90_answer_seconds', (
        select round(percentile_cont(0.9) within group (
                 order by extract(epoch from (acknowledged_at - delivered_at))))
          from public.requests
         where acknowledged_at is not null and delivered_at is not null
           and created_at > v_now - interval '7 days'
      )
    ),

    -- Delivery failures by cause. Distinguishes "the child had no signal" from
    -- "KINDLY broke", which are different problems with different fixes.
    'failures_7d', coalesce((
      select jsonb_object_agg(f.failure_reason, f.n)
        from (select failure_reason, count(*) as n
                from public.requests
               where failure_reason is not null
                 and created_at > v_now - interval '7 days'
               group by failure_reason) f
    ), '{}'::jsonb),

    -- Daily request counts for the last 14 days, oldest first. A shape, not a
    -- log: one integer per day and nothing else.
    'daily_requests', coalesce((
      select jsonb_agg(jsonb_build_object('day', d::date, 'n', coalesce(c.n, 0)) order by d)
        from generate_series((v_now - interval '13 days')::date, v_now::date, interval '1 day') d
        left join (select created_at::date as day, count(*) as n
                     from public.requests
                    where created_at > v_now - interval '14 days'
                    group by 1) c on c.day = d::date
    ), '[]'::jsonb),

    -- Safety configuration adoption. A family with no code, or an escalation
    -- ladder that never reaches offline help, is a family where the product's
    -- safety guarantees do not actually hold.
    'safety', jsonb_build_object(
      'families_with_code', (
        select count(*) from public.caregiver_pins
         where pin_hash is not null and pin_hash <> 'disabled'),
      'children_with_safe_adult', (
        select count(*) from public.child_profiles
         where btrim(coalesce(safe_adult, '')) <> ''),
      'children_with_offline_help_step', (
        select count(distinct child_id) from public.escalation_rules
         where action = 'show_offline_help' and is_active)
    ),

    'content', jsonb_build_object(
      'stories_total',    (select count(*) from public.stories),
      'stories_approved', (select count(*) from public.stories where status = 'approved'),
      'stories_draft',    (select count(*) from public.stories where status = 'draft'),
      'routines_total',   (select count(*) from public.routines)
    ),

    -- Withheld below the threshold. The key is always present so the client can
    -- say why it is empty rather than rendering a blank panel.
    'requests_by_type_7d', case when v_families >= k_min_families then coalesce((
        select jsonb_object_agg(t.type_slug, t.n)
          from (select type_slug, count(*) as n
                  from public.requests
                 where created_at > v_now - interval '7 days'
                 group by type_slug) t
      ), '{}'::jsonb) else null end,
    'type_breakdown_threshold', k_min_families
  ) into v_result;

  return v_result;
end;
$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
revoke all on function public.operator_metrics() from public, anon;
grant execute on function public.operator_metrics() to authenticated;
revoke all on function public.am_i_operator() from public, anon;
grant execute on function public.am_i_operator() to authenticated;
