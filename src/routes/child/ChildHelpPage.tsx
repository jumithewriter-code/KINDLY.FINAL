import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession, useIsOnline } from '../../state/providers';
import { dedupeKey } from '../../lib/format';
import type { RequestType } from '../../lib/types';

/**
 * "I need help with…"
 *
 * Two clearly separated groups, urgent first. Each card carries a symbol, a
 * short literal label, a detail line and a visible "Urgent" / "Can wait" tag —
 * so urgency is never signalled by colour alone.
 *
 * Repeated tapping is safe: the idempotency key for one tap-intent is created
 * once and reused, and the server returns the same request rather than making
 * a second one.
 */
export function ChildHelpPage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const client = useQueryClient();
  const { token, space } = useChildSession();
  const { announce } = useAnnouncer();
  const online = useIsOnline();

  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const keys = useRef<Map<string, string>>(new Map());

  const create = useMutation({
    mutationFn: (type: RequestType) => {
      if (!keys.current.has(type.slug)) keys.current.set(type.slug, dedupeKey('req'));
      return backend.childCreateRequest(token!, {
        typeSlug: type.slug,
        dedupeKey: keys.current.get(type.slug)!,
        connectionState: online ? 'online' : 'offline',
      });
    },
    onMutate: (type) => { setPendingSlug(type.slug); setError(null); },
    onSuccess: (request) => {
      setPendingSlug(null);
      void client.invalidateQueries({ queryKey: ['child-requests'] });
      navigate(`/child/request/${request.id}`);
    },
    onError: (e) => {
      setPendingSlug(null);
      setError(e);
      announce('That did not work. You can try again, or find a grown-up near you.', 'assertive');
    },
  });

  if (!space) return <LoadingState label="Getting your choices ready" />;

  const types = space.requestTypes.filter((t) => t.slug !== 'feeling');
  const urgent = types.filter((t) => t.urgency === 'urgent');
  const canWait = types.filter((t) => t.urgency !== 'urgent');

  const renderCard = (type: RequestType) => (
    <button
      key={type.slug}
      className={`help-card ${type.colorKey}`}
      onClick={() => create.mutate(type)}
      disabled={pendingSlug === type.slug}
      aria-label={`${type.childFacingLabel}. ${type.childFacingDetail ?? ''} ${type.urgency === 'urgent' ? 'Urgent request.' : 'This can wait.'}`}
    >
      <span className="pictogram" aria-hidden="true">
        <Icon name={type.pictogramKey ?? 'i-help'} size={28} strokeWidth={2.75} />
      </span>
      <b>{type.childFacingLabel}</b>
      <small>{type.childFacingDetail}</small>
      <span className="req-tag">
        <Icon name={type.urgency === 'urgent' ? 'i-alert' : 'i-clock-3'} size={11} strokeWidth={3} />
        {type.urgency === 'urgent' ? 'Urgent' : 'Can wait'}
      </span>
    </button>
  );

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child')}>
        <Icon name="i-arrow-left" size={17} /> Back
      </button>

      <div className="child-greeting">
        <span className="eyebrow">I NEED HELP WITH…</span>
        <h1>What do you need?</h1>
        <p>Choose one. You can change your mind.</p>
      </div>

      {error ? (
        <ErrorState
          error={error}
          onRetry={() => setError(null)}
          title="That did not send"
        />
      ) : null}

      {!online ? (
        <p className="inline-note">
          <Icon name="i-offline" size={16} strokeWidth={2.5} />
          <span>You are offline. Kindly will tell you honestly if a message does not arrive.</span>
        </p>
      ) : null}

      <section className="help-group" aria-labelledby="urgent-heading">
        <h2 id="urgent-heading">
          <Icon name="i-alert" size={18} strokeWidth={2.75} /> I need help now
        </h2>
        <div className="help-grid">{urgent.map(renderCard)}</div>
      </section>

      <section className="help-group" aria-labelledby="canwait-heading">
        <h2 id="canwait-heading">
          <Icon name="i-clock-3" size={18} strokeWidth={2.75} /> This can wait a little
        </h2>
        <div className="help-grid">{canWait.map(renderCard)}</div>
      </section>

      <div className="big-actions">
        <Button tone="danger" big icon="i-shield" onClick={() => navigate('/child/offline-help')}>
          Find a grown-up now
        </Button>
      </div>
    </div>
  );
}
