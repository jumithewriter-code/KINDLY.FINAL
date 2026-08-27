import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, TextInput } from '../../components/ui';
import { useAnnouncer, useBackend, useIsOnline } from '../../state/providers';
import { parseOrFieldErrors, signInSchema, signUpSchema, type FieldErrors } from '../../lib/schemas';
import { KindlyError } from '../../lib/types';

/**
 * Sign in / create account.
 *
 * There is no browser flag anywhere in this flow: authentication is a real
 * Supabase session. Failure states are specific and never reveal whether an
 * email address is registered.
 */
export function AuthPage({ mode }: { mode: 'sign-in' | 'create-account' }) {
  const backend = useBackend();
  const navigate = useNavigate();
  const location = useLocation();
  const { announce } = useAnnouncer();
  const online = useIsOnline();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const isSignUp = mode === 'create-account';
  const heading = isSignUp ? 'Make more good days.' : 'Welcome back.';
  const copy = isSignUp
    ? 'A private space to prepare, communicate, and connect with your child.'
    : 'Your family space is ready when you are.';
  const cta = isSignUp ? 'Create my space' : 'Sign in';
  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    const parsed = parseOrFieldErrors(isSignUp ? signUpSchema : signInSchema, { email, password });
    if (!parsed.ok) {
      setErrors(parsed.errors);
      announce('There is a problem with the form. Please check the highlighted fields.', 'assertive');
      return;
    }

    if (!online) {
      setErrors({ _form: 'You are offline. Please connect to the internet and try again.' });
      return;
    }

    setBusy(true);
    try {
      if (isSignUp) {
        const result = await backend.signUp(parsed.data.email, parsed.data.password);
        if (result.needsEmailVerification) {
          navigate('/auth/check-email', { replace: true, state: { email: parsed.data.email } });
          return;
        }
        navigate('/onboarding', { replace: true });
      } else {
        await backend.signIn(parsed.data.email, parsed.data.password);
        navigate(redirectTo, { replace: true });
      }
    } catch (error) {
      const kindly = error instanceof KindlyError ? error : null;
      const message = kindly?.message ?? 'Something went wrong. Please try again.';
      if (kindly?.code === 'EMAIL_ALREADY_REGISTERED') setErrors({ email: message });
      else if (kindly?.code === 'INVALID_CREDENTIALS') setErrors({ _form: message });
      else setErrors({ _form: message });
      announce(message, 'assertive');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page" id="main-content">
      <div className="auth-card">
        <span className="onboarding-brand">
          <span className="brand-mark"><Icon name="i-heart" size={19} strokeWidth={0} fill="currentColor" stroke="none" /></span> Kindly
        </span>
        <div className="auth-copy">
          <span className="eyebrow">A SOFTER START</span>
          <h1>{heading}</h1>
          <p>{copy}</p>
        </div>

        {errors._form ? (
          <p className="inline-error" role="alert">
            <Icon name="i-alert" size={16} strokeWidth={2.5} />
            <span>{errors._form}</span>
          </p>
        ) : null}

        <form onSubmit={onSubmit} noValidate>
          <TextInput
            label="Email address"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            required
            error={errors.email}
            onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: '', _form: '' })); }}
          />
          <TextInput
            label="Password"
            type="password"
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            placeholder={isSignUp ? 'At least 8 characters' : 'Your password'}
            value={password}
            required
            hint={isSignUp ? 'At least 8 characters. Use anything you will remember.' : undefined}
            error={errors.password}
            onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: '', _form: '' })); }}
          />
          <Button
            tone="coral"
            full
            type="submit"
            loading={busy}
            loadingLabel={isSignUp ? 'Creating your space…' : 'Signing in…'}
            iconAfter="i-arrow-right"
          >
            {cta}
          </Button>
        </form>

        <div style={{ display: 'grid', gap: 10, justifyItems: 'center', marginTop: 4 }}>
          <Link className="auth-switch" to={isSignUp ? '/auth/sign-in' : '/auth/create-account'}>
            {isSignUp ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </Link>
          <Link className="text-button" to="/auth/forgot-password">I have forgotten my password</Link>
        </div>
      </div>

      <div className="auth-art">
        <span className="eyebrow">KINDLY IS FOR</span>
        <h2>Small moments that feel a little easier.</h2>
        <p style={{ marginTop: 18, fontSize: 13.5, opacity: 0.85, maxWidth: '34ch' }}>
          Kindly is not a medical device, a diagnosis, a therapy, or an emergency service.
          In an emergency, call your local emergency number.
        </p>
      </div>
    </main>
  );
}
