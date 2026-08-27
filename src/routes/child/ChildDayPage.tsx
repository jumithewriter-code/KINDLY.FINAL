import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { useBackend, useChildSession } from '../../state/providers';

/** "My day" — the child's routines, shown as large cards with words and symbols. */
export function ChildDayPage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const { token } = useChildSession();

  const query = useQuery({
    queryKey: ['child-routines', token],
    queryFn: () => backend.childGetRoutines(token!),
    enabled: Boolean(token),
  });

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child')}>
        <Icon name="i-arrow-left" size={17} /> Back
      </button>

      <div className="child-greeting">
        <span className="eyebrow">MY DAY</span>
        <h1>What is next.</h1>
        <p>You can start one, or just look. Nothing has to happen right now.</p>
      </div>

      {query.isLoading ? <LoadingState label="Getting your day" /> : null}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

      {!query.isLoading && (query.data ?? []).length === 0 ? (
        <EmptyState
          title="Nothing planned yet"
          detail="When a grown-up makes a routine with you, it will be here."
          action={<Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>Back to my day</Button>}
        />
      ) : null}

      <div className="help-grid">
        {(query.data ?? []).map((routine) => (
          <button key={routine.id} className={`help-card ${routine.colorKey}`} onClick={() => navigate(`/child/day/${routine.id}`)}>
            <span className="pictogram" aria-hidden="true">
              <Icon name={routine.iconKey ?? 'i-clock-3'} size={28} strokeWidth={2.75} />
            </span>
            <b>{routine.title}</b>
            <small>{routine.steps.length} step{routine.steps.length === 1 ? '' : 's'}</small>
            {routine.scheduleLabel ? <span className="req-tag">{routine.scheduleLabel}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
