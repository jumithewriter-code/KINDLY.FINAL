import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession } from '../../state/providers';
import type { RoutineRun, RoutineStepState } from '../../lib/types';

/**
 * Running a routine.
 *
 * There is no score, no streak and no "well done for finishing". A skipped step
 * is recorded neutrally and looks the same size as a completed one. "Plans have
 * changed" is a first-class outcome, not a failure, and the routine can be
 * paused or left at any point without losing the place.
 */
export function ChildRoutineRunnerPage() {
  const { routineId = '' } = useParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const client = useQueryClient();
  const { token, space } = useChildSession();
  const { announce } = useAnnouncer();

  const [run, setRun] = useState<RoutineRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showChanged, setShowChanged] = useState(false);

  const routinesQuery = useQuery({
    queryKey: ['child-routines', token],
    queryFn: () => backend.childGetRoutines(token!),
    enabled: Boolean(token),
  });

  const routine = routinesQuery.data?.find((r) => r.id === routineId);

  useEffect(() => {
    if (!routine) return;
    backend.getActiveRoutineRun(routine.id).then(setRun).catch(() => setRun(null));
  }, [backend, routine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useMutation({
    mutationFn: () => backend.startRoutineRun(routineId, 'child'),
    onSuccess: (next) => { setRun(next); setError(null); announce('Started. You can pause or stop whenever you want.'); },
    onError: (e) => setError(e),
  });

  const setStep = useMutation({
    mutationFn: ({ stepId, state }: { stepId: string; state: RoutineStepState }) =>
      backend.setRoutineStepState(run!.id, stepId, state),
    onSuccess: (next, variables) => {
      setRun(next);
      announce(variables.state === 'done' ? 'Step marked as done.' : 'Step skipped. That is completely fine.');
      void client.invalidateQueries({ queryKey: ['child-routines'] });
    },
    onError: (e) => setError(e),
  });

  const setStatus = useMutation({
    mutationFn: (status: RoutineRun['status']) => backend.setRoutineRunStatus(run!.id, status),
    onSuccess: (next, status) => {
      setRun(next);
      announce(
        status === 'paused' ? 'Paused. Nothing is lost.'
          : status === 'plans_changed' ? 'Marked as plans changed.'
            : status === 'finished' ? 'Finished.'
              : 'Stopped.',
      );
    },
    onError: (e) => setError(e),
  });

  if (routinesQuery.isLoading) return <div className="sent-screen"><LoadingState label="Getting your routine" /></div>;

  if (!routine) {
    return (
      <div className="sent-screen">
        <ErrorState error={new Error('That routine is not here any more.')} />
        <div className="big-actions">
          <Button tone="coral" big icon="i-arrow-left" onClick={() => navigate('/child/day')}>Back to my day</Button>
        </div>
      </div>
    );
  }

  const stateOf = (stepId: string): RoutineStepState =>
    run?.stepStates.find((s) => s.stepId === stepId)?.state ?? 'pending';

  const currentStep = routine.steps.find((s) => s.id === run?.currentStepId) ?? routine.steps[0];
  const nextStep = routine.steps[routine.steps.findIndex((s) => s.id === currentStep?.id) + 1];
  const finished = run?.status === 'finished' || run?.status === 'plans_changed' || run?.status === 'abandoned';

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child/day')}>
        <Icon name="i-arrow-left" size={17} /> Back to my day
      </button>

      <div className="child-greeting">
        <span className="eyebrow">MY DAY</span>
        <h1>{routine.title}</h1>
        <p>{routine.steps.length} step{routine.steps.length === 1 ? '' : 's'}. You can stop at any point.</p>
      </div>

      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}

      {!run ? (
        <div className="big-actions">
          <Button tone="coral" big icon="i-play" onClick={() => start.mutate()} loading={start.isPending}>
            Start
          </Button>
          <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child/day')}>Not now</Button>
        </div>
      ) : null}

      {run && !finished && currentStep ? (
        <div className="routine-runner-step">
          <span className="eyebrow">NOW</span>
          <h2 style={{ margin: 0, fontSize: 26, letterSpacing: '-0.8px' }}>
            <Icon name={currentStep.pictogramKey ?? 'i-clock-3'} size={26} strokeWidth={2.5} /> {currentStep.title}
          </h2>
          {currentStep.detail ? <p style={{ margin: 0 }}>{currentStep.detail}</p> : null}
          {currentStep.isOptional ? (
            <p className="inline-note"><Icon name="i-heart" size={16} /><span>This step is optional.</span></p>
          ) : null}

          {routine.transitionWarningSeconds > 0 && nextStep ? (
            <p className="inline-note">
              <Icon name="i-arrow-right" size={16} strokeWidth={2.5} />
              <span>Next: {nextStep.title}. Kindly will wait for you — it never moves on by itself.</span>
            </p>
          ) : null}

          {run.status === 'paused' ? (
            <p className="inline-note" role="status">
              <Icon name="i-pause" size={16} strokeWidth={2.5} />
              <span>Paused. Nothing is lost. Start again whenever you are ready.</span>
            </p>
          ) : null}

          <div className="big-actions">
            {run.status === 'running' ? (
              <>
                <Button tone="coral" big icon="i-check" onClick={() => setStep.mutate({ stepId: currentStep.id, state: 'done' })} loading={setStep.isPending}>
                  Done
                </Button>
                {routine.allowSkip ? (
                  <Button tone="ghost" big icon="i-arrow-right" onClick={() => setStep.mutate({ stepId: currentStep.id, state: 'skipped' })} loading={setStep.isPending}>
                    Skip this step
                  </Button>
                ) : null}
                <Button tone="ghost" big icon="i-pause" onClick={() => setStatus.mutate('paused')}>Pause</Button>
              </>
            ) : (
              <Button tone="coral" big icon="i-play" onClick={() => setStatus.mutate('running')}>Start again</Button>
            )}

            <Button tone="ghost" big icon="i-refresh" onClick={() => setShowChanged((v) => !v)}>
              Plans have changed
            </Button>
            <Button tone="ghost" big icon="i-x" onClick={() => setStatus.mutate('abandoned')}>
              Stop for now
            </Button>
          </div>

          {showChanged ? (
            <div className="inline-note" style={{ display: 'grid', gap: 10 }}>
              <b>Plans have changed. That is okay.</b>
              <span>{currentStep.plansChangedNote ?? 'You can do something different, or come back to this later.'}</span>
              <div className="row-actions">
                <Button tone="secondary" big icon="i-check" onClick={() => { setStatus.mutate('plans_changed'); setShowChanged(false); }}>
                  Mark this as changed
                </Button>
                <Button tone="ghost" big onClick={() => setShowChanged(false)}>Keep going</Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {run && finished ? (
        <div className="routine-runner-step">
          <h2 style={{ margin: 0 }}>
            {run.status === 'plans_changed' ? 'Plans changed today.' : run.status === 'abandoned' ? 'Stopped for now.' : 'That is the end.'}
          </h2>
          <p style={{ margin: 0 }}>
            Nothing is counted or scored. You can start this again whenever you want.
          </p>
          <div className="big-actions">
            <Button tone="coral" big icon="i-arrow-left" onClick={() => navigate('/child/day')}>Back to my day</Button>
            <Button tone="ghost" big icon="i-refresh" onClick={() => start.mutate()}>Do it again</Button>
          </div>
        </div>
      ) : null}

      {run ? (
        <section aria-labelledby="routine-progress">
          <h2 id="routine-progress" style={{ fontSize: 17, marginTop: 26 }}>All the steps</h2>
          <ul className="routine-progress-list">
            {routine.steps.map((step) => {
              const state = stateOf(step.id);
              return (
                <li key={step.id} data-state={state}>
                  <Icon
                    name={state === 'done' ? 'i-check' : state === 'skipped' ? 'i-arrow-right' : state === 'changed' ? 'i-refresh' : 'i-clock-3'}
                    size={17}
                    strokeWidth={2.5}
                  />
                  <span>
                    {step.title}
                    {' — '}
                    {state === 'done' ? 'done' : state === 'skipped' ? 'skipped, and that is fine' : state === 'changed' ? 'changed' : 'not yet'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {space?.preferences.processingTimeSeconds ? (
        <p style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 18 }}>
          Kindly waits for you. Take as long as you need.
        </p>
      ) : null}
    </div>
  );
}
