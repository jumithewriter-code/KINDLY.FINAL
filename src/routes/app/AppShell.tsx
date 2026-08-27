import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { Avatar, Button, ErrorState, LoadingState, OfflineBanner, StatusPill } from '../../components/ui';
import {
  useAnnouncer, useApplyDisplayPreferences, useAuth, useBackend, useIsOnline, useWorkspace,
} from '../../state/providers';
import { caregiverLabel, childLabel, initialFrom, possessive } from '../../lib/names';
import { formatDate, formatTime } from '../../lib/format';
import { STATUS_META, isLive } from '../../lib/requests/stateMachine';

const NAV = [
  { to: '/app', label: 'Home', icon: 'i-home', end: true },
  { to: '/app/stories', label: 'Stories', icon: 'i-book-open' },
  { to: '/app/requests', label: 'Requests', icon: 'i-message-circle' },
  { to: '/app/routines', label: 'Routines', icon: 'i-clock-3' },
  { to: '/app/profile', label: 'Profile', icon: 'i-user-round' },
] as const;

const TITLES: Record<string, string> = {
  '/app': 'Home',
  '/app/stories': 'Stories',
  '/app/requests': 'Requests',
  '/app/routines': 'Routines',
  '/app/profile': 'Profile',
  '/app/settings': 'Settings',
};

export function AppShell() {
  const backend = useBackend();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { workspace, isLoading, error, refetch, activeChildId, activeFamilyId } = useWorkspace();
  const { announce } = useAnnouncer();
  const online = useIsOnline();

  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement | null>(null);

  // The caregiver view uses the product's own display defaults, never the
  // child's profile: their preferences belong to child mode.
  useApplyDisplayPreferences(null, false);

  const requestsQuery = useQuery({
    queryKey: ['requests', activeFamilyId],
    queryFn: () => backend.listRequests(activeFamilyId!),
    enabled: Boolean(activeFamilyId),
    refetchInterval: online ? 15_000 : false,
  });

  const notificationsQuery = useQuery({
    queryKey: ['notifications', activeFamilyId],
    queryFn: () => backend.listNotifications(activeFamilyId!),
    enabled: Boolean(activeFamilyId),
  });

  // Realtime: child and caregiver screens stay in step.
  useEffect(() => {
    if (!activeFamilyId) return undefined;
    return backend.subscribeToFamily(activeFamilyId, () => {
      void client.invalidateQueries({ queryKey: ['requests', activeFamilyId] });
      void client.invalidateQueries({ queryKey: ['notifications', activeFamilyId] });
    });
  }, [backend, client, activeFamilyId]);

  // Escalation heartbeat. In production pg_cron runs the same function; this
  // keeps escalation honest in development and on a single-device family.
  useEffect(() => {
    if (!activeFamilyId || !online) return undefined;
    const tick = () => {
      backend.tickEscalations(activeFamilyId)
        .then((changed) => {
          if (changed > 0) void client.invalidateQueries({ queryKey: ['requests', activeFamilyId] });
        })
        .catch(() => { /* a failed heartbeat must never break the page */ });
    };
    tick();
    const id = window.setInterval(tick, 10_000);
    return () => window.clearInterval(id);
  }, [backend, client, activeFamilyId, online]);

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => backend.markNotificationsRead(ids),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notifications', activeFamilyId] }),
  });

  useEffect(() => {
    if (!notifOpen) return undefined;
    const onClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNotifOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [notifOpen]);

  const caregiver = workspace?.members.find((m) => m.isSelf);
  const caregiverName = workspace?.caregiver?.caregiverName ?? caregiver?.caregiverName ?? '';
  const child = workspace?.children.find((c) => c.id === activeChildId) ?? workspace?.children[0];
  const childName = child?.childName ?? '';

  const bundles = requestsQuery.data ?? [];
  const activeBundle = useMemo(() => bundles.find((b) => isLive(b.request.status)), [bundles]);
  const notifications = notificationsQuery.data ?? [];
  const unread = notifications.filter((n) => !n.readAt);

  // Announce a change of status on the live request, once per change.
  const lastAnnounced = useRef<string>('');
  useEffect(() => {
    if (!activeBundle) return;
    const key = `${activeBundle.request.id}:${activeBundle.request.status}`;
    if (lastAnnounced.current === key) return;
    lastAnnounced.current = key;
    const meta = STATUS_META[activeBundle.request.status];
    announce(
      `${childLabel(childName, { capital: true })}: ${activeBundle.request.childFacingLabel}. ${meta.text}.`,
      activeBundle.request.urgency === 'urgent' ? 'assertive' : 'polite',
    );
  }, [activeBundle, announce, childName]);

  if (isLoading && !workspace) return <LoadingState label="Opening your space" />;
  if (error && !workspace) return <ErrorState error={error} onRetry={refetch} />;
  if (!workspace) return <ErrorState error={new Error('Your space could not be loaded.')} onRetry={refetch} />;

  const pageTitle = TITLES[location.pathname]
    ?? (location.pathname.startsWith('/app/settings') ? 'Settings'
      : location.pathname.startsWith('/app/requests') ? 'Requests'
      : location.pathname.startsWith('/app/stories') ? 'Stories'
      : location.pathname.startsWith('/app/routines') ? 'Routines' : 'Home');

  const headerTitle = location.pathname === '/app'
    ? `Good morning${caregiverName ? `, ${caregiverName}` : ''}`
    : pageTitle;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Icon name="i-heart" size={20} fill="currentColor" stroke="none" /></div>
          <span>Kindly</span>
        </div>

        <button className="profile-mini" onClick={() => navigate('/app/profile')} aria-label="Open profile and switch child">
          <Avatar initial={initialFrom(childName)} label={childLabel(childName, { capital: true })} />
          <div>
            <strong>{childName ? `${possessive(childName)} space` : 'Your space'}</strong>
            <small>{caregiverName ? `${caregiverName} · Caregiver` : 'Caregiver view'}</small>
          </div>
          <Icon name="i-chevron-down" size={15} />
        </button>

        <nav aria-label="Main navigation">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item ? item.end : false}
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.label === 'Requests' && activeBundle ? <b className="nav-badge">1</b> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <NavLink to="/app/settings" className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}>
            <Icon name="i-settings-2" size={19} />
            <span>Settings</span>
          </NavLink>
          <div className="made-for">
            <Icon name="i-sparkles" size={16} />
            <span>Made for<br /><strong>more good days</strong></span>
          </div>
        </div>
      </aside>

      <section className="main-content">
        {!online ? <OfflineBanner /> : null}

        <header className="topbar">
          <div>
            <span className="mobile-brand">Kindly</span>
            <p className="date-label">{formatDate(new Date().toISOString())}</p>
            <h1>{headerTitle}</h1>
          </div>
          <div className="top-actions">
            <div className="notification-wrap" ref={notifRef}>
              <button
                className="icon-button"
                aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
                aria-expanded={notifOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  const next = !notifOpen;
                  setNotifOpen(next);
                  if (next && unread.length) markRead.mutate(undefined);
                }}
              >
                <Icon name="i-bell" size={20} />
                {unread.length ? <b className="notification-dot" /> : null}
              </button>

              {notifOpen ? (
                <div className="notification-popover" role="dialog" aria-label="Notifications">
                  <b>Notifications</b>
                  {notifications.length === 0 ? (
                    <p>You are all caught up.</p>
                  ) : (
                    <ul style={{ listStyle: 'none', margin: '10px 0', padding: 0, display: 'grid', gap: 8 }}>
                      {notifications.slice(0, 8).map((n) => (
                        <li key={n.id}>
                          <button
                            className="text-button"
                            style={{ textAlign: 'left', display: 'grid', gap: 2 }}
                            onClick={() => {
                              setNotifOpen(false);
                              markRead.mutate([n.id]);
                              if (n.route) navigate(n.route);
                            }}
                          >
                            <b style={{ fontSize: 13 }}>
                              {n.isUrgent ? <Icon name="i-alert" size={12} strokeWidth={3} /> : null} {n.title}
                            </b>
                            {n.body ? <small style={{ color: 'var(--muted-foreground)' }}>{n.body}</small> : null}
                            <small style={{ color: 'var(--muted-foreground)' }}>{formatTime(n.createdAt)}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="text-button" onClick={() => setNotifOpen(false)}>Close</button>
                </div>
              ) : null}
            </div>

            <button
              className="avatar large profile-trigger"
              aria-label={caregiverName ? `Open profile — signed in as ${caregiverName}` : 'Open profile'}
              onClick={() => navigate('/app/profile')}
            >
              <span aria-hidden="true">{initialFrom(caregiverName) || <Icon name="i-user-round" size={20} />}</span>
            </button>
          </div>
        </header>

        {user && !user.emailVerified ? (
          <div className="content-wrap" style={{ paddingBottom: 0 }}>
            <p className="inline-note" role="status">
              <Icon name="i-alert" size={16} strokeWidth={2.5} />
              <span>
                Your email address is not confirmed yet. Some features stay available, but please
                confirm it so you can reset your password if you need to.
              </span>
            </p>
          </div>
        ) : null}

        {activeBundle ? (
          <div className="content-wrap" style={{ paddingBottom: 0 }}>
            <div className="req-banner" role="status">
              <span className="pictogram" style={{ background: '#fff' }} aria-hidden="true">
                <Icon name={activeBundle.request.pictogramKey ?? 'i-message-circle'} size={24} strokeWidth={2.5} />
              </span>
              <div className="req-banner-main">
                <b>{childLabel(childName, { capital: true })} asked for: {activeBundle.request.childFacingLabel}</b>
                <small>
                  {activeBundle.request.urgency === 'urgent' ? 'Urgent' : 'Can wait'}
                  {' · '}
                  Sent {formatTime(activeBundle.request.sendingStartedAt ?? activeBundle.request.createdAt)}
                  {' · '}
                  {activeBundle.request.assignedToName && activeBundle.request.assignedToUserId !== user?.id
                    ? `With ${activeBundle.request.assignedToName}`
                    : 'With you'}
                </small>
              </div>
              <StatusPill
                tone={STATUS_META[activeBundle.request.status].tone}
                icon={STATUS_META[activeBundle.request.status].icon}
                text={STATUS_META[activeBundle.request.status].text}
              />
              <Button tone="coral" onClick={() => navigate(`/app/requests/${activeBundle.request.id}`)}>Open</Button>
            </div>
          </div>
        ) : null}

        <div id="main-content" tabIndex={-1}>
          <Outlet />
        </div>
      </section>
    </div>
  );
}

export function useCaregiverDisplayName(): string {
  const { workspace } = useWorkspace();
  return caregiverLabel(workspace?.caregiver?.caregiverName, { capital: true });
}
