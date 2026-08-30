import { useQuery } from '@tanstack/react-query';
import { useAuth, useBackend } from './providers';

/**
 * Whether the signed-in account is a KINDLY operator.
 *
 * This decides whether one nav link is drawn. It is deliberately *not* the
 * security boundary: `public.operator_metrics()` re-checks membership of
 * `kindly.operators` on every call, so a client that lies about this learns
 * nothing. Rendering is a convenience; the server is the gate.
 *
 * Defaults to false while loading and on any error, so the link never flickers
 * into view for someone who cannot use it.
 */
export function useIsOperator(): boolean {
  const backend = useBackend();
  const { status, user } = useAuth();

  const { data } = useQuery({
    queryKey: ['is-operator', user?.id ?? null],
    queryFn: () => backend.amIOperator(),
    enabled: status === 'signed-in',
    staleTime: 5 * 60_000,
    retry: false,
  });

  return data === true;
}
