/**
 * The ONLY sanctioned use of browser storage in the application.
 *
 * Permitted here: harmless per-device conveniences and temporary drafts that
 * would be annoying — not harmful — to lose. Everything else (accounts,
 * profiles, requests, stories, routines, safety settings) lives on the server.
 *
 * A child-mode session token is deliberately kept in `sessionStorage`, not
 * `localStorage`: it must not outlive the browser tab, and it is a capability,
 * not a record. The authoritative session lives in `public.child_sessions` and
 * a caregiver can revoke it at any time.
 */

const NAMESPACE = 'kindly';

type DeviceKey =
  | 'lastFamilyId'          // which family space to open first
  | 'lastChildId'           // which child's space to show first
  | 'sidebarCollapsed'
  | 'notificationPromptSeen'
  | 'reducedMotionOverride';

type DraftKey = `draft:${string}`;

function readJson<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(`${NAMESPACE}:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage | undefined, key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) storage?.removeItem(`${NAMESPACE}:${key}`);
    else storage?.setItem(`${NAMESPACE}:${key}`, JSON.stringify(value));
  } catch {
    /* private mode / storage disabled — every caller works without it */
  }
}

const local = (): Storage | undefined => {
  try { return globalThis.localStorage; } catch { return undefined; }
};
const session = (): Storage | undefined => {
  try { return globalThis.sessionStorage; } catch { return undefined; }
};

export const devicePrefs = {
  get<T>(key: DeviceKey): T | null { return readJson<T>(local(), key); },
  set(key: DeviceKey, value: unknown): void { writeJson(local(), key, value); },
  clear(key: DeviceKey): void { writeJson(local(), key, null); },
};

/**
 * Temporary form drafts. These are convenience only: the server-side
 * `caregiver_profiles.onboarding_data` is what actually survives a device
 * change, and a draft is discarded as soon as it is saved for real.
 */
export const drafts = {
  get<T>(key: DraftKey): T | null { return readJson<T>(local(), key); },
  set(key: DraftKey, value: unknown): void { writeJson(local(), key, value); },
  clear(key: DraftKey): void { writeJson(local(), key, null); },
};

/** The child-mode capability token for this tab only. */
export const childSessionStore = {
  get(): { token: string; childId: string; familyId: string; expiresAt: string } | null {
    return readJson(session(), 'childSession');
  },
  set(value: { token: string; childId: string; familyId: string; expiresAt: string } | null): void {
    writeJson(session(), 'childSession', value);
  },
};
