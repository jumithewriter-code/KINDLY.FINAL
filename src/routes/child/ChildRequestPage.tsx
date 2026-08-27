import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession, useIsOnline } from '../../state/providers';
import { caregiverLabel } from '../../lib/names';
import { describeDuration, formatClock } from '../../lib/format';
import { STATUS_META, isLive } from '../../lib/requests/stateMachine';
import type { RequestBundle } from '../../lib/types';

/**
 * One request, from the child's side.
 *
 * Copy rules enforced here:
 *   - "Delivered" is only ever shown when the server has set delivered_at
 *   - it never says a caregiver has seen the request until it is acknowledged
 *   - a delayed answer shows a timer only if this child's profile allows it;
 *     otherwise a non-numeric progress bar with words
 *   - "unavailable" always ends in something the child can actually do
 */
export function ChildRequestPage() {
  const { requestId = '' } = useParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const client = useQueryClient();
  const { token, space } = useChildSession();
  const { announce } = useAnnouncer();
  const online = useIsOnline();

  const [actionError, setActionError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());

  const query = useQuery({
    queryKey: ['child-requests', token],
    queryFn: () => backend.childGetRequests(token!),
    enabled: Boolean(token),
    refetchInterval: 3000,
  });

  const bundle: RequestBundle | undefined = useMemo(
    () => query.data?.find((b) => b.request.id === requestId),
    [query.data, requestId],
  );

  const prefs = space?.preferences;
  const showCountdown = prefs?.countdownsVisible ?? false;

  // A one-second tick, only while a countdown is actually on screen.
  useEffect(() => {
    if (!bundle?.response?.dueAt) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [bundle?.response?.dueAt]);

  const invalidate = () => client.invalidateQueries({ queryKey: ['child-requests'] });

  const send = useMutation({
    mutationFn: () => backend.childSendRequest(token!, requestId, online ? 'online' : 'offline'),
    onSuccess: (request) => {
      setActionError(null);
      invalidate();
      announce(STATUS_META[request.status].announcement, request.urgency === 'urgent' ? 'assertive' : 'polite');
    },
    onError: (e) => { setActionError(e); announce('Your message did not send. You can try again.', 'assertive'); },
  });

  const cancel = useMutation({
    mutationFn: () => backend.childCancelRequest(token!, requestId),
    onSuccess: () => { setActionError(null); invalidate(); announce('Your message was cancelled.'); },
    onError: (e) => setActionError(e),
  });

  const resolve = useMutation({
    mutationFn: () => backend.childResolveRequest(token!, requestId),
    onSuccess: () => { setActionError(null); invalidate(); announce('All done. Thank you for asking.'); },
    onError: (e) => setActionError(e),
  });

  // Announce every status change once.
  const lastStatus = useRef<string>('');
  useEffect(() => {
    if (!bundle) return;
    if (lastStatus.current === bundle.request.status) return;
    lastStatus.current = bundle.request.status;
    announce(STATUS_META[bundle.request.status].announcement,
      bundle.request.urgency === 'urgent' ? 'assertive' : 'polite');
  }, [bundle, announce]);

  if (query.isLoading) return <div className="sent-screen"><LoadingState label="Getting your message" /></div>;

  if (!bundle) {
    return (
      <div className="sent-screen">
        <ErrorState error={new Error('That message is not here any more.')} />
        <div className="big-actions">
          <Button tone="coral" big icon="i-arrow-left" onClick={() => navigate('/child')}>Back to my day</Button>
        </div>
      </div>
    );
  }

  const { request, response } = bundle;
  const status = request.status;
  const caregiverName = request.assignedToName;
  const safeAdult = space?.child.safeAdult ?? null;
  const safePlace = space?.child.safePlace ?? null;

  const offlineSteps = [
    safeAdult ? { icon: 'i-users', text: `Go to ${safeAdult}.` } : { icon: 'i-users', text: 'Go to a grown-up you know.' },
    safePlace ? { icon: 'i-pin', text: `Or go to ${safePlace}.` } : { icon: 'i-pin', text: 'Or go somewhere you feel safe.' },
    { icon: 'i-shield', text: 'If you are not safe, tell any grown-up near you.' },
  ];

  let heading = '';
  let body = '';
  let heroTone = '';
  let showOfflineSteps = false;

  switch (status) {
    case 'reviewing':
      heading = `${request.childFacingLabel}?`;
      body = `This says: “${request.childFacingDetail ?? request.childFacingLabel}”. Send it to ${caregiverLabel(caregiverName)}, or pick something else.`;
      break;
    case 'sending':
      heading = 'Sending…';
      body = 'Nothing has arrived yet. Please wait a moment.';
      break;
    case 'retrying':
      heading = 'Trying again…';
      body = 'Nothing has arrived yet. Please wait a moment.';
      break;
    case 'delivered':
      heading = 'Your message arrived.';
      body = `It is on ${caregiverLabel(caregiverName)}’s phone. Nobody has opened it yet.`;
      heroTone = ' good';
      break;
    case 'waiting':
      heading = 'No answer yet.';
      body = 'Kindly is asking another grown-up to help you now.';
      break;
    case 'escalated':
      heading = `${caregiverName ?? 'Another trusted grown-up'} has been asked.`;
      body = 'They were asked because nobody answered in time.';
      break;
    case 'unavailable':
      heading = 'No one has answered.';
      body = 'Do not wait here. Do one of these things now.';
      heroTone = ' bad';
      showOfflineSteps = true;
      break;
    case 'failed':
      heading = request.failureReason === 'offline'
        ? 'Not sent. You are offline.'
        : request.failureReason === 'interrupted'
          ? 'Kindly could not check it was sent.'
          : 'Not delivered.';
      body = request.failureReason === 'interrupted'
        ? 'Your message may not have arrived. Nobody may have seen it. You can try again.'
        : 'Your message was not delivered. Nobody has seen it.';
      heroTone = ' bad';
      showOfflineSteps = request.failureReason === 'offline';
      break;
    case 'acknowledged': {
      heroTone = ' good';
      const who = response?.responderName ?? caregiverLabel(caregiverName, { capital: true });
      switch (response?.kind) {
        case 'coming_now':
          heading = `${who} is coming now.`;
          body = 'You are not alone. You can wait however feels right for you.';
          break;
        case 'delay':
          heading = `${who} will come in ${response.delayMinutes} minutes.`;
          body = 'You can wait here, or go and do something else and come back.';
          break;
        case 'other_caregiver':
          heading = `${who} is coming to help.`;
          body = 'Someone else could not come, so they are on the way.';
          break;
        case 'safe_place':
          heading = safePlace ? `Go to ${safePlace}.` : 'Go to your safe place.';
          body = `${who} will meet you there. You can go now.`;
          break;
        case 'safe_adult':
          heading = safeAdult ? `Go to ${safeAdult}.` : 'Go to a grown-up you know.';
          body = `${who} has asked them to help you.`;
          break;
        default:
          heading = `${who} has seen your message.`;
          body = 'You can wait here. They will tell you what happens next.';
      }
      break;
    }
    case 'resolved':
      heading = 'All done.';
      body = 'Thank you for telling someone what you needed.';
      heroTone = ' good';
      break;
    case 'cancelled':
      heading = 'Message cancelled.';
      body = request.deliveredAt
        ? `${caregiverLabel(caregiverName, { capital: true })} has been told you changed your mind.`
        : 'Nothing was sent.';
      break;
    default:
      // Every status is covered above; this keeps the copy honest if one is added.
      heading = 'Your message';
      body = 'Kindly is keeping this up to date.';
  }

  if (response?.message) body = `${body} ${response.message}`;

  const meta = STATUS_META[status];
  const sending = status === 'sending' || status === 'retrying' || send.isPending;

  // Timer for a delayed answer.
  const dueAt = response?.dueAt ? new Date(response.dueAt).getTime() : null;
  const totalMs = response?.delayMinutes ? response.delayMinutes * 60_000 : null;
  const leftMs = dueAt ? Math.max(0, dueAt - now) : null;
  const percent = leftMs != null && totalMs ? Math.max(0, Math.min(100, Math.round((leftMs / totalMs) * 100))) : null;

  function readAloud() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(`${heading} ${body}`);
    utterance.rate = prefs?.readAloudRate ?? 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  return (
    <div className="sent-screen">
      <div className={`req-hero${heroTone}`} aria-hidden="true">
        <Icon
          name={sending ? 'i-loader' : status === 'failed' || status === 'unavailable' ? 'i-alert' : request.pictogramKey ?? 'i-help'}
          size={42}
          strokeWidth={2.5}
          className={sending && prefs?.animationEnabled ? 'req-spin' : undefined}
        />
      </div>

      <span className={`status-line${heroTone === ' bad' ? ' urgent' : heroTone === ' good' ? ' good' : ''}`}>
        <Icon name={meta.icon} size={15} strokeWidth={2.75} />
        {status === 'failed' && request.failureReason === 'offline' ? 'Offline — not sent'
          : status === 'failed' && request.failureReason === 'interrupted' ? 'Delivery not confirmed'
            : meta.text}
      </span>

      <h1>{heading}</h1>
      <p>{body}</p>

      {prefs?.readAloudEnabled ? (
        <button className="read-aloud-button" onClick={readAloud}>
          <Icon name="i-play" size={16} /> Read this to me
        </button>
      ) : null}

      {actionError ? <ErrorState error={actionError} onRetry={() => setActionError(null)} title="That did not work" /> : null}

      {status === 'acknowledged' && response?.kind === 'delay' && leftMs != null ? (
        <div className="timer-block">
          <div className="timer-head">
            <span>
              {leftMs > 0
                ? `Time until ${response.responderName} comes`
                : 'The time is up. You can ask again if you still need help.'}
            </span>
            {showCountdown ? <span aria-hidden="true">{formatClock(leftMs)}</span> : null}
          </div>
          <div
            className="timer-track"
            role="progressbar"
            aria-label={showCountdown ? `Time left: ${describeDuration(leftMs)}` : 'How much of the wait is left'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? 0}
            aria-valuetext={showCountdown ? describeDuration(leftMs) : `${percent}% of the wait left`}
          >
            <div className="timer-fill" style={{ width: `${percent ?? 0}%` }} />
          </div>
        </div>
      ) : null}

      {showOfflineSteps ? (
        <ul className="offline-steps">
          {offlineSteps.map((step) => (
            <li key={step.text}>
              <Icon name={step.icon} size={19} strokeWidth={2.5} />
              <span>{step.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="big-actions">
        {status === 'reviewing' ? (
          <>
            <Button tone="coral" big icon="i-send" onClick={() => send.mutate()} loading={send.isPending} loadingLabel="Sending…">
              Send request
            </Button>
            <Button tone="ghost" big icon="i-arrow-left" onClick={() => { cancel.mutate(); navigate('/child/help'); }}>
              Change request
            </Button>
          </>
        ) : null}

        {status === 'sending' || status === 'retrying' ? (
          <Button tone="ghost" big icon="i-x-circle" onClick={() => cancel.mutate()} loading={cancel.isPending}>
            I changed my mind
          </Button>
        ) : null}

        {status === 'delivered' || status === 'waiting' || status === 'escalated' ? (
          <>
            <Button tone="ghost" big icon="i-x-circle" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              I changed my mind
            </Button>
            <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>
              Back to my day
            </Button>
          </>
        ) : null}

        {status === 'acknowledged' ? (
          <>
            <Button tone="coral" big icon="i-check" onClick={() => resolve.mutate()} loading={resolve.isPending}>
              Thank you, all done
            </Button>
            <Button tone="ghost" big icon="i-x-circle" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              I do not need help now
            </Button>
            <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>
              Back to my day
            </Button>
          </>
        ) : null}

        {status === 'failed' || status === 'unavailable' ? (
          <>
            <Button tone="coral" big icon="i-refresh" onClick={() => send.mutate()} loading={send.isPending} loadingLabel="Trying again…">
              Try again
            </Button>
            <Button tone="ghost" big icon="i-arrow-left" onClick={() => { cancel.mutate(); navigate('/child/help'); }}>
              Change request
            </Button>
            <Button tone="danger" big icon="i-shield" onClick={() => navigate('/child/offline-help')}>
              Find a grown-up now
            </Button>
          </>
        ) : null}

        {status === 'resolved' || status === 'cancelled' ? (
          <Button tone="coral" big iconAfter="i-arrow-right" onClick={() => navigate('/child')}>
            Back to my day
          </Button>
        ) : null}
      </div>

      {isLive(status) ? (
        <p style={{ fontSize: 13, color: 'var(--muted-foreground)', marginTop: 18 }}>
          You can leave this screen. Your message stays here and Kindly will keep it up to date.
        </p>
      ) : null}
    </div>
  );
}
