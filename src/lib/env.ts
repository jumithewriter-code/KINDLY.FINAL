/**
 * Environment access, in one place, with honest failure.
 *
 * Nothing here reads secrets: only the publishable Supabase anon key reaches
 * the browser, and it is only safe because Row Level Security is enabled on
 * every table (see supabase/migrations/…_rls.sql).
 */

interface KindlyEnv {
  backend: 'supabase' | 'memory';
  supabaseUrl: string;
  supabaseAnonKey: string;
  siteUrl: string;
  isE2E: boolean;
  /** True only in a built bundle, never in `vite dev`. */
  isProduction: boolean;
  allowDemoSeed: boolean;
  /** Single-file demo build: in-process backend, hash routing, visible notice. */
  isDemo: boolean;
}

function readViteEnv(): Record<string, string | boolean | undefined> {
  try {
    return (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
  } catch {
    return {};
  }
}

let cached: KindlyEnv | null = null;

export function env(): KindlyEnv {
  if (cached) return cached;
  const raw = readViteEnv();
  // Vite writes most values as strings but a few (PROD, DEV) as booleans.
  const str = (v: string | boolean | undefined): string | undefined =>
    typeof v === 'string' ? v : v === undefined ? undefined : String(v);
  const isDemo = raw.VITE_KINDLY_DEMO === 'true';
  const backend = isDemo || str(raw.VITE_KINDLY_BACKEND) === 'memory' ? 'memory' : 'supabase';
  cached = {
    backend,
    supabaseUrl: str(raw.VITE_SUPABASE_URL) ?? '',
    supabaseAnonKey: str(raw.VITE_SUPABASE_ANON_KEY) ?? '',
    siteUrl: str(raw.VITE_PUBLIC_SITE_URL) ?? (typeof window !== 'undefined' ? window.location.origin : ''),
    isE2E: raw.VITE_KINDLY_E2E === 'true',
    isProduction: str(raw.PROD) === 'true',
    allowDemoSeed: raw.VITE_KINDLY_ALLOW_DEMO_SEED === 'true',
    isDemo,
  };
  return cached!;
}

/** Used by tests to force a configuration. */
export function __setEnvForTests(next: Partial<KindlyEnv>): void {
  cached = { ...env(), ...next };
}

export function isSupabaseConfigured(): boolean {
  const e = env();
  return e.backend === 'supabase' && Boolean(e.supabaseUrl) && Boolean(e.supabaseAnonKey);
}
