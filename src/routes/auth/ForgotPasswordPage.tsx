import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, TextInput } from '../../components/ui';
import { useAnnouncer, useBackend } from '../../state/providers';
import { forgotPasswordSchema, parseOrFieldErrors, type FieldErrors } from '../../lib/schemas';

export function ForgotPasswordPage() {
  const backend = useBackend();
  const { announce } = useAnnouncer();
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseOrFieldErrors(forgotPasswordSchema, { email });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      announce('Please check the email address.', 'assertive');
      return;
    }
    setBusy(true);
    try {
      await backend.sendPasswordReset(parsed.data.email);
      setSent(true);
      announce('If that address has an account, a reset link is on its way.');
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

        {sent ? (
          <>
            <div className="auth-copy">
              <span className="eyebrow">CHECK YOUR EMAIL</span>
              <h1>If that address has an account, a link is on its way.</h1>
              <p>
                Open the link on this device to choose a new password. It works once and expires
                after an hour. We do not say whether an address is registered, so nobody can use
                this page to find out who uses Kindly.
              </p>
            </div>
            <Link className="button coral full" to="/auth/sign-in">Back to sign in</Link>
          </>
        ) : (
          <>
            <div className="auth-copy">
              <span className="eyebrow">A SOFTER START</span>
              <h1>Forgotten your password?</h1>
              <p>Enter the email address you use for Kindly and we will send a reset link.</p>
            </div>
            <form onSubmit={onSubmit} noValidate>
              <TextInput
                label="Email address"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                required
                error={errors.email}
                onChange={(e) => { setEmail(e.target.value); setErrors({}); }}
              />
              <Button tone="coral" full type="submit" loading={busy} loadingLabel="Sending…" iconAfter="i-arrow-right">
                Send a reset link
              </Button>
            </form>
            <Link className="auth-switch" to="/auth/sign-in">Back to sign in</Link>
          </>
        )}
      </div>
      <div className="auth-art">
        <span className="eyebrow">KINDLY IS FOR</span>
        <h2>Small moments that feel a little easier.</h2>
      </div>
    </main>
  );
}
