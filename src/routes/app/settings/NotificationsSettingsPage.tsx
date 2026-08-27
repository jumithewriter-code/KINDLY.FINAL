import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../../../components/Icon';
import { Button, ErrorState, SectionTitle, Toggle } from '../../../components/ui';
import { useAnnouncer, useBackend, useWorkspace } from '../../../state/providers';
import { childLabel } from '../../../lib/names';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

function readPermission(): PermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as PermissionState;
}

/**
 * Notifications.
 *
 * A device notification is always an extra. Requests appear inside Kindly, in
 * the request list, in the banner and through escalation, so an urgent request
 * never depends on a single push arriving.
 */
export function NotificationsSettingsPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { workspace, activeChildId, refetch } = useWorkspace();
  const { announce } = useAnnouncer();

  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const prefs = child ? workspace?.preferences[child.id] : undefined;

  const [permission, setPermission] = useState<PermissionState>(readPermission);
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    setQuietStart(prefs?.quietHoursStart?.slice(0, 5) ?? '');
    setQuietEnd(prefs?.quietHoursEnd?.slice(0, 5) ?? '');
  }, [prefs]);

  const save = useMutation({
    mutationFn: () => backend.updateChildPreferences(child!.id, {
      familyId: child!.familyId,
      quietHoursStart: quietStart || null,
      quietHoursEnd: quietEnd || null,
      quietHoursAllowUrgent: true,
    }),
    onSuccess: () => {
      setFailure(null);
      setSavedAt(new Date().toISOString());
      announce('Notification settings saved.');
      refetch();
    },
    onError: (e) => setFailure(e),
  });

  async function requestPermission() {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result as PermissionState);
    announce(result === 'granted'
      ? 'Notifications are on for this device.'
      : 'Notifications are off. Requests still appear inside Kindly and still escalate.');
  }

  return (
    <div className="content-wrap">
      <button className="back-link" onClick={() => navigate('/app/settings')}>
        <Icon name="i-arrow-left" size={17} /> Back to settings
      </button>

      <SectionTitle
        eyebrow="NOTIFICATIONS"
        title="How Kindly reaches you"
        detail="Kindly always shows requests inside the app. Device notifications are an extra layer, never the only one." />

      {failure ? <ErrorState error={failure} onRetry={() => setFailure(null)} /> : null}

      <div className="editor-card">
        <header><h3>This device</h3></header>
        <p className="inline-note">
          <Icon name="i-bell" size={16} strokeWidth={2.5} />
          <span>
            {permission === 'unsupported'
              ? 'This browser cannot show notifications. Everything still works inside Kindly.'
              : permission === 'granted'
                ? 'Notifications are on for this device.'
                : permission === 'denied'
                  ? 'This device has blocked notifications. You can change that in your browser settings for this site. Requests will still appear inside Kindly.'
                  : 'Kindly has not asked for permission on this device yet.'}
          </span>
        </p>
        <Button tone="secondary" icon="i-bell" onClick={requestPermission}
          disabled={permission !== 'default'}>
          Turn on notifications for this device
        </Button>
      </div>

      <div className="editor-card">
        <header><h3>Quiet hours</h3></header>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--muted-foreground)' }}>
          During quiet hours Kindly holds back non-urgent notifications for
          {' '}{childLabel(child?.childName)}. Urgent requests always come through — that cannot be
          switched off.
        </p>
        <div className="preference-grid">
          <div className="field-block">
            <label htmlFor="quiet-start">Quiet from</label>
            <input id="quiet-start" type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
          </div>
          <div className="field-block">
            <label htmlFor="quiet-end">Quiet until</label>
            <input id="quiet-end" type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </div>
        </div>
        <div className="settings-list">
          <Toggle
            label="Urgent requests always come through"
            description="Locked on. An urgent request is never silenced by a preference."
            checked
            disabled
            onChange={() => {}}
            lockedReason="This cannot be switched off."
          />
        </div>
      </div>

      <div className="row-actions">
        <Button tone="coral" icon="i-check" onClick={() => save.mutate()} loading={save.isPending} disabled={!child}>
          Save notification settings
        </Button>
        <Button tone="ghost" onClick={() => navigate('/app/settings')}>Back</Button>
      </div>

      {savedAt ? (
        <p className="inline-note" role="status" style={{ marginTop: 14 }}>
          <Icon name="i-check" size={16} strokeWidth={2.5} />
          <span>Saved at {new Date(savedAt).toLocaleTimeString()}.</span>
        </p>
      ) : null}
    </div>
  );
}
