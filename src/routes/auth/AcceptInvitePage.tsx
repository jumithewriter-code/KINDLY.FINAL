import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import { useAnnouncer, useAuth, useBackend, useWorkspace } from '../../state/providers';
import { KindlyError } from '../../lib/types';

/**
 * Joining a family space from an invitation link.
 *
 * The link carries a token; the token is matched against a hash on the server
 * and must belong to the signed-in adult's own email address. If they are not
 * signed in yet, we keep the link and send them through sign-in first.
 */
export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const backend = useBackend();
  const navigate = useNavigate();
  const { status } = useAuth();
  const { setActiveFamilyId, refetch } = useWorkspace();
  const { announce } = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status === 'loading') return <LoadingState label="Checking your invitation" />;

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { familyId } = await backend.acceptInvitation(token);
      setActiveFamilyId(familyId);
      refetch();
      announce('You have joined the family space.');
      navigate('/app', { replace: true });
    } catch (e) {
      setError(e);
      announce(e instanceof KindlyError ? e.message : 'That invitation could not be accepted.', 'assertive');
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
          <span className="eyebrow">AN INVITATION</span>
          <h1>Join a family space.</h1>
          <p>
            Someone has asked you to help support a child in Kindly. Accepting means you will see
            and can answer that child’s requests. The family can remove your access at any time.
          </p>
        </div>

        {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}

        {status === 'signed-out' ? (
          <>
            <p className="inline-note">
              <Icon name="i-lock" size={16} strokeWidth={2.5} />
              <span>Please sign in first with the email address the invitation was sent to.</span>
            </p>
            <Link
              className="button coral full"
              to="/auth/sign-in"
              state={{ from: `/invite/${token}` }}
            >
              Sign in to accept
            </Link>
            <Link className="auth-switch" to="/auth/create-account" state={{ from: `/invite/${token}` }}>
              I do not have an account yet
            </Link>
          </>
        ) : (
          <>
            <Button tone="coral" full onClick={accept} loading={busy} loadingLabel="Joining…" iconAfter="i-arrow-right">
              Accept and join
            </Button>
            <Link className="auth-switch" to="/app">Not now</Link>
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
