import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui';
import { useAnnouncer, useBackend } from '../../state/providers';

/** Shown after sign-up when the project requires email verification. */
export function CheckEmailPage() {
  const backend = useBackend();
  const location = useLocation();
  const { announce } = useAnnouncer();
  const email = (location.state as { email?: string } | null)?.email ?? '';
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);

  async function resend() {
    if (!email) return;
    setBusy(true);
    try {
      await backend.resendVerificationEmail(email);
      setResent(true);
      announce('Another confirmation email has been sent.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page" id="main-content">
      <div className="auth-card">
        <span className="onboarding-brand">
          <span className="brand-mark"><Icon name="i-heart" size={19} fill="currentColor" stroke="none" /></span> Kindly
        </span>
        <div className="auth-copy">
          <span className="eyebrow">ONE MORE STEP</span>
          <h1>Confirm your email address.</h1>
          <p>
            {email
              ? `We sent a confirmation link to ${email}. Open it on this device to finish setting up your space.`
              : 'We sent a confirmation link to the address you used. Open it on this device to finish setting up your space.'}
          </p>
        </div>
        {resent ? (
          <p className="inline-note" role="status">
            <Icon name="i-check" size={16} strokeWidth={2.5} />
            <span>Sent again. It can take a minute or two to arrive.</span>
          </p>
        ) : null}
        <Button tone="secondary" full onClick={resend} loading={busy} loadingLabel="Sending…" disabled={!email} icon="i-refresh">
          Send the email again
        </Button>
        <Link className="auth-switch" to="/auth/sign-in">Back to sign in</Link>
      </div>
      <div className="auth-art">
        <span className="eyebrow">KINDLY IS FOR</span>
        <h2>Small moments that feel a little easier.</h2>
      </div>
    </main>
  );
}
