import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Button, Dialog, EmptyState, ErrorState, LoadingState, SectionTitle } from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { childLabel } from '../../lib/names';
import type { Routine } from '../../lib/types';

export function RoutinesPage() {
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeChildId, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const [confirmDelete, setConfirmDelete] = useState<Routine | null>(null);

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';
  const editable = can('can_edit_routines');

  const query = useQuery({
    queryKey: ['routines', child?.id],
    queryFn: () => backend.listRoutines(child!.id),
    enabled: Boolean(child?.id),
  });

  const invalidate = () => client.invalidateQueries({ queryKey: ['routines', child?.id] });

  const duplicate = useMutation({
    mutationFn: (id: string) => backend.duplicateRoutine(id),
    onSuccess: () => { announce('A copy was made.'); invalidate(); },
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => backend.archiveRoutine(id, archived),
    onSuccess: (_d, v) => { announce(v.archived ? 'Routine archived.' : 'Routine restored.'); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => backend.deleteRoutine(id),
    onSuccess: () => { setConfirmDelete(null); announce('Routine deleted.'); invalidate(); },
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => backend.reorderRoutines(child!.id, ids),
    onSuccess: () => invalidate(),
  });

  const routines = query.data ?? [];
  const active = routines.filter((r) => !r.archivedAt);
  const archived = routines.filter((r) => r.archivedAt);

  function move(index: number, delta: number) {
    const ids = active.map((r) => r.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    reorder.mutate(next);
    announce(`Moved to position ${target + 1}.`);
  }

  if (!child) {
    return (
      <div className="content-wrap">
        <EmptyState
          title="Add a child profile first"
          detail="Routines belong to one child, so Kindly can use their own steps and supports."
          action={<Button tone="coral" onClick={() => navigate('/app/settings/children')}>Add a child</Button>}
        />
      </div>
    );
  }

  return (
    <div className="content-wrap">
      <SectionTitle
        eyebrow="ROUTINES"
        title="A softer rhythm"
        detail="Predictable routines that leave room for the day to change. Nothing here is scored, and a skipped step is simply a skipped step."
      />

      {query.isLoading ? <LoadingState label="Loading routines" /> : null}
      {query.error ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : null}

      {!query.isLoading && routines.length === 0 ? (
        <EmptyState
          title="No routines yet"
          detail={`Build one for ${childLabel(childName)} and it will appear in their view under “My day”.`}
          action={editable ? <Button tone="yellow" icon="i-plus" onClick={() => navigate('/app/routines/new')}>Add a routine</Button> : undefined}
        />
      ) : null}

      <div className="routine-list">
        {active.map((routine, index) => (
          <div className="routine-large" key={routine.id}>
            <div className={`routine-icon ${routine.colorKey}-bg`} aria-hidden="true">
              <Icon name={routine.iconKey ?? 'i-clock-3'} size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{routine.title}</b>
              <small>
                {routine.scheduleLabel ?? 'Any time'} · {routine.steps.length} step{routine.steps.length === 1 ? '' : 's'}
                {routine.allowSkip ? ' · steps can be skipped' : ' · steps are shown in order'}
              </small>
            </div>
            <div className="row-actions">
              <Button tone="secondary" icon="i-settings-2" onClick={() => navigate(`/app/routines/${routine.id}`)}>
                {editable ? 'Edit' : 'View'}
              </Button>
              {editable ? (
                <>
                  <Button tone="ghost" icon="i-arrow-left" onClick={() => move(index, -1)} disabled={index === 0}
                    aria-label={`Move ${routine.title} earlier`}>
                    Earlier
                  </Button>
                  <Button tone="ghost" icon="i-arrow-right" onClick={() => move(index, 1)} disabled={index === active.length - 1}
                    aria-label={`Move ${routine.title} later`}>
                    Later
                  </Button>
                  <Button tone="ghost" icon="i-plus" onClick={() => duplicate.mutate(routine.id)} loading={duplicate.isPending}>
                    Duplicate
                  </Button>
                  <Button tone="ghost" icon="i-clock-3" onClick={() => archive.mutate({ id: routine.id, archived: true })}>
                    Archive
                  </Button>
                  <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmDelete(routine)}>Delete</Button>
                </>
              ) : null}
            </div>
          </div>
        ))}

        {editable ? (
          <Button tone="yellow" icon="i-plus" onClick={() => navigate('/app/routines/new')}>Add a routine</Button>
        ) : null}
      </div>

      {archived.length > 0 ? (
        <>
          <h3 style={{ fontSize: 15, margin: '28px 0 10px' }}>Archived</h3>
          <div className="routine-list">
            {archived.map((routine) => (
              <div className="routine-large" key={routine.id}>
                <div className="routine-icon" aria-hidden="true"><Icon name="i-clock-3" size={18} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{routine.title}</b>
                  <small>Archived — not shown in {childLabel(childName)}’s view.</small>
                </div>
                {editable ? (
                  <div className="row-actions">
                    <Button tone="secondary" icon="i-refresh" onClick={() => archive.mutate({ id: routine.id, archived: false })}>
                      Restore
                    </Button>
                    <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmDelete(routine)}>Delete</Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <Dialog
        open={Boolean(confirmDelete)}
        alert
        danger
        title={`Delete “${confirmDelete?.title ?? ''}”?`}
        description={
          `This removes the routine and all of its steps from ${childLabel(childName)}’s view straight away. ` +
          `Any record of past runs is kept for your own history. This cannot be undone.`
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
