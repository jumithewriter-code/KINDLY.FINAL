import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Button, Dialog, ErrorState, SectionTitle, TextInput } from '../../../components/ui';
import { useAnnouncer, useAuth, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel } from '../../../lib/names';

/**
 * Data rights.
 *
 * Export produces the whole family record as JSON. Deletion is a two-step,
 * typed confirmation with a seven-day grace window; the effect of each option
 * is spelled out rather than implied.
 */
export function DataSettingsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { workspace, activeFamilyId, activeChildId, can, refetch } = useWorkspace();
  const { announce } = useAnnouncer();

  const [confirmChild, setConfirmChild] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState(false);
  const [typed, setTyped] = useState('');
  const [failure, setFailure] = useState<unknown>(null);

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];

  const exportData = useMutation({
    mutationFn: () => backend.exportFamilyData(activeFamilyId!),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kindly-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      announce('Your export has been downloaded.');
    },
    onError: (e) => setFailure(e),
  });

  const deleteChild = useMutation({
    mutationFn: () => backend.requestDeletion('child', { childId: child!.id }),
    onSuccess: () => {
      setConfirmChild(false); setTyped('');
      announce('That child profile is scheduled for deletion.');
      refetch();
    },
    onError: (e) => { setConfirmChild(false); setFailure(e); },
  });

  const deleteAccount = useMutation({
    mutationFn: () => backend.requestDeletion('account'),
    onSuccess: () => {
      announce('Your account is scheduled for deletion. You have been signed out.');
      void signOut();
      navigate('/auth/sign-in', { replace: true });
    },
    onError: (e) => { setConfirmAccount(false); setFailure(e); },
  });

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="YOUR DATA"
        title="Export or delete"
        detail="Everything Kindly stores about your family is yours. Deletion always explains exactly what goes." />

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      <div className="settings-list">
        <div className="settings-row">
          <div>
            <b>Export everything</b>
            <small>
              Downloads a JSON file with your family, children, preferences, requests, routines,
              stories and the audit history. Media files are referenced by name, not embedded.
            </small>
          </div>
          <Button tone="secondary" icon="i-send" onClick={() => exportData.mutate()}
            loading={exportData.isPending} disabled={!can('can_export_data')}>
            Download my data
          </Button>
        </div>

        {!can('can_export_data') ? (
          <div className="settings-row">
            <div>
              <b>Export is limited to family owners</b>
              <small>Ask a family owner if you need a copy of this data.</small>
            </div>
          </div>
        ) : null}

        <div className="settings-row">
          <div>
            <b>Delete a child profile</b>
            <small>
              Removes {childLabel(child?.childName)}’s preferences, routines, stories and request
              history, and ends any child session immediately.
            </small>
          </div>
          <Button tone="secondary" icon="i-x-circle" onClick={() => { setConfirmChild(true); setTyped(''); }}
            disabled={!child || !can('can_manage_children')}>
            Delete child profile
          </Button>
        </div>

        <div className="settings-row">
          <div>
            <b>Delete my account</b>
            <small>
              Ends your access to every family space. If you are the only owner of a family space,
              that space and its children are deleted too.
            </small>
          </div>
          <Button tone="secondary" icon="i-x-circle" onClick={() => { setConfirmAccount(true); setTyped(''); }}>
            Delete my account
          </Button>
        </div>
      </div>

      <div className="editor-card" style={{ marginTop: 24 }}>
        <header><h3>What happens after you ask for deletion</h3></header>
        <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, lineHeight: 1.7 }}>
          <li>The record is hidden immediately — nobody can see it and no child session can use it.</li>
          <li>Kindly keeps it for <b>seven days</b> so an accidental deletion can be reversed.</li>
          <li>After seven days it is permanently removed, including uploaded pictures and audio.</li>
          <li>Audit entries that record <i>who did what</i> are kept for 24 months without personal content, then purged.</li>
        </ul>
      </div>

      <Dialog
        open={confirmChild}
        alert
        danger
        title={`Delete ${child?.childName ?? 'this child'}’s profile?`}
        description={`Type the name ${child?.childName ?? ''} to confirm. This cannot be undone after seven days.`}
        onClose={() => setConfirmChild(false)}
        actions={
          <>
            <Button tone="danger" loading={deleteChild.isPending}
              disabled={typed.trim() !== (child?.childName ?? '')}
              onClick={() => deleteChild.mutate()}>
              Yes, delete this profile
            </Button>
            <Button tone="secondary" onClick={() => setConfirmChild(false)}>Keep it</Button>
          </>
        }
      >
        <TextInput label={`Type “${child?.childName ?? ''}” to confirm`} value={typed}
          onChange={(e) => setTyped(e.target.value)} />
      </Dialog>

      <Dialog
        open={confirmAccount}
        alert
        danger
        title="Delete your account?"
        description="Type DELETE to confirm. You will be signed out straight away."
        onClose={() => setConfirmAccount(false)}
        actions={
          <>
            <Button tone="danger" loading={deleteAccount.isPending}
              disabled={typed.trim().toUpperCase() !== 'DELETE'}
              onClick={() => deleteAccount.mutate()}>
              Yes, delete my account
            </Button>
            <Button tone="secondary" onClick={() => setConfirmAccount(false)}>Keep my account</Button>
          </>
        }
      >
        <TextInput label="Type DELETE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Dialog>
    </div>
  );
}
