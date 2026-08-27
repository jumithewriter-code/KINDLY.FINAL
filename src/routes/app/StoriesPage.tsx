import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, Dialog, EmptyState, ErrorState, LoadingState, SectionTitle } from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { childLabel, possessive } from '../../lib/names';
import { formatDateTime } from '../../lib/format';
import { SCENARIO_BY_KEY } from '../../lib/stories/scenarios';
import type { Story } from '../../lib/types';

const STATUS_COPY: Record<Story['status'], { label: string; tone: string }> = {
  draft: { label: 'Draft — not shared', tone: 'quiet' },
  in_review: { label: 'Waiting for review', tone: 'waiting' },
  approved: { label: 'Approved', tone: 'ack' },
  archived: { label: 'Archived', tone: 'quiet' },
};

export function StoriesPage() {
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeChildId, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const [confirmDelete, setConfirmDelete] = useState<Story | null>(null);

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';

  const query = useQuery({
    queryKey: ['stories', child?.id],
    queryFn: () => backend.listStories(child!.id),
    enabled: Boolean(child?.id),
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ['stories', child?.id] });

  const duplicate = useMutation({
    mutationFn: (id: string) => backend.duplicateStory(id),
    onSuccess: (story) => { announce('A copy was made as a new draft.'); invalidate(); navigate(`/app/stories/${story.id}`); },
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => backend.archiveStory(id, archived),
    onSuccess: (_d, v) => { announce(v.archived ? 'Story archived.' : 'Story restored as a draft.'); invalidate(); },
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => backend.withdrawStory(id, child!.id),
    onSuccess: () => { announce('That story is no longer available in child mode.'); invalidate(); },
  });
  const assign = useMutation({
    mutationFn: (id: string) => backend.assignStory(id, child!.id),
    onSuccess: () => { announce(`That story is now available to ${childLabel(childName)}.`); invalidate(); },
    onError: (e) => announce(e instanceof Error ? e.message : 'That story could not be assigned.', 'assertive'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => backend.deleteStory(id),
    onSuccess: () => { setConfirmDelete(null); announce('Story deleted.'); invalidate(); },
  });

  const stories = query.data ?? [];
  const featured = stories.find((s) => s.status === 'approved') ?? stories[0];

  if (!child) {
    return (
      <div className="content-wrap">
        <EmptyState
          title="Add a child profile first"
          detail="Stories are written for one child at a time, using their own preferences."
          action={<Button tone="coral" onClick={() => navigate('/app/settings/children')}>Add a child</Button>}
        />
      </div>
    );
  }

  return (
    <div className="content-wrap">
      <SectionTitle
        eyebrow={childName ? `${possessive(childName).toUpperCase()} LIBRARY` : 'YOUR LIBRARY'}
        title="Stories for everyday moments"
        detail="Short, gentle ways to make unfamiliar moments feel more familiar. Nothing here reaches child mode until you approve it."
      />

      {can('can_edit_stories') ? (
        <div className="row-actions" style={{ marginBottom: 18 }}>
          <Button tone="coral" icon="i-plus" onClick={() => navigate('/app/stories/new')}>Start a new story</Button>
        </div>
      ) : null}

      {query.isLoading ? <LoadingState label="Loading stories" /> : null}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

      {!query.isLoading && stories.length === 0 ? (
        <EmptyState
          title="No stories yet"
          detail={`When you write one, it will wait here as a draft until you approve it for ${childLabel(childName)}.`}
          action={can('can_edit_stories')
            ? <Button tone="coral" icon="i-plus" onClick={() => navigate('/app/stories/new')}>Start a new story</Button>
            : undefined}
        />
      ) : null}

      {featured ? (
        <div className="library-hero">
          <div>
            <span className="eyebrow">{featured.status === 'approved' ? 'READY TO READ TOGETHER' : 'MOST RECENT'}</span>
            <h2>{featured.title}</h2>
            <p>
              {SCENARIO_BY_KEY[featured.scenarioKey]?.summary
                ?? 'A short story you can read together, one page at a time.'}
            </p>
            <div className="row-actions">
              <Button tone="coral" icon="i-book-open" onClick={() => navigate(`/app/stories/${featured.id}`)}>
                {featured.status === 'approved' ? 'Open and read together' : 'Open the draft'}
              </Button>
            </div>
          </div>
          <div className="large-art" aria-hidden="true"><Icon name="i-book-open" size={64} strokeWidth={1.75} /></div>
        </div>
      ) : null}

      <div className="story-list">
        {stories.map((story, index) => {
          const assigned = story.assignedChildIds.includes(child.id);
          const status = STATUS_COPY[story.status];
          return (
            <div className="story-row" key={story.id}>
              <div className={`story-thumb thumb-${index % 3}`} aria-hidden="true">
                <Icon name="i-book-open" size={18} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{story.title}</b>
                <small>
                  {story.pages.length} page{story.pages.length === 1 ? '' : 's'}
                  {' · '}{status.label}
                  {' · '}v{story.version}
                  {story.approvedByName ? ` · approved by ${story.approvedByName}` : ''}
                  {story.approvedAt ? ` on ${formatDateTime(story.approvedAt)}` : ''}
                  {story.source === 'generated' ? ' · generated draft' : ''}
                </small>
                <small>
                  {assigned
                    ? `Available to ${childLabel(childName)} in child mode.`
                    : 'Not in child mode.'}
                  {story.reviewFlags.length
                    ? ` ${story.reviewFlags.length} thing${story.reviewFlags.length === 1 ? '' : 's'} to check before approving.`
                    : ''}
                </small>
              </div>

              <div className="row-actions">
                <Button tone="secondary" icon="i-book-open" onClick={() => navigate(`/app/stories/${story.id}`)}>
                  {can('can_edit_stories') ? 'Edit' : 'Read'}
                </Button>

                {can('can_approve_stories') && story.status === 'approved' ? (
                  assigned ? (
                    <Button tone="ghost" icon="i-x-circle" onClick={() => withdraw.mutate(story.id)} loading={withdraw.isPending}>
                      Withdraw from child mode
                    </Button>
                  ) : (
                    <Button tone="coral" icon="i-check" onClick={() => assign.mutate(story.id)} loading={assign.isPending}>
                      Give to {childLabel(childName)}
                    </Button>
                  )
                ) : null}

                {can('can_edit_stories') ? (
                  <>
                    <Button tone="ghost" icon="i-plus" onClick={() => duplicate.mutate(story.id)} loading={duplicate.isPending}>
                      Duplicate
                    </Button>
                    <Button
                      tone="ghost"
                      icon="i-clock-3"
                      onClick={() => archive.mutate({ id: story.id, archived: !story.archivedAt })}
                      loading={archive.isPending}
                    >
                      {story.archivedAt ? 'Restore' : 'Archive'}
                    </Button>
                    <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmDelete(story)}>Delete</Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={Boolean(confirmDelete)}
        alert
        danger
        title={`Delete “${confirmDelete?.title ?? ''}”?`}
        description={
          `This removes the story and all its pages, and takes it out of child mode straight away. ` +
          `Version history goes with it. This cannot be undone.`
        }
        onClose={() => setConfirmDelete(null)}
        actions={
          <>
            <Button tone="danger" onClick={() => confirmDelete && remove.mutate(confirmDelete.id)} loading={remove.isPending}>
              Yes, delete it
            </Button>
            <Button tone="secondary" onClick={() => setConfirmDelete(null)}>Keep it</Button>
          </>
        }
      />
    </div>
  );
}
