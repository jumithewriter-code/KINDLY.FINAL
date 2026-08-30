import { env, isSupabaseConfigured } from '../env';
import type { KindlyBackend } from './types';

let instance: KindlyBackend | null = null;

/**
 * Chooses the backend once per page load.
 *
 * `VITE_KINDLY_BACKEND=memory` selects the in-process implementation used by
 * tests and the offline demo. Anything else requires a configured Supabase
 * project; if the environment is incomplete we fail loudly rather than quietly
 * degrading to local storage, because a silent fallback would be exactly the
 * failure mode this product must not have.
 */
export async function getBackend(): Promise<KindlyBackend> {
  if (instance) return instance;

  if (env().backend === 'memory') {
    const { memoryBackend } = await import('./memory');
    instance = memoryBackend;
    // The end-to-end build needs a way to reach states a real user cannot set up
    // through the interface — being a KINDLY operator, for one, which is granted
    // from outside the app by design. Gated on VITE_KINDLY_E2E, which only the
    // Playwright build sets, and reachable only alongside the in-memory backend:
    // a production bundle talks to Supabase and never evaluates this branch.
    if (env().isE2E && typeof window !== 'undefined') {
      (window as unknown as { __kindlyMemoryBackend?: unknown }).__kindlyMemoryBackend = memoryBackend;
    }
    return instance;
  }

  if (!isSupabaseConfigured()) {
    throw new Error(
      'KINDLY is not configured. Copy .env.example to .env.local and set VITE_SUPABASE_URL and ' +
      'VITE_SUPABASE_ANON_KEY, or set VITE_KINDLY_BACKEND=memory to run the offline demo.',
    );
  }

  const { SupabaseBackend } = await import('./supabase');
  instance = new SupabaseBackend();
  return instance;
}

/** Test helper: replaces the singleton. */
export function __setBackendForTests(backend: KindlyBackend | null): void {
  instance = backend;
}

export type { KindlyBackend, Workspace } from './types';
