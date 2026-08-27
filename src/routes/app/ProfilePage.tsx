import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Avatar, Button, Dialog, ErrorState, LoadingState, SectionTitle, TextInput } from '../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../state/providers';
import { childLabel, initialFrom, possessive, validatePersonName } from '../../lib/names';

/**
 * Profile.
 *
 * Two identities, side by side and never mixed: the child this space is for,
 * and the adult who is signed in. Each is edited in its own dialog and each
 * writes to its own table.
 */
export function ProfilePage() {
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeChildId, setActiveChildId, can, refetch } = useWorkspace();
  const { announce } = useAnnouncer();

  const [editingChild, setEditingChild] = useState(false);
  const [editingCaregiver, setEditingCaregiver] = useState(false);
  const [childNameDraft, setChildNameDraft] = useState('');
  const [pronounsDraft, setPronounsDraft] = useState('');
  const [caregiverNameDraft, setCaregiverNameDraft] = useState('');
  const [relationshipDraft, setRelationshipDraft] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';
  const caregiverName = workspace?.caregiver?.caregiverName ?? '';
  const sensory = child ? (workspace?.sensoryPreferences[child.id] ?? []) : [];
  const communication = child ? (workspace?.communicationMethods[child.id] ?? []) : [];
  const trusted = child ? (workspace?.trustedCaregivers[child.id] ?? []) : [];

  const saveChild = useMutation({
    mutationFn: () => backend.updateChild(child!.id, {
      childName: childNameDraft,
      pronouns: pronounsDraft.trim() || null,
    }),
    onSuccess: () => {
      setEditingChild(false);
      announce('Child profile updated.');
      refetch();
      void client.invalidateQueries();
    },
    onError: (e) => setFailure(e),
  });

  const saveCaregiver = useMutation({
    mutationFn: () => backend.updateCaregiverProfile({
      caregiverName: caregiverNameDraft,
      relationshipLabel: relationshipDraft.trim() || null,
    }),
    onSuccess: () => {
      setEditingCaregiver(false);
      announce('Your name was updated. This is the name your child sees.');
      refetch();
    },
    onError: (e) => setFailure(e),
  });

  if (!workspace) return <LoadingState label="Opening your profile" />;

  return (
    <div className="content-wrap">
      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      {workspace.children.length > 1 ? (
        <div className="editor-card" style={{ marginBottom: 20 }}>
          <header><h3>Whose space are you looking at?</h3></header>
          <div className="chip-wrap">
            {workspace.children.map((c) => (
              <button
                key={c.id}
                type="button"
                className={c.id === child?.id ? 'choice selected' : 'choice'}
                aria-pressed={c.id === child?.id}
                onClick={() => { setActiveChildId(c.id); announce(`Now showing ${c.childName}’s space.`); }}
              >
                {c.childName}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <SectionTitle
        eyebrow={childName ? `${possessive(childName).toUpperCase()} PROFILE` : 'CHILD PROFILE'}
        title={`What helps ${childLabel(childName)} feel safe`}
        detail="These preferences guide every little moment. None of them is a diagnosis."
      />

      {child ? (
        <div className="profile-card">
          <div className="profile-banner">
            <Avatar initial={initialFrom(childName)} label={childLabel(childName, { capital: true })} className="profile-avatar" large />
            <div>
              <h2>{childLabel(childName, { capital: true })}</h2>
              <p>{child.pronouns ? `${child.pronouns} · ` : ''}Curious, thoughtful, and growing every day.</p>
            </div>
            {can('can_manage_children') ? (
              <Button
                tone="secondary"
                icon="i-settings-2"
                onClick={() => {
                  setChildNameDraft(childName);
                  setPronounsDraft(child.pronouns ?? '');
                  setErrors({});
                  setEditingChild(true);
                }}
              >
                Edit profile
              </Button>
            ) : null}
          </div>

          <div className="preference-grid">
            <div>
              <span className="eyebrow">SENSORY PREFERENCES</span>
              <h3>Things that help</h3>
              <div className="preference-tags">
                {sensory.filter((s) => s.kind === 'helps').length === 0
                  ? <span>Nothing recorded yet</span>
                  : sensory.filter((s) => s.kind === 'helps').map((s) => <span key={s.id}>{s.label}</span>)}
              </div>
              <h3 style={{ marginTop: 14 }}>Things that are often hard</h3>
              <div className="preference-tags">
                {sensory.filter((s) => s.kind === 'hard').length === 0
                  ? <span>Nothing recorded yet</span>
                  : sensory.filter((s) => s.kind === 'hard').map((s) => <span key={s.id}>{s.label}</span>)}
              </div>
            </div>

            <div>
              <span className="eyebrow">COMMUNICATION</span>
              <h3>{childName ? `${possessive(childName)} ways` : 'Ways to communicate'}</h3>
              <div className="preference-tags">
                {communication.length === 0
                  ? <span>Nothing recorded yet</span>
                  : communication.map((m) => <span key={m.id}>{m.label}{m.isPrimary ? ' (main)' : ''}</span>)}
              </div>

              <h3 style={{ marginTop: 14 }}>Safety</h3>
              <div className="preference-tags">
                <span>Safe adult: {child.safeAdult ?? 'not set'}</span>
                <span>Safe place: {child.safePlace ?? 'not set'}</span>
              </div>
            </div>
          </div>

          <div className="row-actions" style={{ padding: '0 20px 20px' }}>
            <Button tone="secondary" icon="i-settings-2" onClick={() => navigate('/app/settings/preferences')}>
              Change preferences
            </Button>
            <Button tone="secondary" icon="i-shield" onClick={() => navigate('/app/settings/safety')}>
              Safe adult and safe place
            </Button>
          </div>
        </div>
      ) : (
        <ErrorState error={new Error('No child profile yet. Add one in Settings.')} />
      )}

      <SectionTitle
        eyebrow="CAREGIVER"
        title="Who is helping"
        detail={`Your name is what ${childLabel(childName)} sees when a request is answered.`}
      />

      <div className="settings-list">
        <div className="settings-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <Avatar initial={initialFrom(caregiverName)} label={caregiverName || 'Caregiver'} />
            <div>
              <b>{caregiverName || 'Caregiver name not set'}</b>
              <small>
                {caregiverName
                  ? `Caregiver · ${childLabel(childName)} sees this name`
                  : `Add your name so ${childLabel(childName)} knows who is helping.`}
              </small>
            </div>
          </div>
          <Button
            tone="secondary"
            onClick={() => {
              setCaregiverNameDraft(caregiverName);
              setRelationshipDraft(workspace.caregiver?.relationshipLabel ?? '');
              setErrors({});
              setEditingCaregiver(true);
            }}
          >
            Change name
          </Button>
        </div>

        {trusted.map((t) => (
          <div className="settings-row" key={t.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <Avatar initial={initialFrom(t.trustedCaregiverName)} label={t.trustedCaregiverName} />
              <div>
                <b>{t.trustedCaregiverName}</b>
                <small>
                  Trusted caregiver #{t.escalationOrder}
                  {t.relationshipLabel ? ` · ${t.relationshipLabel}` : ''}
                  {t.isActive ? '' : ' · not currently used'}
                </small>
              </div>
            </div>
            <Button tone="secondary" onClick={() => navigate('/app/settings/caregivers')}>Manage</Button>
          </div>
        ))}

        <div className="settings-row">
          <div>
            <b>Everyone who can help</b>
            <small>
              {workspace.members.filter((m) => !m.revokedAt).length} caregiver
              {workspace.members.filter((m) => !m.revokedAt).length === 1 ? '' : 's'} in this family space.
            </small>
          </div>
          <Button tone="secondary" icon="i-users" onClick={() => navigate('/app/settings/caregivers')}>
            Manage caregivers
          </Button>
        </div>
      </div>

      <Dialog
        open={editingChild}
        title="Edit child profile"
        description="This name is used everywhere your child sees their own space."
        onClose={() => setEditingChild(false)}
        actions={
          <>
            <Button
              tone="coral"
              loading={saveChild.isPending}
              onClick={() => {
                const result = validatePersonName(childNameDraft, 'your child’s name');
                if (!result.ok) { setErrors({ childName: result.message }); return; }
                saveChild.mutate();
              }}
            >
              Save
            </Button>
            <Button tone="secondary" onClick={() => setEditingChild(false)}>Cancel</Button>
          </>
        }
      >
        <TextInput label="Child’s name" value={childNameDraft} required error={errors.childName}
          onChange={(e) => { setChildNameDraft(e.target.value); setErrors({}); }} />
        <TextInput label="Pronouns" optionalNote="optional" value={pronounsDraft}
          placeholder="e.g. they/them"
          onChange={(e) => setPronounsDraft(e.target.value)} />
      </Dialog>

      <Dialog
        open={editingCaregiver}
        title="Change your name"
        description={`This is the name ${childLabel(childName)} sees when you answer a request.`}
        onClose={() => setEditingCaregiver(false)}
        actions={
          <>
            <Button
              tone="coral"
              loading={saveCaregiver.isPending}
              onClick={() => {
                const result = validatePersonName(caregiverNameDraft, 'a name for yourself');
                if (!result.ok) { setErrors({ caregiverName: result.message }); return; }
                saveCaregiver.mutate();
              }}
            >
              Save
            </Button>
            <Button tone="secondary" onClick={() => setEditingCaregiver(false)}>Cancel</Button>
          </>
        }
      >
        <TextInput label="Your preferred name" value={caregiverNameDraft} required error={errors.caregiverName}
          onChange={(e) => { setCaregiverNameDraft(e.target.value); setErrors({}); }} />
        <TextInput label="How your child would describe you" optionalNote="optional" value={relationshipDraft}
          placeholder="e.g. Mum, Dad, Support worker"
          onChange={(e) => setRelationshipDraft(e.target.value)} />
        <p className="inline-note">
          <Icon name="i-users" size={16} strokeWidth={2.5} />
          <span>Changing your name does not rewrite answers you have already given — your child keeps seeing the name they saw at the time.</span>
        </p>
      </Dialog>
    </div>
  );
}
