import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Avatar, Button, Dialog, ErrorState, LoadingState, StatusPill } from '../../components/ui';
import { useAnnouncer, useAuth, useBackend, useWorkspace } from '../../state/providers';
import { childLabel, initialFrom, trustedLabel } from '../../lib/names';
import { formatTime, formatDateTime } from '../../lib/format';
import { STATUS_META, isLive, lifecycleCells, allowedResponses, type ResponseKind } from '../../lib/requests/stateMachine';
import { KindlyError } from '../../lib/types';

/**
 * One request, in full.
 *
 * The action set is derived from three things and nothing else:
 *   - the request's urgency (an urgent request is never offered a delay)
 *   - who it is assigned to (only the assigned adult can answer)
 *   - the state machine (only reachable transitions are offered)
 */
export function RequestDetailPage() {
  const { requestId = '' } = useParams();
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspace, activeFamilyId, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const [confirmResolve, setConfirmResolve] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);

  const query = useQuery({
    queryKey: ['request', requestId],
    queryFn: () => backend.getRequest(requestId),
    enabled: Boolean(requestId),
  });

  useEffect(() => {
    if (!activeFamilyId) return undefined;
    return backend.subscribeToFamily(activeFamilyId, () => {
      void client.invalidateQueries({ queryKey: ['request', requestId] });
    });
  }, [backend, client, activeFamilyId, requestId]);

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['request', requestId] });
    void client.invalidateQueries({ queryKey: ['requests', activeFamilyId] });
    void client.invalidateQueries({ queryKey: ['notifications', activeFamilyId] });
  };

  const onError = (error: unknown) => {
    setActionError(error);
    announce(error instanceof KindlyError ? error.message : 'That did not work. Please try again.', 'assertive');
    invalidate();
  };

  const respond = useMutation({
    mutationFn: (kind: ResponseKind) => backend.respondToRequest({
      requestId,
      kind,
      delayMinutes: kind === 'delay' ? delayMinutes : null,
      message: message.trim() || null,
      urgency: query.data!.request.urgency,
    }),
    onSuccess: (_data, kind) => {
      setActionError(null);
      setMessage('');
      announce(`Your answer was sent: ${LABELS[kind]}.`);
      invalidate();
    },
    onError,
  });

  const claim = useMutation({
    mutationFn: () => backend.claimRequest(requestId),
    onSuccess: () => { setActionError(null); announce('You are now answering this request.'); invalidate(); },
    onError,
  });

  const escalate = useMutation({
    mutationFn: () => backend.escalateRequest(requestId, null),
    onSuccess: () => { setActionError(null); announce('Passed to another trusted caregiver.'); invalidate(); },
    onError,
  });

  const resolve = useMutation({
    mutationFn: (confirm: boolean) => backend.resolveRequest(requestId, confirm),
    onSuccess: () => { setActionError(null); setConfirmResolve(false); announce('This request is finished.'); invalidate(); },
    onError: (e) => { setConfirmResolve(false); onError(e); },
  });

  const cancel = useMutation({
    mutationFn: () => backend.cancelRequestAsCaregiver(requestId, 'Cancelled by caregiver'),
    onSuccess: () => { setActionError(null); setConfirmCancel(false); announce('This request was cancelled.'); invalidate(); },
    onError: (e) => { setConfirmCancel(false); onError(e); },
  });

  if (query.isLoading) return <div className="content-wrap"><LoadingState label="Loading this request" /></div>;
  if (query.error) return <div className="content-wrap"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  if (!query.data) return <div className="content-wrap"><ErrorState error={new Error('That request could not be found.')} /></div>;

  const { request, response, events } = query.data;
  const meta = STATUS_META[request.status];
  const child = workspace?.children.find((c) => c.id === request.childId);
  const childName = child?.childName ?? '';
  const urgent = request.urgency === 'urgent';
  const live = isLive(request.status);
  const mine = !request.assignedToUserId || request.assignedToUserId === user?.id;
  const trusted = (workspace?.trustedCaregivers[request.childId] ?? []).filter((t) => t.isActive)[0];
  const canAnswer = can('can_answer_requests');

  const permitted = allowedResponses(request.urgency);
  const escalations = events.filter((e) => e.kind === 'escalated' || e.kind === 'assigned');

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/requests')}>
        <Icon name="i-arrow-left" size={17} /> Back to requests
      </button>

      {actionError ? <ErrorState error={actionError} onRetry={() => setActionError(null)} /> : null}

      <div className="inbox-card">
        <Avatar initial={initialFrom(childName)} label={childLabel(childName, { capital: true })} className="request-avatar" />

        <div className="inbox-main">
          <div className="inbox-title">
            <b>{childLabel(childName, { capital: true })} {urgent ? 'needs help now' : 'asked for something'}</b>
            <StatusPill tone={meta.tone} icon={meta.icon} text={meta.text} />
          </div>

          <h3>{request.childFacingLabel}</h3>
          <p>
            {request.childFacingDetail ? `“${request.childFacingDetail}” · ` : ''}
            {request.deliveredAt ? `Delivered ${formatTime(request.deliveredAt)}` : 'Not delivered yet'}
          </p>
          {request.customMessage ? (
            <p className="inline-note"><Icon name="i-message-circle" size={16} /><span>{request.customMessage}</span></p>
          ) : null}

          <ol className="lifecycle" aria-label="Request progress">
            {lifecycleCells(request.status).map((cell) => (
              <li
                key={cell.label}
                className={cell.state === 'done' ? 'done' : cell.state === 'now' ? 'now' : cell.state === 'stopped' ? 'stop' : ''}
                aria-current={cell.state === 'now' ? 'step' : undefined}
              >
                {cell.label}
                {cell.state === 'stopped' ? <span className="visually-hidden"> — stopped here</span> : null}
                {cell.state === 'done' ? <span className="visually-hidden"> — done</span> : null}
              </li>
            ))}
          </ol>

          <dl className="meta-grid">
            <MetaCell label="CHILD" value={childLabel(childName, { capital: true })} />
            <MetaCell label="URGENCY" value={urgent ? 'Urgent' : 'Can wait'} />
            <MetaCell label="SENT" value={formatTime(request.sendingStartedAt ?? request.createdAt) || 'Not sent'} />
            <MetaCell label="DELIVERED" value={request.deliveredAt ? formatTime(request.deliveredAt) : 'Not delivered'} />
            <MetaCell label="ACKNOWLEDGED" value={request.acknowledgedAt ? formatTime(request.acknowledgedAt) : 'Not yet'} />
            <MetaCell label="ASSIGNED TO" value={request.assignedToName ?? 'Nobody yet'} />
            <MetaCell
              label="RESPONSE"
              value={response ? describeResponse(response) : 'None yet'}
            />
            <MetaCell label="ATTEMPTS" value={String(request.attempts)} />
            <MetaCell label="CONNECTION" value={request.connectionState ?? 'unknown'} />
            <MetaCell label="REQUEST ID" value={request.id.slice(0, 8).toUpperCase()} />
          </dl>

          {escalations.length > 0 ? (
            <ul className="escalation-log">
              {escalations.map((e) => (
                <li key={e.id}>
                  <Icon name="i-users" size={15} strokeWidth={2.5} />
                  <span>
                    {String(e.detail.reason ?? 'Passed on')} — to {String(e.detail.to ?? 'another caregiver')} at {formatTime(e.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {!mine && live ? (
            <div className="note-strip">
              <Icon name="i-users" size={16} strokeWidth={2.5} />
              <span>
                This request is assigned to {request.assignedToName}. Only {request.assignedToName} can
                answer it, so {childLabel(childName)} does not get two different answers. Take it back if
                you can help now.
              </span>
            </div>
          ) : null}

          {urgent ? (
            <div className="note-strip">
              <Icon name="i-shield" size={16} strokeWidth={2.5} />
              <span>
                Urgent requests can only be answered with something that happens now. Kindly is not
                an emergency service — if this is an emergency, call your local emergency number.
                {child?.emergencyInstructions ? ` Your family note: ${child.emergencyInstructions}` : ''}
              </span>
            </div>
          ) : null}

          {live && canAnswer ? (
            <div className="inbox-actions">
              {!mine ? (
                <Button tone="coral" icon="i-arrow-left" onClick={() => claim.mutate()} loading={claim.isPending}>
                  I will take this back
                </Button>
              ) : (
                <>
                  {permitted.includes('seen') && (!response || response.kind === 'seen') ? (
                    <Button tone="secondary" icon="i-check" onClick={() => respond.mutate('seen')} loading={respond.isPending}>
                      I have seen this
                    </Button>
                  ) : null}

                  <Button tone="coral" icon="i-arrow-right" onClick={() => respond.mutate('coming_now')} loading={respond.isPending}>
                    I’m coming now
                  </Button>

                  {permitted.includes('delay') ? (
                    <>
                      <label className="visually-hidden" htmlFor="delay-minutes">Minutes until you arrive</label>
                      <select
                        id="delay-minutes"
                        value={delayMinutes}
                        onChange={(e) => setDelayMinutes(Number(e.target.value))}
                        style={{ maxWidth: 140 }}
                      >
                        {[2, 5, 10, 15, 30].map((m) => <option key={m} value={m}>In {m} minutes</option>)}
                      </select>
                      <Button tone="yellow" icon="i-clock-3" onClick={() => respond.mutate('delay')} loading={respond.isPending}>
                        In {delayMinutes} minutes
                      </Button>
                    </>
                  ) : null}

                  {permitted.includes('safe_adult') && child?.safeAdult ? (
                    <Button tone="yellow" icon="i-users" onClick={() => respond.mutate('safe_adult')} loading={respond.isPending}>
                      Go to {child.safeAdult}
                    </Button>
                  ) : null}

                  {permitted.includes('safe_place') && child?.safePlace ? (
                    <Button tone="yellow" icon="i-pin" onClick={() => respond.mutate('safe_place')} loading={respond.isPending}>
                      Go to {child.safePlace}
                    </Button>
                  ) : null}

                  {trusted ? (
                    <Button tone="secondary" icon="i-users" onClick={() => respond.mutate('other_caregiver')} loading={respond.isPending}>
                      {trustedLabel(trusted.trustedCaregiverName, { capital: true })} is coming
                    </Button>
                  ) : null}

                  {trusted && request.status !== 'escalated' ? (
                    <Button tone="secondary" icon="i-users" onClick={() => escalate.mutate()} loading={escalate.isPending}>
                      Escalate to {trusted.trustedCaregiverName}
                    </Button>
                  ) : null}
                </>
              )}

              <Button
                tone="secondary"
                icon="i-check"
                onClick={() => (urgent ? setConfirmResolve(true) : resolve.mutate(false))}
                loading={resolve.isPending}
              >
                Mark resolved
              </Button>

              <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmCancel(true)}>
                Cancel this request
              </Button>
            </div>
          ) : null}

          {live && mine ? (
            <div className="field-block" style={{ marginTop: 14 }}>
              <label htmlFor="response-message">Add a short note for {childLabel(childName)} (optional)</label>
              <input
                id="response-message"
                value={message}
                maxLength={200}
                placeholder="e.g. Meet me in the kitchen"
                onChange={(e) => setMessage(e.target.value)}
                aria-describedby="response-message-help"
              />
              <small className="field-hint" id="response-message-help">
                Sent with your next answer. Keep it short and literal.
              </small>
            </div>
          ) : null}

          {!canAnswer ? (
            <div className="note-strip">
              <Icon name="i-lock" size={16} strokeWidth={2.5} />
              <span>Your role can see requests but not answer them. A family owner can change that in Settings.</span>
            </div>
          ) : null}

          {!live ? (
            <div className="inbox-actions">
              <Button tone="secondary" icon="i-arrow-left" onClick={() => navigate('/app/requests')}>
                Back to requests
              </Button>
            </div>
          ) : null}

          <details style={{ marginTop: 18 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>
              Full history ({events.length} {events.length === 1 ? 'entry' : 'entries'})
            </summary>
            <ul className="escalation-log" style={{ marginTop: 10 }}>
              {events.map((e) => (
                <li key={e.id}>
                  <Icon name="i-clock-3" size={15} strokeWidth={2.5} />
                  <span>
                    {formatDateTime(e.occurredAt)} — {e.kind.replace(/_/g, ' ')}
                    {e.fromStatus && e.toStatus ? `: ${e.fromStatus} to ${e.toStatus}` : ''}
                    {e.actorName ? ` (${e.actorName})` : ` (${e.actorKind})`}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      <Dialog
        open={confirmResolve}
        alert
        title="Is everything alright now?"
        description={`This is an urgent request. Please confirm that ${childLabel(childName)} is safe and no longer waiting before you close it.`}
        onClose={() => setConfirmResolve(false)}
        actions={
          <>
            <Button tone="coral" onClick={() => resolve.mutate(true)} loading={resolve.isPending}>
              Yes, it is resolved
            </Button>
            <Button tone="secondary" onClick={() => setConfirmResolve(false)}>Not yet</Button>
          </>
        }
      />

      <Dialog
        open={confirmCancel}
        alert
        danger
        title="Cancel this request?"
        description={`${childLabel(childName, { capital: true })} will see that the request was cancelled. If they still need help they will have to ask again.`}
        onClose={() => setConfirmCancel(false)}
        actions={
          <>
            <Button tone="danger" onClick={() => cancel.mutate()} loading={cancel.isPending}>
              Yes, cancel it
            </Button>
            <Button tone="secondary" onClick={() => setConfirmCancel(false)}>Keep it open</Button>
          </>
        }
      />
    </div>
  );
}

const LABELS: Record<ResponseKind, string> = {
  seen: 'I have seen this',
  coming_now: 'I am coming now',
  delay: 'In a few minutes',
  other_caregiver: 'Another caregiver is coming',
  safe_adult: 'Go to your safe adult',
  safe_place: 'Go to your safe place',
};

function describeResponse(response: import('../../lib/types').RequestResponse): string {
  if (response.kind === 'delay') return `In ${response.delayMinutes} minutes (${response.responderName})`;
  return `${LABELS[response.kind]} (${response.responderName})`;
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt><span>{label}</span></dt>
      <dd><b>{value}</b></dd>
    </div>
  );
}
