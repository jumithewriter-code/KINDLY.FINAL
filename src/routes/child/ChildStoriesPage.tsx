import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, EmptyState, ErrorState, LoadingState } from '../../components/ui';
import { useBackend, useChildSession } from '../../state/providers';

/** Stories a caregiver has approved AND given to this child. Nothing else. */
export function ChildStoriesPage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const { token } = useChildSession();

  const query = useQuery({
    queryKey: ['child-stories', token],
    queryFn: () => backend.childGetStories(token!),
    enabled: Boolean(token),
  });

  return (
    <div className="help-screen">
      <button className="back-link" onClick={() => navigate('/child')}>
        <Icon name="i-arrow-left" size={17} /> Back
      </button>

      <div className="child-greeting">
        <span className="eyebrow">MY STORIES</span>
        <h1>Stories you can read.</h1>
        <p>You can read any of these, as many times as you like. You can stop whenever you want.</p>
      </div>

      {query.isLoading ? <LoadingState label="Getting your stories" /> : null}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

      {!query.isLoading && (query.data ?? []).length === 0 ? (
        <EmptyState
          title="No stories yet"
          detail="When a grown-up makes a story for you, it will be here."
          action={<Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/child')}>Back to my day</Button>}
        />
      ) : null}

      <div className="help-grid">
        {(query.data ?? []).map((story) => (
          <button key={story.id} className="help-card blue" onClick={() => navigate(`/child/stories/${story.id}`)}>
            <span className="pictogram" aria-hidden="true"><Icon name="i-book-open" size={28} strokeWidth={2.75} /></span>
            <b>{story.title}</b>
            <small>
              {story.pages.length} page{story.pages.length === 1 ? '' : 's'}
              {story.lastPage > 0 ? ` · you were on page ${story.lastPage + 1}` : ''}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}
