import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Avatar, Button, Dialog, ErrorState, SectionTitle, Select, TextInput } from '../../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel, initialFrom, validateEmail, validatePersonName } from '../../../lib/names';
import { env } from '../../../lib/env';
import type { FamilyMember, TrustedCaregiver } from '../../../lib/types';

const ROLE_COPY: Record<FamilyMember['role'], string> = {
  owner: 'Owner — full control, including deleting the family space',
  caregiver: 'Caregiver — answers requests, edits routines and stories',
  trusted: 'Trusted — answers requests only',
  view_only: 'View only — can see status but cannot answer or edit',
};

export function CaregiversSettingsPage() {
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const { workspace, activeFamilyId, activeChildId, refetch, can } = useWorkspace();
  const { announce } = useAnnouncer();

  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'caregiver' | 'trusted' | 'view_only'>('caregiver');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<FamilyMember | null>(null);
  const [trustedDraft, setTrustedDraft] = useState<{ id?: string; name: string; relationship: string; order: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);

  const manage = can('can_manage_caregivers');
  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const trusted = child ? (workspace?.trustedCaregivers[child.id] ?? []) : [];

  const invitationsQuery = useQuery({
    queryKey: ['invitations', activeFamilyId],
    queryFn: () => backend.listInvitations(activeFamilyId!),
    enabled: Boolean(activeFamilyId) && manage,
  });

  const invite = useMutation({
    mutationFn: () => backend.inviteCaregiver(activeFamilyId!, { email: inviteEmail, role: inviteRole }),
    onSuccess: ({ token }) => {
      setInviteLink(`${env().siteUrl}/invite/${token}`);
      setInviteEmail('');
      announce('Invitation created. Share the link with them directly.');
      void client.invalidateQueries({ queryKey: ['invitations', activeFamilyId] });
    },
    onError: (e) => setFailure(e),
  });

  const revokeInvite = useMutation({
    mutationFn: (id: string) => backend.revokeInvitation(id),
    onSuccess: () => { announce('Invitation withdrawn.'); void client.invalidateQueries({ queryKey: ['invitations', activeFamilyId] }); },
    onError: (e) => setFailure(e),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: FamilyMember['role'] }) =>
      backend.updateCaregiverRole(activeFamilyId!, userId, role),
    onSuccess: () => { announce('Role updated.'); refetch(); },
    onError: (e) => setFailure(e),
  });

  const revokeAccess = useMutation({
    mutationFn: (userId: string) => backend.revokeCaregiverAccess(activeFamilyId!, userId),
    onSuccess: () => { setConfirmRevoke(null); announce('That caregiver no longer has access.'); refetch(); },
    onError: (e) => { setConfirmRevoke(null); setFailure(e); },
  });

  const saveTrusted = useMutation({
    mutationFn: (draft: NonNullable<typeof trustedDraft>) => backend.upsertTrustedCaregiver({
      id: draft.id,
      childId: child!.id,
      userId: null,
      trustedCaregiverName: draft.name,
      relationshipLabel: draft.relationship || null,
      escalationOrder: draft.order,
      isActive: true,
    }),
    onSuccess: () => { setTrustedDraft(null); announce('Trusted caregiver saved.'); refetch(); },
    onError: (e) => { setFailure(e); },
  });

  const removeTrusted = useMutation({
    mutationFn: (id: string) => backend.removeTrustedCaregiver(id),
    onSuccess: () => { announce('Trusted caregiver removed.'); refetch(); },
    onError: (e) => setFailure(e),
  });

  const members = (workspace?.members ?? []).filter((m) => !m.revokedAt);
  const removed = (workspace?.members ?? []).filter((m) => m.revokedAt);

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="CAREGIVERS"
        title="Who can help"
        detail="Every adult here can see this family space. Roles decide what each of them can do."
      />

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      <div className="settings-list">
        {members.map((member) => (
          <div className="settings-row" key={member.userId}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <Avatar initial={initialFrom(member.caregiverName)} label={member.caregiverName || 'Caregiver'} />
              <div>
                <b>{member.caregiverName || 'Name not set'}{member.isSelf ? ' (you)' : ''}</b>
                <small>{ROLE_COPY[member.role]}</small>
                {member.email ? <small>{member.email}</small> : null}
              </div>
            </div>
            {manage ? (
              <div className="row-actions">
                <Select
                  label={`Role for ${member.caregiverName || 'this caregiver'}`}
                  value={member.role}
                  onChange={(e) => changeRole.mutate({ userId: member.userId, role: e.target.value as FamilyMember['role'] })}
                  options={(['owner', 'caregiver', 'trusted', 'view_only'] as const).map((r) => ({ value: r, label: r.replace('_', ' ') }))}
                />
                {!member.isSelf ? (
                  <Button tone="ghost" icon="i-x-circle" onClick={() => setConfirmRevoke(member)}>Remove access</Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {removed.length > 0 ? (
        <>
          <h3 style={{ fontSize: 15, margin: '26px 0 10px' }}>Removed</h3>
          <div className="settings-list">
            {removed.map((m) => (
              <div className="settings-row" key={m.userId}>
                <div>
                  <b>{m.caregiverName || 'Name not set'}</b>
                  <small>Access ended. They can no longer see or answer requests.</small>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {manage ? (
        <>
          <SectionTitle eyebrow="INVITATIONS" title="Invite another caregiver"
            detail="An invitation is tied to one email address and expires after 14 days." />

          <div className="row-actions">
            <Button tone="coral" icon="i-plus" onClick={() => { setInviting(true); setInviteLink(null); setErrors({}); }}>
              Create an invitation
            </Button>
          </div>

          <div className="settings-list" style={{ marginTop: 16 }}>
            {(invitationsQuery.data ?? []).map((inv) => (
              <div className="settings-row" key={inv.id}>
                <div>
                  <b>{inv.invitedEmail}</b>
                  <small>{inv.role} · {inv.status} · expires {new Date(inv.expiresAt).toLocaleDateString()}</small>
                </div>
                {inv.status === 'pending' ? (
                  <Button tone="ghost" icon="i-x-circle" onClick={() => revokeInvite.mutate(inv.id)} loading={revokeInvite.isPending}>
                    Withdraw
                  </Button>
                ) : null}
              </div>
            ))}
            {(invitationsQuery.data ?? []).length === 0 ? (
              <div className="settings-row"><div><b>No invitations yet</b><small>Nothing is pending.</small></div></div>
            ) : null}
          </div>
        </>
      ) : null}

      <SectionTitle
        eyebrow="ESCALATION"
        title={`Trusted caregivers for ${childLabel(child?.childName)}`}
        detail="If nobody answers in time, Kindly asks these people in order. A trusted caregiver does not need a Kindly account."
      />

      <div className="settings-list">
        {trusted.map((t: TrustedCaregiver) => (
          <div className="settings-row" key={t.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <Avatar initial={initialFrom(t.trustedCaregiverName)} label={t.trustedCaregiverName} />
              <div>
                <b>{t.trustedCaregiverName}</b>
                <small>Asked #{t.escalationOrder}{t.relationshipLabel ? ` · ${t.relationshipLabel}` : ''}</small>
              </div>
            </div>
            {manage ? (
              <div className="row-actions">
                <Button tone="secondary" onClick={() => setTrustedDraft({
                  id: t.id, name: t.trustedCaregiverName, relationship: t.relationshipLabel ?? '', order: t.escalationOrder,
                })}>
                  Edit
                </Button>
                <Button tone="ghost" icon="i-x-circle" onClick={() => removeTrusted.mutate(t.id)} loading={removeTrusted.isPending}>
                  Remove
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        {trusted.length === 0 ? (
          <div className="settings-row">
            <div>
              <b>No trusted caregiver yet</b>
              <small>Without one, an unanswered request goes straight to the safe adult and safe place instead.</small>
            </div>
          </div>
        ) : null}
      </div>

      {manage && child ? (
        <div className="row-actions" style={{ marginTop: 16 }}>
          <Button tone="secondary" icon="i-plus"
            onClick={() => setTrustedDraft({ name: '', relationship: '', order: trusted.length + 1 })}>
            Add a trusted caregiver
          </Button>
        </div>
      ) : null}

      {/* ---- Invite dialog ---- */}
      <Dialog
        open={inviting}
        title="Invite a caregiver"
        description="They will be able to see this family space and, depending on their role, answer requests."
        onClose={() => setInviting(false)}
        actions={
          inviteLink ? (
            <Button tone="coral" onClick={() => { setInviting(false); setInviteLink(null); }}>Done</Button>
          ) : (
            <>
              <Button
                tone="coral"
                loading={invite.isPending}
                onClick={() => {
                  const result = validateEmail(inviteEmail);
                  if (!result.ok) { setErrors({ email: result.message }); return; }
                  invite.mutate();
                }}
              >
                Create invitation
              </Button>
              <Button tone="secondary" onClick={() => setInviting(false)}>Cancel</Button>
            </>
          )
        }
      >
        {inviteLink ? (
          <>
            <p className="inline-note">
              <Icon name="i-check" size={16} strokeWidth={2.5} />
              <span>
                Share this link with them directly. It works once, only for the address you entered,
                and expires in 14 days.
              </span>
            </p>
            <TextInput label="Invitation link" value={inviteLink} readOnly onFocus={(e) => e.currentTarget.select()} />
          </>
        ) : (
          <>
            <TextInput label="Their email address" type="email" value={inviteEmail} required error={errors.email}
              onChange={(e) => { setInviteEmail(e.target.value); setErrors({}); }} />
            <Select label="What should they be able to do?" value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
              options={[
                { value: 'caregiver', label: 'Caregiver — answer requests, edit routines and stories' },
                { value: 'trusted', label: 'Trusted — answer requests only' },
                { value: 'view_only', label: 'View only — see status, cannot answer or edit' },
              ]} />
          </>
        )}
      </Dialog>

      {/* ---- Trusted caregiver dialog ---- */}
      <Dialog
        open={Boolean(trustedDraft)}
        title={trustedDraft?.id ? 'Edit trusted caregiver' : 'Add a trusted caregiver'}
        description={`This is the name ${childLabel(child?.childName)} will see if Kindly asks them for help.`}
        onClose={() => setTrustedDraft(null)}
        actions={
          <>
            <Button
              tone="coral"
              loading={saveTrusted.isPending}
              onClick={() => {
                if (!trustedDraft) return;
                const result = validatePersonName(trustedDraft.name, 'this person’s name');
                if (!result.ok) { setErrors({ trusted: result.message }); return; }
                saveTrusted.mutate(trustedDraft);
              }}
            >
              Save
            </Button>
            <Button tone="secondary" onClick={() => setTrustedDraft(null)}>Cancel</Button>
          </>
        }
      >
        <TextInput label="Their name" value={trustedDraft?.name ?? ''} required error={errors.trusted}
          placeholder="e.g. Grandma Ade"
          onChange={(e) => { const v = e.target.value; setTrustedDraft((p) => (p ? { ...p, name: v } : p)); setErrors({}); }} />
        <TextInput label="How your child knows them" optionalNote="optional" value={trustedDraft?.relationship ?? ''}
          placeholder="e.g. Grandmother, Teacher"
          onChange={(e) => { const v = e.target.value; setTrustedDraft((p) => (p ? { ...p, relationship: v } : p)); }} />
        <div className="field-block">
          <label htmlFor="trusted-order">Ask them in this order</label>
          <input id="trusted-order" type="number" min={1} max={20} value={trustedDraft?.order ?? 1}
            aria-describedby="trusted-order-help"
            onChange={(e) => { const v = Number(e.target.value); setTrustedDraft((p) => (p ? { ...p, order: v } : p)); }} />
          <small className="field-hint" id="trusted-order-help">1 is asked first.</small>
        </div>
      </Dialog>

      {/* ---- Revoke access ---- */}
      <Dialog
        open={Boolean(confirmRevoke)}
        alert
        danger
        title={`Remove ${confirmRevoke?.caregiverName || 'this caregiver'}’s access?`}
        description={
          `They will immediately stop seeing this family space and cannot answer requests. ` +
          `Any request currently assigned to them is handed back to the family. ` +
          `Answers they have already given stay in the history under the name your child saw at the time.`
        }
        onClose={() => setConfirmRevoke(null)}
        actions={
          <>
            <Button tone="danger" loading={revokeAccess.isPending} onClick={() => confirmRevoke && revokeAccess.mutate(confirmRevoke.userId)}>
              Yes, remove access
            </Button>
            <Button tone="secondary" onClick={() => setConfirmRevoke(null)}>Keep access</Button>
          </>
        }
      />
    </div>
  );
}
