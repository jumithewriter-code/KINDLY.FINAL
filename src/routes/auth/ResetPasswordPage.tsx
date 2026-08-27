import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, TextInput } from '../../components/ui';
import { useAnnouncer, useBackend } from '../../state/providers';
import { parseOrFieldErrors, resetPasswordSchema, type FieldErrors } from '../../lib/schemas';
import { KindlyError } from '../../lib/types';

/**
 * Choose a new password.
 *
 * Reached from the emailed link. Supabase has already exchanged the code for a
 * short-lived session by the time this renders, so the only job here is to
 * validate the new password and call updateUser.
 */
export function ResetPasswordPage() {
  const backend = useBackend();
  const navigate = useNavigate();
  const { announce } = useAnnouncer();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseOrFieldErrors(resetPasswordSchema, { password, confirm });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      announce('Please check the highlighted fields.', 'assertive');
      return;
    }
    setBusy(true);
    try {
      await backend.updatePassword(parsed.data.password);
      announce('Your password has been changed.');
      navigate('/app', { replace: true });
    } catch (error) {
      const message = error instanceof KindlyError
        ? error.message
        : 'That link may have expired. Ask for a new reset link and try again.';
      setErrors({ _form: message });
      announce(message, 'assertive');
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
          <span className="eyebrow">A SOFTER START</span>
          <h1>Choose a new password.</h1>
          <p>Pick something you will remember. You will stay signed in on this device.</p>
        </div>

        {errors._form ? (
          <p className="inline-error" role="alert">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>{errors._form}</span>
          </p>
        ) : null}

        <form onSubmit={onSubmit} noValidate>
          <TextInput
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            required
            hint="At least 8 characters."
            error={errors.password}
            onChange={(e) => { setPassword(e.target.value); setErrors({}); }}
          />
          <TextInput
            label="Type your new password again"
            type="password"
            autoComplete="new-password"
            value={confirm}
            required
            error={errors.confirm}
            onChange={(e) => { setConfirm(e.target.value); setErrors({}); }}
          />
          <Button tone="coral" full type="submit" loading={busy} loadingLabel="Saving…">Save my new password</Button>
        </form>
        <Link className="auth-switch" to="/auth/sign-in">Back to sign in</Link>
      </div>
      <div className="auth-art">
        <span className="eyebrow">KINDLY IS FOR</span>
        <h2>Small moments that feel a little easier.</h2>
      </div>
    </main>
  );
}
