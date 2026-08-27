/**
 * Application state.
 *
 * Four contexts, in dependency order:
 *   BackendProvider   — which implementation we talk to
 *   AnnouncerProvider — one polite and one assertive live region
 *   AuthProvider      — the signed-in adult (or nobody)
 *   WorkspaceProvider — the family, its children, and the active selections
 *
 * ChildSessionProvider is mounted separately, only under /child.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBackend, type KindlyBackend, type Workspace } from '../lib/backend';
import { devicePrefs, childSessionStore } from '../lib/devicePrefs';
import { KindlyError, type AuthUser, type ChildPreferences, type ChildSpace } from '../lib/types';

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

const BackendContext = createContext<KindlyBackend | null>(null);

export function useBackend(): KindlyBackend {
  const backend = useContext(BackendContext);
  if (!backend) throw new Error('useBackend must be used inside <BackendProvider>.');
  return backend;
}

/**
 * One cache per mounted app, not one per module: two mounted apps (or two
 * tests) must never share fetched data.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const kindly = error instanceof KindlyError ? error : null;
        if (kindly && !kindly.retryable) return false;
        return failureCount < 2;
      },
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
  });
}

export function BackendProvider({ children, backend: injected }: { children: ReactNode; backend?: KindlyBackend }) {
  const [backend, setBackend] = useState<KindlyBackend | null>(injected ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [client] = useState(createQueryClient);

  useEffect(() => {
    if (injected) { setBackend(injected); return; }
    let cancelled = false;
    getBackend()
      .then((b) => { if (!cancelled) setBackend(b); })
      .catch((e: Error) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; };
  }, [injected]);

  if (error) {
    return (
      <main className="auth-page">
        <div className="auth-card" role="alert">
          <h1>KINDLY is not configured</h1>
          <p>{error.message}</p>
        </div>
      </main>
    );
  }
  if (!backend) {
    return <div className="state-block" role="status" aria-live="polite"><h3>Starting KINDLY…</h3></div>;
  }

  return (
    <BackendContext.Provider value={backend}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </BackendContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Announcer — status changes reach assistive technology without stealing focus
// ---------------------------------------------------------------------------

interface AnnouncerValue {
  announce: (message: string, urgency?: 'polite' | 'assertive') => void;
}

const AnnouncerContext = createContext<AnnouncerValue>({ announce: () => {} });

export function useAnnouncer(): AnnouncerValue {
  return useContext(AnnouncerContext);
}

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const lastRef = useRef<{ message: string; at: number }>({ message: '', at: 0 });

  const announce = useCallback((message: string, urgency: 'polite' | 'assertive' = 'polite') => {
    const now = Date.now();
    // Do not flood assistive technology with the same message twice in a row.
    if (lastRef.current.message === message && now - lastRef.current.at < 1500) return;
    lastRef.current = { message, at: now };
    if (urgency === 'assertive') { setAssertive(''); requestAnimationFrame(() => setAssertive(message)); }
    else { setPolite(''); requestAnimationFrame(() => setPolite(message)); }
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </AnnouncerContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface AuthValue {
  user: AuthUser | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const client = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthValue['status']>('loading');

  const refresh = useCallback(async () => {
    const next = await backend.getCurrentUser();
    setUser(next);
    setStatus(next ? 'signed-in' : 'signed-out');
  }, [backend]);

  useEffect(() => {
    let cancelled = false;
    backend.getCurrentUser()
      .then((next) => {
        if (cancelled) return;
        setUser(next);
        setStatus(next ? 'signed-in' : 'signed-out');
      })
      .catch(() => { if (!cancelled) setStatus('signed-out'); });

    const unsubscribe = backend.onAuthStateChange((next) => {
      setUser(next);
      setStatus(next ? 'signed-in' : 'signed-out');
      client.clear();
    });

    return () => { cancelled = true; unsubscribe(); };
  }, [backend, client]);

  const signOut = useCallback(async () => {
    await backend.signOut();
    childSessionStore.set(null);
    client.clear();
    setUser(null);
    setStatus('signed-out');
  }, [backend, client]);

  const value = useMemo(() => ({ user, status, refresh, signOut }), [user, status, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

interface WorkspaceValue {
  workspace: Workspace | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  activeFamilyId: string | null;
  setActiveFamilyId: (id: string) => void;
  activeChildId: string | null;
  setActiveChildId: (id: string) => void;
  /** Permission check for the signed-in adult in the active family. */
  can: (permission: keyof NonNullable<Workspace['members'][number]['permissions']>) => boolean;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  return value;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const { user } = useAuth();
  const [activeFamilyId, setFamily] = useState<string | null>(() => devicePrefs.get<string>('lastFamilyId'));
  const [activeChildId, setChild] = useState<string | null>(() => devicePrefs.get<string>('lastChildId'));

  const query = useQuery({
    queryKey: ['workspace', user?.id, activeFamilyId],
    queryFn: () => backend.loadWorkspace(activeFamilyId),
    enabled: Boolean(user),
    // The key changes once the active family resolves. Keeping the previous
    // result means the shell does not flash back to a loading state, and the
    // page the caregiver is reading does not disappear underneath them.
    placeholderData: (previous) => previous,
  });

  const workspace = query.data;

  useEffect(() => {
    if (!workspace) return;
    if (workspace.activeFamilyId && workspace.activeFamilyId !== activeFamilyId) {
      setFamily(workspace.activeFamilyId);
      devicePrefs.set('lastFamilyId', workspace.activeFamilyId);
    }
    const stillValid = workspace.children.some((c) => c.id === activeChildId);
    if (!stillValid) {
      const next = workspace.children[0]?.id ?? null;
      setChild(next);
      if (next) devicePrefs.set('lastChildId', next);
    }
  }, [workspace, activeFamilyId, activeChildId]);

  const setActiveFamilyId = useCallback((id: string) => {
    setFamily(id);
    devicePrefs.set('lastFamilyId', id);
  }, []);

  const setActiveChildId = useCallback((id: string) => {
    setChild(id);
    devicePrefs.set('lastChildId', id);
  }, []);

  const can = useCallback((permission: keyof Workspace['members'][number]['permissions']) => {
    const me = workspace?.members.find((m) => m.isSelf && !m.revokedAt);
    return Boolean(me?.permissions[permission]);
  }, [workspace]);

  const value = useMemo<WorkspaceValue>(() => ({
    workspace,
    // Only "loading" when there is genuinely nothing to show yet.
    isLoading: query.isLoading && !workspace,
    error: query.error,
    refetch: () => { void query.refetch(); },
    activeFamilyId: workspace?.activeFamilyId ?? activeFamilyId,
    setActiveFamilyId,
    activeChildId: activeChildId ?? workspace?.children[0]?.id ?? null,
    setActiveChildId,
    can,
  }), [workspace, query, activeFamilyId, activeChildId, setActiveFamilyId, setActiveChildId, can]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

// ---------------------------------------------------------------------------
// Display preferences — applied to <html> so the whole page responds
// ---------------------------------------------------------------------------

export function useApplyDisplayPreferences(prefs: Partial<ChildPreferences> | null | undefined, active: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!active || !prefs) {
      root.style.removeProperty('--kindly-text-scale');
      root.removeAttribute('data-contrast');
      root.removeAttribute('data-stimulation');
      root.setAttribute('data-motion', 'reduced');
      return;
    }
    root.style.setProperty('--kindly-text-scale', String(prefs.textScale ?? 1));
    if (prefs.highContrast) root.setAttribute('data-contrast', 'high');
    else root.removeAttribute('data-contrast');
    if (prefs.lowStimulation) root.setAttribute('data-stimulation', 'low');
    else root.removeAttribute('data-stimulation');

    // Motion is opt-in, and the operating system always wins.
    const systemReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    root.setAttribute('data-motion', prefs.animationEnabled && !systemReduced ? 'full' : 'reduced');
  }, [prefs, active]);
}

// ---------------------------------------------------------------------------
// Online / offline
// ---------------------------------------------------------------------------

export function useIsOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

// ---------------------------------------------------------------------------
// Child session
// ---------------------------------------------------------------------------

interface ChildSessionValue {
  token: string | null;
  space: ChildSpace | undefined;
  isLoading: boolean;
  error: unknown;
  start: (childId: string) => Promise<void>;
  end: () => Promise<void>;
  refresh: () => void;
}

const ChildSessionContext = createContext<ChildSessionValue | null>(null);

export function useChildSession(): ChildSessionValue {
  const value = useContext(ChildSessionContext);
  if (!value) throw new Error('useChildSession must be used inside <ChildSessionProvider>.');
  return value;
}

export function ChildSessionProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const client = useQueryClient();
  const [token, setToken] = useState<string | null>(() => childSessionStore.get()?.token ?? null);

  const query = useQuery({
    queryKey: ['child-space', token],
    queryFn: () => backend.childGetSpace(token!),
    enabled: Boolean(token),
    staleTime: 30_000,
  });

  // A revoked or expired session must drop the token rather than keep retrying.
  useEffect(() => {
    const error = query.error;
    if (error instanceof KindlyError && error.code.startsWith('CHILD_SESSION')) {
      childSessionStore.set(null);
      setToken(null);
    }
  }, [query.error]);

  const start = useCallback(async (childId: string) => {
    const session = await backend.startChildSession(childId, 'This device');
    childSessionStore.set({
      token: session.sessionToken, childId: session.childId,
      familyId: session.familyId, expiresAt: session.expiresAt,
    });
    setToken(session.sessionToken);
    await client.invalidateQueries({ queryKey: ['child-space'] });
  }, [backend, client]);

  const end = useCallback(async () => {
    const current = childSessionStore.get();
    if (current) await backend.endChildSession(current.token);
    childSessionStore.set(null);
    setToken(null);
    client.removeQueries({ queryKey: ['child-space'] });
  }, [backend, client]);

  // Keep the child's screens in step with the caregiver's in real time.
  useEffect(() => {
    const childId = query.data?.child.id;
    if (!childId) return undefined;
    return backend.subscribeToChild(childId, () => {
      void client.invalidateQueries({ queryKey: ['child-requests'] });
      void client.invalidateQueries({ queryKey: ['child-space'] });
    });
  }, [backend, client, query.data?.child.id]);

  const value = useMemo<ChildSessionValue>(() => ({
    token,
    space: query.data,
    isLoading: query.isLoading,
    error: query.error,
    start,
    end,
    refresh: () => { void query.refetch(); },
  }), [token, query, start, end]);

  return <ChildSessionContext.Provider value={value}>{children}</ChildSessionContext.Provider>;
}
