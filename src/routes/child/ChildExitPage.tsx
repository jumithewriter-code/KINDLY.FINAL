import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { useAnnouncer, useBackend, useChildSession, useWorkspace } from '../../state/providers';

/**
 * The adult check.
 *
 * Leaving child mode needs the grown-up code, verified on the server — the code
 * is never sent to this device and no hash of it is readable by any client.
 * Two things are always available without the code: going back to the child's
 * own day, and the offline help screen.
 */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', 'Delete'] as const;

export function ChildExitPage() {
  const navigate = useNavigate();
  const backend = useBackend();
  const { workspace } = useWorkspace();
  const { end } = useChildSession();
  const { announce } = useAnnouncer();

  const [entry, setEntry] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);

  const familyId = workspace?.activeFamilyId;
  const verification = workspace?.adultVerification;
  const codeLength = 4;

  async function leaveChildMode() {
    await end();
    navigate('/app', { replace: true });
  }

  async function check(code: string) {
    if (!familyId) { await leaveChildMode(); return; }
    setChecking(true);
    try {
      const result = await backend.verifyCaregiverPin(familyId, code);
      if (result.ok) {
        announce('Code accepted.');
        await leaveChildMode();
        return;
      }
      if (result.mode === 'not_configured') {
        setError('No grown-up code has been set for this space yet. Ask a grown-up to set one in Settings.');
      } else if (result.lockedUntil) {
        setLockedUntil(result.lockedUntil);
        setError('Too many tries. Please wait a few minutes before trying again.');
      } else {
        setError('That code is not right. Try again.');
      }
      setEntry('');
      announce('That code is not right.', 'assertive');
    } catch {
      setError('Kindly could not check that code. Please try again.');
      setEntry('');
    } finally {
      setChecking(false);
    }
  }

  function press(key: (typeof KEYS)[number]) {
    setError(null);
    if (key === 'Clear') { setEntry(''); return; }
    if (key === 'Delete') { setEntry((prev) => prev.slice(0, -1)); return; }
    setEntry((prev) => {
      const next = (prev + key).slice(0, codeLength);
      if (next.length === codeLength) void check(next);
      return next;
    });
  }

  // An older family space may predate the code being required. Asking for a
  // code that was never set would be a lock with no key — and the check behind
  // it would have nothing to verify. Say so, let the adult through, and send
  // them straight to the setting.
  if (verification && !verification.isConfigured) {
    return (
      <div className="pin-screen">
        <div className="req-hero" style={{ marginInline: 'auto' }} aria-hidden="true">
          <Icon name="i-alert" size={40} strokeWidth={2} />
        </div>
        <span className="eyebrow">NO CODE SET</span>
        <h1 style={{ fontSize: 30, letterSpacing: '-1.2px', margin: '8px 0 6px' }}>
          This space has no grown-up code yet.
        </h1>
        <p style={{ color: 'var(--muted-foreground)', margin: '0 0 18px', fontSize: 14, maxWidth: '46ch' }}>
          Until one is set, anyone using this device can open the caregiver view.
          Please choose a code now.
        </p>
        <div className="big-actions">
          <Button tone="coral" big icon="i-lock" onClick={async () => { await end(); navigate('/app/settings/safety', { replace: true }); }}>
            Set a code now
          </Button>
          <Button tone="ghost" big onClick={() => navigate('/child')}>Back to my day</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="pin-screen" role="group" aria-labelledby="pin-title">
      <div className="req-hero" style={{ marginInline: 'auto' }} aria-hidden="true">
        <Icon name="i-lock" size={40} strokeWidth={2} />
      </div>
      <span className="eyebrow">ADULT CHECK</span>
      <h1 id="pin-title" style={{ fontSize: 30, letterSpacing: '-1.2px', margin: '8px 0 6px' }}>
        Enter the grown-up code
      </h1>
      <p style={{ color: 'var(--muted-foreground)', margin: '0 0 4px', fontSize: 14 }}>
        This keeps the caregiver view private.
      </p>

      <div className="pin-dots" role="status" aria-label={`${entry.length} of ${codeLength} digits entered`}>
        {Array.from({ length: codeLength }, (_, i) => (
          <i key={i} className={i < entry.length ? 'on' : ''} />
        ))}
      </div>

      <div className="pin-pad">
        {KEYS.map((key) => (
          <button
            key={key}
            className={key === 'Clear' || key === 'Delete' ? 'pin-key wide' : 'pin-key'}
            onClick={() => press(key)}
            disabled={checking || Boolean(lockedUntil)}
            aria-label={key === 'Clear' ? 'Clear code' : key === 'Delete' ? 'Delete last digit' : `Digit ${key}`}
          >
            {key}
          </button>
        ))}
      </div>

      {error ? <p className="pin-error" role="alert">{error}</p> : null}

      <div>
        <button className="emergency-link" onClick={() => navigate('/child/offline-help')}>
          <Icon name="i-shield" size={16} strokeWidth={2.5} /> I need help now
        </button>
      </div>

      <div>
        <button className="text-button" style={{ margin: '18px auto 0' }} onClick={() => navigate('/child')}>
          Back to my day
        </button>
      </div>
    </div>
  );
}
