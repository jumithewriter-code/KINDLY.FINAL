import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession, useIsOnline } from '../../state/providers';
import { dedupeKey } from '../../lib/format';
import type { FeelingOption } from '../../lib/types';

/**
 * "How I feel".
 *
 * Feelings and body sensations sit side by side, and "I don't know" and
 * "Something else" are first-class choices, not fallbacks. Nothing here is a
 * diagnosis, nothing asks the child to calm down or to return to "normal", and
 * intensity is optional.
 *
 * A feeling shares the request lifecycle, so it is delivered, acknowledged and
 * cancellable in exactly the same honest way as a help request.
 */

const FEELINGS: FeelingOption[] = [
  { key: 'happy', label: 'Happy', detail: null, pictogramKey: 'i-heart', colorKey: 'yellow', group: 'feeling' },
  { key: 'calm', label: 'Calm', detail: null, pictogramKey: 'i-pause', colorKey: 'mint', group: 'feeling' },
  { key: 'excited', label: 'Excited', detail: null, pictogramKey: 'i-sparkles', colorKey: 'peach', group: 'feeling' },
  { key: 'tired', label: 'Tired', detail: null, pictogramKey: 'i-clock-3', colorKey: 'blue', group: 'feeling' },
  { key: 'worried', label: 'Worried', detail: null, pictogramKey: 'i-alert', colorKey: 'purple', group: 'feeling' },
  { key: 'angry', label: 'Angry', detail: null, pictogramKey: 'i-alert', colorKey: 'coral', group: 'feeling' },
  { key: 'sad', label: 'Sad', detail: null, pictogramKey: 'i-droplet', colorKey: 'blue', group: 'feeling' },
  { key: 'overloaded', label: 'Too much is happening', detail: null, pictogramKey: 'i-offline', colorKey: 'coral', group: 'feeling' },

  { key: 'body_sore', label: 'Something hurts', detail: null, pictogramKey: 'i-hurt', colorKey: 'coral', group: 'body' },
  { key: 'body_hot', label: 'My body feels hot', detail: null, pictogramKey: 'i-droplet', colorKey: 'peach', group: 'body' },
  { key: 'body_busy', label: 'My body feels busy', detail: null, pictogramKey: 'i-sparkles', colorKey: 'purple', group: 'body' },
  { key: 'body_heavy', label: 'My body feels heavy', detail: null, pictogramKey: 'i-pause', colorKey: 'blue', group: 'body' },
  { key: 'body_hungry', label: 'I feel hungry', detail: null, pictogramKey: 'i-droplet', colorKey: 'mint', group: 'body' },

  { key: 'unsure', label: 'I do not know', detail: null, pictogramKey: 'i-help', colorKey: 'blue', group: 'unsure' },
  { key: 'other', label: 'Something else', detail: null, pictogramKey: 'i-more', colorKey: 'purple', group: 'unsure' },
];

const INTENSITIES = [
  { key: 'a_little', label: 'A little' },
  { key: 'medium', label: 'In the middle' },
  { key: 'a_lot', label: 'A lot' },
  { key: 'not_sure', label: 'I am not sure' },
] as const;

const SUPPORTS = [
  { key: 'be_with_me', label: 'Come and be with me' },
  { key: 'quiet', label: 'I want somewhere quieter' },
  { key: 'break', label: 'I want a break' },
  { key: 'nothing', label: 'I just wanted to tell you' },
] as const;

export function ChildFeelingsPage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const client = useQueryClient();
  const { token, space } = useChildSession();
  const { announce } = useAnnouncer();
  const online = useIsOnline();

  const [feeling, setFeeling] = useState<FeelingOption | null>(null);
  const [intensity, setIntensity] = useState<string | null>(null);
  const [support, setSupport] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const key = useRef<string | null>(null);

  const allowNote = space?.preferences.allowCustomMessage ?? true;

  const send = useMutation({
    mutationFn: async () => {
      if (!feeling) throw new Error('Choose a feeling first.');
      if (!key.current) key.current = dedupeKey('feel');
      const parts = [
        intensity ? INTENSITIES.find((i) => i.key === intensity)?.label : null,
        support ? SUPPORTS.find((s) => s.key === support)?.label : null,
        allowNote && note.trim() ? note.trim() : null,
      ].filter(Boolean);
      const request = await backend.childCreateRequest(token!, {
        typeSlug: 'feeling',
        dedupeKey: key.current,
        labelOverride: feeling.label,
        detailOverride: intensity ? INTENSITIES.find((i) => i.key === intensity)?.label ?? null : null,
        customMessage: parts.join(' · ') || null,
        connectionState: online ? 'online' : 'offline',
      });
      return backend.childSendRequest(token!, request.id, online ? 'online' : 'offline');
    },
    onSuccess: (request) => {
      setError(null);
      void client.invalidateQueries({ queryKey: ['child-requests'] });
      announce('Your message has been sent.');
      navigate(`/child/request/${request.id}`);
    },
    onError: (e) => { setError(e); announce('That did not send. You can try again.', 'assertive'); },
  });

  function reset() {
    setFeeling(null);
    setIntensity(null);
    setSupport(null);
    setNote('');
    key.current = null;
  }

  const renderGroup = (group: FeelingOption['group'], heading: string, description: string) => (
    <section className="help-group" aria-labelledby={`feelings-${group}`}>
      <h2 id={`feelings-${group}`}>{heading}</h2>
      <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--muted-foreground)' }}>{description}</p>
      <div className="feelings-grid">
        {FEELINGS.filter((f) => f.group === group).map((option) => (
          <button
            key={option.key}
            className={`help-card ${option.colorKey}`}
            aria-pressed={feeling?.key === option.key}
            onClick={() => { setFeeling(option); announce(`${option.label} chosen. You can change it.`); }}
          >
            <span className="pictogram" aria-hidden="true">
              <Icon name={option.pictogramKey} size={26} strokeWidth={2.75} />
            </span>
            <b>{option.label}</b>
            {feeling?.key === option.key ? (
              <span className="req-tag"><Icon name="i-check" size={11} strokeWidth={3} /> Chosen</span>
            ) : null}
          </button>
        ))}
      </div>
    </section>
  );

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child')}>
        <Icon name="i-arrow-left" size={17} /> Back
      </button>

      <div className="child-greeting">
        <span className="eyebrow">HOW I FEEL</span>
        <h1>You can tell someone how you feel.</h1>
        <p>You do not have to. You can choose one, change it, or stop at any time.</p>
      </div>

      {error ? <ErrorState error={error} onRetry={() => setError(null)} title="That did not send" /> : null}

      {renderGroup('feeling', 'Feelings', 'Pick the one that fits best. There is no right answer.')}
      {renderGroup('body', 'What my body feels like', 'Some things happen in your body rather than in your thoughts.')}
      {renderGroup('unsure', 'If you are not sure', 'Not knowing is a real answer.')}

      {feeling ? (
        <section className="help-group" aria-labelledby="feeling-detail">
          <h2 id="feeling-detail">You chose: {feeling.label}</h2>

          <h3 style={{ fontSize: 16 }}>How much? (you can skip this)</h3>
          <div className="intensity-row">
            {INTENSITIES.map((option) => (
              <button
                key={option.key}
                className="intensity-option"
                aria-pressed={intensity === option.key}
                onClick={() => setIntensity(intensity === option.key ? null : option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <h3 style={{ fontSize: 16, marginTop: 18 }}>Would something help? (you can skip this)</h3>
          <div className="intensity-row">
            {SUPPORTS.map((option) => (
              <button
                key={option.key}
                className="intensity-option"
                aria-pressed={support === option.key}
                onClick={() => setSupport(support === option.key ? null : option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {allowNote ? (
            <div className="field-block" style={{ marginTop: 18 }}>
              <label htmlFor="feeling-note">Add your own words (you can skip this)</label>
              <input
                id="feeling-note"
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                aria-describedby="feeling-note-help"
              />
              <small className="field-hint" id="feeling-note-help">
                Anything you write is sent with your message.
              </small>
            </div>
          ) : null}

          <div className="big-actions">
            <Button tone="coral" big icon="i-send" onClick={() => send.mutate()} loading={send.isPending} loadingLabel="Sending…">
              Send this
            </Button>
            <Button tone="ghost" big icon="i-refresh" onClick={reset}>Change my answer</Button>
            <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>
              Not now, back to my day
            </Button>
          </div>
        </section>
      ) : (
        <div className="big-actions">
          <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>Back to my day</Button>
        </div>
      )}
    </div>
  );
}
