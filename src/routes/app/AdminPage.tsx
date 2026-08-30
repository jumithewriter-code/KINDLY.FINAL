import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState, SectionTitle } from '../../components/ui';
import { useBackend } from '../../state/providers';
import { useIsOperator } from '../../state/useIsOperator';
import type { OperatorMetrics } from '../../lib/backend/types';

/**
 * The operator dashboard.
 *
 * Answers "is KINDLY working?" without answering "what did this child ask for?".
 * Every number here is a count or a duration across all families; there is no
 * name, no message and no identifier, because `public.operator_metrics()` never
 * returns one. If a future version of this page wants detail, it has to be
 * argued for in SQL first — which is the point.
 *
 * The ordering is deliberate. A child left waiting comes before growth, because
 * the number that should change someone's afternoon is how many children asked
 * for help and were not answered.
 */
export function AdminPage() {
  const backend = useBackend();
  const isOperator = useIsOperator();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['operator-metrics'],
    queryFn: () => backend.getOperatorMetrics(),
    refetchInterval: 60_000,
    retry: false,
  });

  if (isLoading) return <LoadingState label="Reading the numbers" />;
  if (error) {
    return (
      <div className="content-wrap">
        <ErrorState
          error={error}
          title={isOperator ? undefined : 'This page is for KINDLY operators.'}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="content-wrap">
      <SectionTitle
        eyebrow="OPERATOR"
        title="How KINDLY is doing"
        detail="Counts and timings across every family. No names, no messages, nothing that identifies a child or the people caring for them."
      />

      <div className="admin-toolbar">
        <p className="admin-timestamp" role="status">
          <Icon name="i-clock-3" size={15} strokeWidth={2.5} />
          <span>
            Read at {new Date(data.generatedAt).toLocaleTimeString()}
            {isFetching ? ' · refreshing' : ' · refreshes every minute'}
          </span>
        </p>
        <Button tone="ghost" icon="i-refresh" onClick={() => void refetch()} loading={isFetching}>
          Refresh now
        </Button>
      </div>

      <AnsweredPanel metrics={data} />
      <ActivityPanel metrics={data} />
      <ReachPanel metrics={data} />
      <FunnelPanel metrics={data} />
      <SafetyPanel metrics={data} />
      <DeliveryPanel metrics={data} />
      <ContentPanel metrics={data} />

      <p className="note-strip">
        <Icon name="i-shield" size={16} strokeWidth={2.5} />
        <span>
          These figures are aggregates. Opening an individual family&rsquo;s requests is not
          possible from this page and no server function exists to allow it.
        </span>
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* The panel that matters most                                            */
/* ---------------------------------------------------------------------- */

function AnsweredPanel({ metrics }: { metrics: OperatorMetrics }) {
  const { requests, waiting } = metrics;
  const answeredPct = requests.last7d > 0 ? Math.round((requests.answered7d / requests.last7d) * 100) : null;

  // `unavailable` means the escalation ladder ran out and a child was shown
  // offline help. It is the one number here that describes a person, so it is
  // never rendered as a neutral statistic.
  const unansweredTone = waiting.unavailable7d > 0 ? 'critical' : waiting.escalated7d > 0 ? 'warning' : 'good';

  return (
    <section className="admin-section" aria-labelledby="admin-answered">
      <h2 id="admin-answered" className="admin-section-title">Were children answered?</h2>
      <p className="admin-section-note">Requests created in the last 7 days.</p>

      <div className="admin-tiles">
        <Tile
          label="Answered"
          value={answeredPct === null ? '—' : `${answeredPct}%`}
          detail={requests.last7d > 0 ? `${requests.answered7d} of ${requests.last7d} requests` : 'No requests yet'}
          tone={answeredPct === null ? 'neutral' : answeredPct >= 95 ? 'good' : answeredPct >= 80 ? 'warning' : 'critical'}
        />
        <Tile
          label="Typical time to answer"
          value={formatDuration(waiting.medianAnswerSeconds)}
          detail={waiting.p90AnswerSeconds != null ? `9 in 10 within ${formatDuration(waiting.p90AnswerSeconds)}` : 'Median, delivered to answered'}
          tone="neutral"
        />
        <Tile
          label="Reached offline help"
          value={String(waiting.unavailable7d)}
          detail={waiting.unavailable7d > 0 ? 'Nobody answered these' : 'No child ran out of adults'}
          tone={unansweredTone === 'critical' ? 'critical' : 'good'}
        />
        <Tile
          label="Escalated"
          value={String(waiting.escalated7d)}
          detail="Passed to a trusted caregiver"
          tone={waiting.escalated7d > 0 ? 'warning' : 'good'}
        />
        <Tile label="Open right now" value={String(waiting.openNow)} detail="Not yet resolved" tone="neutral" />
        <Tile
          label="Urgent"
          value={String(requests.urgent7d)}
          detail={requests.last7d > 0 ? `${Math.round((requests.urgent7d / requests.last7d) * 100)}% of requests` : '—'}
          tone="neutral"
        />
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------- */
/* Fourteen days of requests                                              */
/* ---------------------------------------------------------------------- */

function ActivityPanel({ metrics }: { metrics: OperatorMetrics }) {
  const days = metrics.dailyRequests;
  const max = useMemo(() => Math.max(1, ...days.map((d) => d.n)), [days]);
  const total = days.reduce((sum, d) => sum + d.n, 0);

  return (
    <section className="admin-section" aria-labelledby="admin-activity">
      <h2 id="admin-activity" className="admin-section-title">Requests per day</h2>
      <p className="admin-section-note">
        Last 14 days · {total} {total === 1 ? 'request' : 'requests'} · busiest day {max}
      </p>

      <div className="admin-card">
        {total === 0 ? (
          <p className="admin-empty">No requests in the last 14 days.</p>
        ) : (
          <>
            <div className="admin-chart" role="img" aria-label={chartSummary(days)}>
              {days.map((d) => {
                const heightPct = (d.n / max) * 100;
                return (
                  <div className="admin-bar-slot" key={d.day}>
                    <div className="admin-bar-track">
                      <div
                        className={d.n === 0 ? 'admin-bar zero' : 'admin-bar'}
                        style={{ height: `${Math.max(heightPct, d.n === 0 ? 0 : 3)}%` }}
                      >
                        <span className="admin-bar-tip">
                          {shortDate(d.day)}: {d.n}
                        </span>
                      </div>
                    </div>
                    <span className="admin-bar-label">{dayInitial(d.day)}</span>
                  </div>
                );
              })}
            </div>

            {/* Identity is never carried by the bars alone. */}
            <details className="admin-table-toggle">
              <summary>Show these numbers as a table</summary>
              <table className="admin-table">
                <caption className="visually-hidden">Requests per day for the last 14 days</caption>
                <thead>
                  <tr><th scope="col">Day</th><th scope="col">Requests</th></tr>
                </thead>
                <tbody>
                  {days.map((d) => (
                    <tr key={d.day}><th scope="row">{shortDate(d.day)}</th><td>{d.n}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------- */

function ReachPanel({ metrics }: { metrics: OperatorMetrics }) {
  const { reach, requests } = metrics;
  return (
    <section className="admin-section" aria-labelledby="admin-reach">
      <h2 id="admin-reach" className="admin-section-title">Who is using KINDLY</h2>
      <div className="admin-tiles">
        <Tile label="Families" value={String(reach.families)} detail={`${reach.familiesAdded7d} joined this week`} tone="neutral" />
        <Tile label="Children" value={String(reach.children)} detail="With a profile" tone="neutral" />
        <Tile label="Caregivers" value={String(reach.caregivers)} detail="With an account" tone="neutral" />
        <Tile label="Trusted caregivers" value={String(reach.trusted)} detail="Named, no account needed" tone="neutral" />
        <Tile label="Requests today" value={String(requests.last24h)} detail={`${requests.total} all time`} tone="neutral" />
        <Tile label="Cancelled" value={String(requests.cancelled7d)} detail="Child changed their mind" tone="neutral" />
      </div>
    </section>
  );
}

function FunnelPanel({ metrics }: { metrics: OperatorMetrics }) {
  const f = metrics.funnel30d;
  const { active } = metrics;

  // Each step is a subset of the one above, so the widths are all measured
  // against the top of the funnel rather than against the previous step.
  const steps = [
    { label: 'Created an account', n: f.accountsCreated },
    { label: 'Verified their email', n: f.verifiedEmail },
    { label: 'Started onboarding', n: f.startedOnboarding },
    { label: 'Joined a family space', n: f.joinedAFamily },
    { label: 'Finished onboarding', n: f.finishedOnboarding },
    { label: 'Their child sent a request', n: f.familySentRequest },
  ];
  const top = f.accountsCreated;

  // The largest single drop is where the product is losing people.
  let worst = { from: '', to: '', lost: 0 };
  for (let i = 1; i < steps.length; i += 1) {
    const lost = steps[i - 1]!.n - steps[i]!.n;
    if (lost > worst.lost) worst = { from: steps[i - 1]!.label, to: steps[i]!.label, lost };
  }

  return (
    <section className="admin-section" aria-labelledby="admin-funnel">
      <h2 id="admin-funnel" className="admin-section-title">Where people stop</h2>
      <p className="admin-section-note">
        Accounts created in the last 30 days, followed through. Counts only &mdash; nobody is named.
      </p>

      <div className="admin-tiles" style={{ marginBottom: 14 }}>
        <Tile label="Active today" value={String(active.seen24h)} detail={`${active.seen7d} this week`} tone="neutral" />
        <Tile label="Accounts, all time" value={String(active.accountsTotal)} detail={`${f.accountsCreated} in the last 30 days`} tone="neutral" />
        <Tile
          label="Reached a first request"
          value={top > 0 ? `${Math.round((f.familySentRequest / top) * 100)}%` : '—'}
          detail={top > 0 ? `${f.familySentRequest} of ${top} new accounts` : 'No new accounts'}
          tone={top === 0 ? 'neutral' : f.familySentRequest / top >= 0.4 ? 'good' : 'warning'}
        />
      </div>

      <div className="admin-card">
        {top === 0 ? (
          <p className="admin-empty">No accounts created in the last 30 days.</p>
        ) : (
          <>
            <ol className="admin-funnel">
              {steps.map((step, i) => {
                const pct = Math.round((step.n / top) * 100);
                const lostHere = i === 0 ? 0 : steps[i - 1]!.n - step.n;
                return (
                  <li key={step.label}>
                    <div className="admin-funnel-head">
                      <span>{step.label}</span>
                      {/* The separator is real text, not margin: read aloud,
                          "3" followed by "100%" would otherwise run together
                          into "3100%". */}
                      <b>
                        {step.n}
                        <small> &middot; {pct}% of new accounts</small>
                      </b>
                    </div>
                    <div className="admin-funnel-track">
                      <div className="admin-funnel-fill" style={{ width: `${Math.max(pct, 1)}%` }} />
                    </div>
                    {lostHere > 0 ? (
                      <span className="admin-funnel-drop">
                        {lostHere} {lostHere === 1 ? 'person' : 'people'} stopped here
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            {worst.lost > 0 ? (
              <p className="note-strip" style={{ marginTop: 16 }}>
                <Icon name="i-alert" size={16} strokeWidth={2.5} />
                <span>
                  The biggest drop is between <strong>{worst.from.toLowerCase()}</strong> and{' '}
                  <strong>{worst.to.toLowerCase()}</strong> &mdash; {worst.lost}{' '}
                  {worst.lost === 1 ? 'person' : 'people'}.
                </span>
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

function SafetyPanel({ metrics }: { metrics: OperatorMetrics }) {
  const { safety, reach } = metrics;
  return (
    <section className="admin-section" aria-labelledby="admin-safety">
      <h2 id="admin-safety" className="admin-section-title">Safety settings in place</h2>
      <p className="admin-section-note">
        A family missing these is a family where KINDLY&rsquo;s guarantees do not actually hold.
      </p>
      <div className="admin-ratios">
        <Ratio label="Families with a grown-up code" have={safety.familiesWithCode} of={reach.families} />
        <Ratio label="Children with a safe adult named" have={safety.childrenWithSafeAdult} of={reach.children} />
        <Ratio label="Children whose ladder ends in offline help" have={safety.childrenWithOfflineHelpStep} of={reach.children} />
      </div>
    </section>
  );
}

function DeliveryPanel({ metrics }: { metrics: OperatorMetrics }) {
  const reasons = Object.entries(metrics.failures7d);
  const LABELS: Record<string, string> = {
    offline: 'The child’s device had no connection',
    interrupted: 'Sending was interrupted',
    server_error: 'KINDLY failed',
    timeout: 'Timed out',
  };

  return (
    <section className="admin-section" aria-labelledby="admin-delivery">
      <h2 id="admin-delivery" className="admin-section-title">Delivery failures</h2>
      <p className="admin-section-note">
        Separates &ldquo;the child had no signal&rdquo; from &ldquo;KINDLY broke&rdquo;. Only the second is yours to fix.
      </p>
      <div className="admin-card">
        {reasons.length === 0 ? (
          <p className="admin-empty">No failed deliveries in the last 7 days.</p>
        ) : (
          <ul className="admin-list">
            {reasons.sort((a, b) => b[1] - a[1]).map(([reason, n]) => (
              <li key={reason} className={reason === 'server_error' ? 'is-critical' : ''}>
                <Icon name={reason === 'server_error' ? 'i-alert' : 'i-offline'} size={16} strokeWidth={2.5} />
                <span>{LABELS[reason] ?? reason}</span>
                <b>{n}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ContentPanel({ metrics }: { metrics: OperatorMetrics }) {
  const { content, requestsByType7d, typeBreakdownThreshold, reach } = metrics;
  const types = requestsByType7d ? Object.entries(requestsByType7d).sort((a, b) => b[1] - a[1]) : null;
  const typeMax = types?.length ? Math.max(...types.map(([, n]) => n)) : 1;

  return (
    <section className="admin-section" aria-labelledby="admin-content">
      <h2 id="admin-content" className="admin-section-title">Stories, routines and what is asked for</h2>
      <div className="admin-tiles">
        <Tile label="Stories" value={String(content.storiesTotal)} detail={`${content.storiesApproved} approved`} tone="neutral" />
        <Tile label="Awaiting approval" value={String(content.storiesDraft)} detail="Drafts a child cannot see yet" tone="neutral" />
        <Tile label="Routines" value={String(content.routinesTotal)} detail="Built by caregivers" tone="neutral" />
      </div>

      <div className="admin-card" style={{ marginTop: 14 }}>
        {types === null ? (
          <p className="admin-empty">
            <Icon name="i-lock" size={16} strokeWidth={2.5} />{' '}
            Held back until {typeBreakdownThreshold} families are using KINDLY (currently {reach.families}).
            With fewer, a breakdown of what is asked for stops being a statistic and becomes a
            description of one child&rsquo;s day.
          </p>
        ) : types.length === 0 ? (
          <p className="admin-empty">No requests in the last 7 days.</p>
        ) : (
          <ul className="admin-list">
            {types.map(([slug, n]) => (
              <li key={slug}>
                <span className="admin-type-bar" style={{ width: `${(n / typeMax) * 100}%` }} aria-hidden="true" />
                <span>{slug.replace(/[-_]/g, ' ')}</span>
                <b>{n}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------- */
/* Pieces                                                                 */
/* ---------------------------------------------------------------------- */

function Tile({ label, value, detail, tone }: {
  label: string; value: string; detail: string;
  tone: 'good' | 'warning' | 'critical' | 'neutral';
}) {
  // Tone is carried by an icon and the detail line as well as by colour, so it
  // survives greyscale, forced colours and colour blindness.
  const ICONS = { good: 'i-check', warning: 'i-clock-3', critical: 'i-alert', neutral: null } as const;
  const icon = ICONS[tone];
  return (
    <div className={`admin-tile tone-${tone}`}>
      <span className="admin-tile-label">{label}</span>
      <strong className="admin-tile-value">{value}</strong>
      <span className="admin-tile-detail">
        {icon ? <Icon name={icon} size={13} strokeWidth={2.5} /> : null}
        {detail}
      </span>
    </div>
  );
}

function Ratio({ label, have, of }: { label: string; have: number; of: number }) {
  const pct = of > 0 ? Math.round((have / of) * 100) : 0;
  const complete = of > 0 && have >= of;
  return (
    <div className="admin-ratio">
      <div className="admin-ratio-head">
        <span>{label}</span>
        <b>{of > 0 ? `${have} of ${of}` : '—'}</b>
      </div>
      <div className="admin-ratio-track" role="img" aria-label={`${label}: ${have} of ${of}`}>
        <div className={complete ? 'admin-ratio-fill complete' : 'admin-ratio-fill'} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayInitial(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' });
}

function chartSummary(days: { day: string; n: number }[]): string {
  const busiest = days.reduce((best, d) => (d.n > best.n ? d : best), days[0] ?? { day: '', n: 0 });
  return `Requests per day over 14 days, from ${days[0] ? shortDate(days[0].day) : ''} to ${
    days[days.length - 1] ? shortDate(days[days.length - 1]!.day) : ''
  }. Busiest day ${busiest.day ? shortDate(busiest.day) : ''} with ${busiest.n}.`;
}
