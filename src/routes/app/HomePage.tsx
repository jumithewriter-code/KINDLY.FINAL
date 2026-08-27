import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Avatar, Button, EmptyState, ErrorState, LoadingState, SectionTitle, StatusPill } from '../../components/ui';
import { useBackend, useWorkspace } from '../../state/providers';
import { childLabel, initialFrom } from '../../lib/names';
import { formatTime } from '../../lib/format';
import { STATUS_META, isLive } from '../../lib/requests/stateMachine';
import { SCENARIOS } from '../../lib/stories/scenarios';

/**
 * Home.
 *
 * Every card here goes somewhere real:
 *   - "Try child mode" starts a scoped child session and opens /child
 *   - the toolkit cards open the story builder, child mode and routines
 *   - "Up next" opens the child's next routine
 *   - "Prepare together" carries the chosen scenario into the story builder
 */
export function HomePage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const { workspace, activeChildId, activeFamilyId, can } = useWorkspace();

  const [scenarioKey, setScenarioKey] = useState<string>('doctor_or_dentist');
  const [difficulty, setDifficulty] = useState<'known' | 'a_little_new' | 'very_new'>('a_little_new');
  const [format, setFormat] = useState<'text' | 'pictogram' | 'mixed'>('text');
  const [otherSituation, setOtherSituation] = useState('');

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';

  const requestsQuery = useQuery({
    queryKey: ['requests', activeFamilyId],
    queryFn: () => backend.listRequests(activeFamilyId!),
    enabled: Boolean(activeFamilyId),
  });

  const routinesQuery = useQuery({
    queryKey: ['routines', child?.id],
    queryFn: () => backend.listRoutines(child!.id),
    enabled: Boolean(child?.id),
  });

  const recent = requestsQuery.data?.[0];
  const upNext = useMemo(
    () => (routinesQuery.data ?? []).filter((r) => !r.archivedAt).slice(0, 2),
    [routinesQuery.data],
  );

  async function openChildMode() {
    if (!child) return;
    navigate(`/child?start=${child.id}`);
  }

  function openBuilder() {
    const params = new URLSearchParams({
      scenario: scenarioKey,
      familiarity: difficulty,
      format,
    });
    if (scenarioKey === 'other' && otherSituation.trim()) params.set('other', otherSituation.trim());
    navigate(`/app/stories/new?${params.toString()}`);
  }

  if (!workspace) return <LoadingState label="Opening your space" />;

  return (
    <div className="content-wrap">
      <ol className="journey" aria-label="How Kindly works">
        <li className="journey-step done">
          <span><Icon name="i-check" size={16} strokeWidth={2.5} /></span>
          <div><b>Prepare</b><small>Make a plan</small></div>
        </li>
        <li className="journey-step current" aria-current="step">
          <span>2</span>
          <div><b>Communicate</b><small>Find the words</small></div>
        </li>
        <li className="journey-step">
          <span>3</span>
          <div><b>Connect</b><small>Feel understood</small></div>
        </li>
      </ol>

      <div className="hero-grid">
        <div className="welcome-card">
          <span className="eyebrow">TODAY’S LITTLE WIN</span>
          <h2>Small steps count.</h2>
          <p>One prepared moment can make the whole day feel easier.</p>
          <Button tone="coral" iconAfter="i-arrow-right" onClick={openChildMode} disabled={!child}>
            {child ? `Open ${childLabel(childName)}’s view` : 'Add a child first'}
          </Button>
        </div>

        <div className="today-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">UP NEXT</span>
              <h3>{upNext[0]?.title ?? 'No routine yet'}</h3>
            </div>
            <Button tone="ghost" icon="i-settings-2" aria-label="Manage routines" onClick={() => navigate('/app/routines')}>
              <span className="visually-hidden">Manage routines</span>
            </Button>
          </div>

          {routinesQuery.isLoading ? <LoadingState label="Loading routines" /> : null}

          {!routinesQuery.isLoading && upNext.length === 0 ? (
            <EmptyState
              title="No routines yet"
              detail={`When you build a routine for ${childLabel(childName)}, the next steps show here.`}
              action={can('can_edit_routines')
                ? <Button tone="yellow" icon="i-plus" onClick={() => navigate('/app/routines/new')}>Build a routine</Button>
                : undefined}
            />
          ) : null}

          {upNext.map((routine) => (
            <button
              key={routine.id}
              className="routine-row"
              onClick={() => navigate(`/app/routines/${routine.id}`)}
              style={{ width: '100%', textAlign: 'left', border: 0, background: 'transparent' }}
            >
              <div className={`routine-icon ${routine.colorKey}-bg`} aria-hidden="true">
                <Icon name={routine.iconKey ?? 'i-clock-3'} size={18} />
              </div>
              <div>
                <b>{routine.title}</b>
                <small>{routine.scheduleLabel ?? 'Any time'} · {routine.steps.length} step{routine.steps.length === 1 ? '' : 's'}</small>
              </div>
              <Icon name="i-arrow-right" size={17} />
            </button>
          ))}
        </div>
      </div>

      <SectionTitle
        split
        eyebrow="YOUR TOOLKIT"
        title="What would help today?"
        action={<Button tone="ghost" className="text-button" iconAfter="i-arrow-right" onClick={() => navigate('/app/stories')}>See all</Button>}
      />

      <div className="tool-grid">
        <button className="tool-card peach" onClick={() => navigate('/app/stories/new')}>
          <div className="tool-art" aria-hidden="true"><Icon name="i-sparkles" size={31} /></div>
          <b>Prepare for a situation</b>
          <span>Make a simple plan together</span>
        </button>
        <button className="tool-card lavender" onClick={openChildMode} disabled={!child}>
          <div className="tool-art" aria-hidden="true"><Icon name="i-message-circle" size={31} /></div>
          <b>Practice communication</b>
          <span>Try words, pictures, or gestures</span>
        </button>
        <button className="tool-card mint" onClick={() => navigate('/app/routines')}>
          <div className="tool-art" aria-hidden="true"><Icon name="i-clock-3" size={31} /></div>
          <b>Build a routine</b>
          <span>Make the next step clearer</span>
        </button>
      </div>

      <div id="prepare" className="prepare-layout">
        <div className="prepare-form">
          <SectionTitle
            eyebrow="PREPARE TOGETHER"
            title="A little planning can help a lot."
            detail="Choose a situation and Kindly will start a draft you can edit before your child ever sees it."
          />

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="visually-hidden">What are you getting ready for?</legend>
            <label htmlFor="scenario-list">What are you getting ready for?</label>
            <div className="chip-wrap" id="scenario-list">
              {[...SCENARIOS.slice(0, 5), { key: 'other', label: 'Something else' }].map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className={scenarioKey === s.key ? 'choice selected' : 'choice'}
                  aria-pressed={scenarioKey === s.key}
                  onClick={() => setScenarioKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </fieldset>

          {scenarioKey === 'other' ? (
            <div className="other-field">
              <label htmlFor="situation-other" style={{ margin: '0 0 8px' }}>What are you getting ready for?</label>
              <input
                id="situation-other"
                value={otherSituation}
                onChange={(e) => setOtherSituation(e.target.value)}
                placeholder="e.g. A busy grocery store"
                autoComplete="off"
                aria-describedby="situation-other-help"
              />
              <small id="situation-other-help">A few words is plenty. Kindly will use this in the draft.</small>
            </div>
          ) : null}

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><label>How new does this feel?</label></legend>
            <div className="chip-wrap">
              {[
                { value: 'known', label: 'They know it well' },
                { value: 'a_little_new', label: 'A little new' },
                { value: 'very_new', label: 'Very new' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={difficulty === option.value ? 'choice selected' : 'choice'}
                  aria-pressed={difficulty === option.value}
                  onClick={() => setDifficulty(option.value as typeof difficulty)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><label>What would feel best?</label></legend>
            <div className="format-list">
              {[
                { value: 'text', label: 'Short story', detail: 'A few simple steps in words' },
                { value: 'pictogram', label: 'Visual schedule', detail: 'See what comes next in pictures' },
                { value: 'mixed', label: 'Words and pictures', detail: 'Both together on every page' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={format === option.value ? 'format selected' : 'format'}
                  aria-pressed={format === option.value}
                  onClick={() => setFormat(option.value as typeof format)}
                >
                  <span className="radio" aria-hidden="true" />
                  {option.label}
                  <small>{option.detail}</small>
                </button>
              ))}
            </div>
          </fieldset>

          <Button tone="yellow" icon="i-sparkles" onClick={openBuilder} disabled={!can('can_edit_stories')}>
            Start a story draft
          </Button>
          {!can('can_edit_stories') ? (
            <p className="inline-note">
              <Icon name="i-lock" size={16} strokeWidth={2.5} />
              <span>Your role can read stories but not write them. A family owner can change that in Settings.</span>
            </p>
          ) : null}
        </div>

        <div className="story-preview">
          <div className="empty-preview">
            <div className="preview-dots" aria-hidden="true"><Icon name="i-sparkles" size={30} /></div>
            <h3>Your draft opens in the editor</h3>
            <p>
              Kindly never sends a story straight to your child. You will see every sentence, can
              change any of it, and approve it when you are ready.
            </p>
          </div>
        </div>
      </div>

      <div className="recent-header">
        <SectionTitle eyebrow="STAY CONNECTED" title="Recent requests" />
        <Button tone="ghost" className="text-button" iconAfter="i-arrow-right" onClick={() => navigate('/app/requests')}>
          View requests
        </Button>
      </div>

      {requestsQuery.isLoading ? <LoadingState label="Loading requests" /> : null}
      {requestsQuery.error ? <ErrorState error={requestsQuery.error} onRetry={() => requestsQuery.refetch()} /> : null}

      {!requestsQuery.isLoading && !recent ? (
        <EmptyState
          title="All quiet for now"
          detail={`When ${childLabel(childName)} asks for help, it will show here straight away.`}
        />
      ) : null}

      {recent ? (
        <button
          className="request-card"
          style={{ width: '100%', textAlign: 'left' }}
          onClick={() => navigate(`/app/requests/${recent.request.id}`)}
        >
          <Avatar initial={initialFrom(childName)} label={childLabel(childName, { capital: true })} className="request-avatar" />
          <div>
            <b>{recent.request.childFacingLabel}</b>
            <p>
              {recent.request.urgency === 'urgent' ? 'Urgent' : 'Can wait'}
              {' · '}{STATUS_META[recent.request.status].text}
              {' · '}{formatTime(recent.request.sendingStartedAt ?? recent.request.createdAt)}
            </p>
          </div>
          <StatusPill
            tone={STATUS_META[recent.request.status].tone}
            icon={STATUS_META[recent.request.status].icon}
            text={isLive(recent.request.status) ? STATUS_META[recent.request.status].text : STATUS_META[recent.request.status].text}
          />
        </button>
      ) : null}
    </div>
  );
}
