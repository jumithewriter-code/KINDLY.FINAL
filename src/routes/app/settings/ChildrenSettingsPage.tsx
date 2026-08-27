import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Avatar, Button, Dialog, ErrorState, SectionTitle, TextInput } from '../../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel, initialFrom, validatePersonName } from '../../../lib/names';
import type { ChildProfile } from '../../../lib/types';

export function ChildrenSettingsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { workspace, refetch, can, activeFamilyId } = useWorkspace();
  const { announce } = useAnnouncer();

  const [adding, setAdding] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [pronounsDraft, setPronounsDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChildProfile | null>(null);

  const manage = can('can_manage_children');

  const add = useMutation({
    mutationFn: () => backend.addChild(activeFamilyId!, { childName: nameDraft, pronouns: pronounsDraft || null }),
    onSuccess: () => {
      setAdding(false); setNameDraft(''); setPronounsDraft('');
      announce('Child profile added.');
      refetch();
    },
    onError: (e) => setFailure(e),
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => backend.archiveChild(id, archived),
    onSuccess: (_d, v) => { announce(v.archived ? 'Child profile archived.' : 'Child profile restored.'); refetch(); },
    onError: (e) => setFailure(e),
  });

  const remove = useMutation({
    mutationFn: (id: string) => backend.requestDeletion('child', { childId: id }),
    onSuccess: () => { setConfirmDelete(null); announce('Child profile scheduled for deletion.'); refetch(); },
    onError: (e) => { setConfirmDelete(null); setFailure(e); },
  });

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="CHILDREN"
        title="Children in this family space"
        detail="Each child has their own name, preferences, routines, stories and requests. Nothing is shared between them."
      />

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      <div className="settings-list">
        {(workspace?.children ?? []).map((child) => (
          <div className="settings-row" key={child.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <Avatar initial={initialFrom(child.childName)} label={child.childName} />
              <div>
                <b>{child.childName}</b>
                <small>
                  {child.pronouns ? `${child.pronouns} · ` : ''}
                  {child.archivedAt ? 'Archived — not shown in child mode' : 'Active'}
                </small>
              </div>
            </div>
            <div className="row-actions">
              <Button tone="secondary" onClick={() => navigate('/app/profile')}>Edit</Button>
              {manage ? (
                <>
                  <Button
                    tone="ghost"
                    icon="i-clock-3"
                    onClick={() => archive.mutate({ id: child.id, archived: !child.archivedAt })}
                    loading={archive.isPending}
                  >
                    {child.archivedAt ? 'Restore' : 'Archive'}
                  </Button>
                  <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmDelete(child)}>Delete</Button>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      {manage ? (
        <div className="row-actions" style={{ marginTop: 18 }}>
          <Button tone="coral" icon="i-plus" onClick={() => { setAdding(true); setError(null); }}>Add a child</Button>
        </div>
      ) : (
        <p className="inline-note">
          <Icon name="i-lock" size={16} strokeWidth={2.5} />
          <span>Your role can see children but not add or remove them.</span>
        </p>
      )}

      <Dialog
        open={adding}
        title="Add a child"
        description="Kindly will create their own preferences, safety settings and request list."
        onClose={() => setAdding(false)}
        actions={
          <>
            <Button
              tone="coral"
              loading={add.isPending}
              onClick={() => {
                const result = validatePersonName(nameDraft, 'your child’s name');
                if (!result.ok) { setError(result.message); return; }
                add.mutate();
              }}
            >
              Add
            </Button>
            <Button tone="secondary" onClick={() => setAdding(false)}>Cancel</Button>
          </>
        }
      >
        <TextInput label="Child’s name" value={nameDraft} required error={error}
          placeholder="e.g. Ana, Léo, 小明"
          onChange={(e) => { setNameDraft(e.target.value); setError(null); }} />
        <TextInput label="Pronouns" optionalNote="optional" value={pronounsDraft}
          onChange={(e) => setPronounsDraft(e.target.value)} />
      </Dialog>

      <Dialog
        open={Boolean(confirmDelete)}
        alert
        danger
        title={`Delete ${confirmDelete?.childName ?? 'this child'}’s profile?`}
        description={
          `This removes ${childLabel(confirmDelete?.childName)}’s preferences, routines, stories and request history, ` +
          `and ends any child session on any device straight away. Kindly keeps the record for seven days so this can ` +
          `be undone from “Your data”, then deletes it permanently.`
        }
        onClose={() => setConfirmDelete(null)}
        actions={
          <>
            <Button tone="danger" loading={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}>
              Yes, delete this profile
            </Button>
            <Button tone="secondary" onClick={() => setConfirmDelete(null)}>Keep it</Button>
          </>
        }
      />
    </div>
  );
}
