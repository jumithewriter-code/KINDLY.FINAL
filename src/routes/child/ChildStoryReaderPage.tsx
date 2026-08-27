import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession } from '../../state/providers';

/**
 * The story reader.
 *
 * Position is remembered, never enforced: the child can move in any order, stop
 * at any time, and nothing is scored. The four feedback buttons send a message
 * to a caregiver only after the child confirms, and the confirmation says
 * exactly who will see it.
 */
const FEEDBACK = [
  { kind: 'this_is_different', label: 'This is different', detail: 'The real thing was not like this' },
  { kind: 'i_have_a_question', label: 'I have a question', detail: 'I want to ask a grown-up' },
  { kind: 'i_need_a_break', label: 'I need a break', detail: 'I want to stop for now' },
  { kind: 'i_do_not_want_this_story', label: 'I do not want this story', detail: 'Please do not show me this one' },
] as const;

export function ChildStoryReaderPage() {
  const { storyId = '' } = useParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const { token, space } = useChildSession();
  const { announce } = useAnnouncer();

  const [page, setPage] = useState(0);
  const [pendingFeedback, setPendingFeedback] = useState<(typeof FEEDBACK)[number] | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const query = useQuery({
    queryKey: ['child-stories', token],
    queryFn: () => backend.childGetStories(token!),
    enabled: Boolean(token),
  });

  const story = query.data?.find((s) => s.id === storyId);

  useEffect(() => {
    if (story) setPage(Math.min(story.lastPage, Math.max(0, story.pages.length - 1)));
  }, [story?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveProgress = useMutation({
    mutationFn: (next: number) => backend.childSetStoryProgress(token!, storyId, next),
  });

  const sendFeedback = useMutation({
    mutationFn: (kind: (typeof FEEDBACK)[number]['kind']) =>
      backend.childSendStoryFeedback(token!, storyId, kind, page),
    onSuccess: (_d, kind) => {
      setPendingFeedback(null);
      setSent(FEEDBACK.find((f) => f.kind === kind)?.label ?? 'Your message');
      announce('Your message has been sent to a grown-up.');
    },
    onError: (e) => { setPendingFeedback(null); setError(e); },
  });

  function goTo(next: number) {
    if (!story) return;
    const clamped = Math.max(0, Math.min(story.pages.length - 1, next));
    setPage(clamped);
    saveProgress.mutate(clamped);
    announce(`Page ${clamped + 1} of ${story.pages.length}.`);
  }

  function readAloud() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !story) return;
    const current = story.pages[page];
    if (!current) return;
    const utterance = new SpeechSynthesisUtterance(`${current.heading ?? ''}. ${current.body}`);
    utterance.rate = space?.preferences.readAloudRate ?? 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  if (query.isLoading) return <div className="sent-screen"><LoadingState label="Getting your story" /></div>;

  if (!story) {
    return (
      <div className="sent-screen">
        <ErrorState error={new Error('That story is not here any more. A grown-up may have taken it away.')} />
        <div className="big-actions">
          <Button tone="coral" big icon="i-arrow-left" onClick={() => navigate('/child/stories')}>Back to my stories</Button>
        </div>
      </div>
    );
  }

  const current = story.pages[page];

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child/stories')}>
        <Icon name="i-arrow-left" size={17} /> Back to my stories
      </button>

      <div className="story-reader">
        <h1 style={{ fontSize: 28, letterSpacing: '-1px', margin: 0 }}>{story.title}</h1>

        {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}

        <article className="story-reader-page" aria-live="polite">
          <p style={{ marginTop: 0, fontSize: '0.7em', color: 'var(--muted-foreground)' }}>
            Page {page + 1} of {story.pages.length}
          </p>
          {current?.heading ? <h2 style={{ marginTop: 0 }}>{current.heading}</h2> : null}
          <p>{current?.body}</p>
          {current?.altText ? <p style={{ fontSize: '0.75em', color: 'var(--muted-foreground)' }}>{current.altText}</p> : null}
        </article>

        <div className="story-reader-nav">
          <Button tone="secondary" big icon="i-arrow-left" onClick={() => goTo(page - 1)} disabled={page === 0}>
            Previous page
          </Button>
          {space?.preferences.readAloudEnabled ? (
            <button className="read-aloud-button" onClick={readAloud}>
              <Icon name="i-play" size={16} /> Read this page to me
            </button>
          ) : null}
          <Button tone="secondary" big iconAfter="i-arrow-right" onClick={() => goTo(page + 1)} disabled={page >= story.pages.length - 1}>
            Next page
          </Button>
        </div>

        <div className="big-actions">
          <Button tone="ghost" big icon="i-x" onClick={() => navigate('/child')}>
            Stop and go back to my day
          </Button>
        </div>

        <section className="help-group" aria-labelledby="story-feedback">
          <h2 id="story-feedback">Tell a grown-up something about this story</h2>
          <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--muted-foreground)' }}>
            Nothing is sent until you say yes.
          </p>

          {sent ? (
            <p className="inline-note" role="status">
              <Icon name="i-check" size={16} strokeWidth={2.5} />
              <span>“{sent}” was sent to a grown-up.</span>
            </p>
          ) : null}

          <div className="help-grid">
            {FEEDBACK.map((option) => (
              <button key={option.kind} className="help-card purple" onClick={() => setPendingFeedback(option)}>
                <span className="pictogram" aria-hidden="true"><Icon name="i-message-circle" size={26} strokeWidth={2.75} /></span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </section>

        {pendingFeedback ? (
          <div className="inline-note" role="alertdialog" aria-label="Confirm sending this message" style={{ display: 'grid', gap: 12 }}>
            <b>Send “{pendingFeedback.label}” to a grown-up?</b>
            <span>They will see which story you were reading and which page you were on. They will not see anything else.</span>
            <div className="row-actions">
              <Button tone="coral" big icon="i-send" onClick={() => sendFeedback.mutate(pendingFeedback.kind)} loading={sendFeedback.isPending}>
                Yes, send it
              </Button>
              <Button tone="ghost" big icon="i-x" onClick={() => setPendingFeedback(null)}>No, do not send it</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
