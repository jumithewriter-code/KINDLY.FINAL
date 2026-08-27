import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, Dialog, SectionTitle } from '../../components/ui';
import { useAuth, useWorkspace } from '../../state/providers';
import { childLabel } from '../../lib/names';

const ROWS = [
  { to: '/app/settings/children', title: 'Children', detail: 'Names, pronouns, and adding or removing a child profile.', icon: 'i-user-round' },
  { to: '/app/settings/caregivers', title: 'Caregivers and invitations', detail: 'Who can help, what they can do, and how to remove access.', icon: 'i-users' },
  { to: '/app/settings/preferences', title: 'Communication, sensory and display', detail: 'How Kindly looks, sounds and moves for your child.', icon: 'i-settings-2' },
  { to: '/app/settings/safety', title: 'Safety and escalation', detail: 'Safe adult, safe place, escalation timing and the grown-up code.', icon: 'i-shield' },
  { to: '/app/settings/notifications', title: 'Notifications', detail: 'Permission, quiet hours, and what Kindly tells you about.', icon: 'i-bell' },
  { to: '/app/settings/data', title: 'Your data', detail: 'Export everything, or delete a child profile or your account.', icon: 'i-lock' },
] as const;

export function SettingsPage() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { workspace, activeChildId } = useWorkspace();
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const caregiverName = workspace?.caregiver?.caregiverName ?? '';
  const trusted = child ? (workspace?.trustedCaregivers[child.id] ?? []) : [];

  return (
    <div className="content-wrap">
      <SectionTitle
        eyebrow="YOUR SPACE"
        title="Settings"
        detail="Keep Kindly feeling calm and useful for your family. Everything here can be changed again later."
      />

      <div className="settings-list">
        {ROWS.map((row) => (
          <div className="settings-row" key={row.to}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span className="routine-icon" aria-hidden="true"><Icon name={row.icon} size={18} /></span>
              <div>
                <b>{row.title}</b>
                <small>{row.detail}</small>
              </div>
            </div>
            <Button tone="secondary" iconAfter="i-arrow-right" onClick={() => navigate(row.to)}>Open</Button>
          </div>
        ))}

        <div className="settings-row">
          <div>
            <b>Names in this space</b>
            <small>
              {caregiverName || 'No caregiver name'}
              {' · '}{child?.childName ?? 'No child name'}
              {' · '}{trusted.length ? `Backup: ${trusted.map((t) => t.trustedCaregiverName).join(', ')}` : 'No backup caregiver'}
            </small>
          </div>
          <Button tone="secondary" onClick={() => navigate('/app/profile')}>Edit names</Button>
        </div>

        <div className="settings-row">
          <div>
            <b>Sign out</b>
            <small>
              {caregiverName
                ? `Sign ${caregiverName} out of this device. Nothing is deleted.`
                : 'Sign out of this device. Nothing is deleted.'}
            </small>
          </div>
          <Button tone="secondary" icon="i-lock" onClick={() => setConfirmSignOut(true)}>Sign out</Button>
        </div>
      </div>

      <p className="inline-note" style={{ marginTop: 22 }}>
        <Icon name="i-shield" size={16} strokeWidth={2.5} />
        <span>
          Kindly is not a medical device, a diagnostic tool, a therapy, or an emergency service.
          In an emergency, contact your local emergency services directly.
        </span>
      </p>

      <Dialog
        open={confirmSignOut}
        alert
        title="Sign out of Kindly?"
        description={
          child
            ? `Any child session on this device ends too, so ${childLabel(child.childName)} will not be able to send a request from here until you sign back in.`
            : 'Any child session on this device ends too.'
        }
        onClose={() => setConfirmSignOut(false)}
        actions={
          <>
            <Button tone="coral" onClick={() => { void signOut(); navigate('/auth/sign-in', { replace: true }); }}>
              Yes, sign out
            </Button>
            <Button tone="secondary" onClick={() => setConfirmSignOut(false)}>Stay signed in</Button>
          </>
        }
      />
    </div>
  );
}
