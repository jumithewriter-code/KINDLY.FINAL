import { useEffect } from 'react';
import { Outlet, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button, ErrorState, LoadingState } from '../../components/ui';
import {
  useApplyDisplayPreferences, useChildSession, useIsOnline, useWorkspace,
} from '../../state/providers';
import { childLabel, initialFrom } from '../../lib/names';
import { KindlyError } from '../../lib/types';

/**
 * Child mode.
 *
 * The whole subtree runs under a scoped child session token, not under the
 * caregiver's identity. Every child-facing read and write goes through the
 * `child_*` server functions, which check that token and the permitted action
 * list before doing anything.
 *
 * The display here follows the child's own profile: text size, contrast,
 * low-stimulation mode and motion.
 */
export function ChildShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { workspace, activeChildId } = useWorkspace();
  const { token, space, isLoading, error, start } = useChildSession();
  const online = useIsOnline();

  const requestedChildId = params.get('start');

  // Starting child mode is an explicit caregiver action from the adult view.
  useEffect(() => {
    if (token) {
      if (requestedChildId) {
        params.delete('start');
        setParams(params, { replace: true });
      }
      return;
    }
    const childId = requestedChildId ?? activeChildId ?? workspace?.children[0]?.id;
    if (childId) void start(childId);
  }, [token, requestedChildId, activeChildId, workspace, start, params, setParams]);

  useApplyDisplayPreferences(space?.preferences, true);

  // Reset the display back to the caregiver defaults when child mode is left.
  useEffect(() => () => {
    const root = document.documentElement;
    root.style.removeProperty('--kindly-text-scale');
    root.removeAttribute('data-contrast');
    root.removeAttribute('data-stimulation');
  }, []);

  if (isLoading || (!token && !error)) {
    return (
      <main className="child-mode" id="main-content">
        <LoadingState label="Opening your space" />
      </main>
    );
  }

  if (error) {
    const kindly = error instanceof KindlyError ? error : null;
    return (
      <main className="child-mode" id="main-content">
        <div className="sent-screen">
          <ErrorState error={error} />
          <div className="big-actions">
            <Button tone="danger" big icon="i-shield" onClick={() => navigate('/child/offline-help')}>
              I need help now
            </Button>
            {kindly?.code.startsWith('CHILD_SESSION') ? (
              <Button tone="ghost" big icon="i-arrow-left" onClick={() => navigate('/app')}>
                Back to the grown-up view
              </Button>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  const childName = space?.child.childName ?? '';
  const onExitScreen = location.pathname === '/child/exit';

  return (
    <main className="child-mode" id="main-content">
      {!online ? (
        <p className="offline-banner" role="status">
          <Icon name="i-offline" size={17} strokeWidth={2.5} />
          <span>You are offline. Kindly will not say a message has arrived until it really has.</span>
        </p>
      ) : null}

      {!onExitScreen ? (
        <header className="child-top">
          <button className="child-exit" onClick={() => navigate('/child/exit')}>
            <Icon name="i-arrow-left" size={20} /> Adult View
          </button>
          <span className="child-avatar" role="img" aria-label={childLabel(childName, { capital: true })}>
            <span aria-hidden="true">{initialFrom(childName) || <Icon name="i-user-round" size={20} />}</span>
          </span>
        </header>
      ) : null}

      <Outlet />
    </main>
  );
}
