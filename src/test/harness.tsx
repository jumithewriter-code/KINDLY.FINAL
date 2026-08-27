import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { MemoryBackend } from '../lib/backend/memory';

export interface Harness {
  backend: MemoryBackend;
  familyId: string;
  childId: string;
  userId: string;
}

/**
 * Builds a family the same way a real caregiver would: sign up, complete the
 * first onboarding step, add safety details. No fixture writes straight to the
 * emulated database, so the tests exercise the real code paths.
 */
export async function seedHarness(options?: {
  childName?: string;
  caregiverName?: string;
  trustedCaregiverName?: string | null;
  pin?: string | null;
}): Promise<Harness> {
  const backend = new MemoryBackend();
  backend.reset();

  const user = await backend.signUp('caregiver@example.test', 'kindly-demo-1');
  const { familyId, childId } = await backend.bootstrapFamily({
    caregiverName: options?.caregiverName ?? 'Rosa',
    childName: options?.childName ?? 'Léo',
    trustedCaregiverName: options?.trustedCaregiverName ?? 'Grandma Ade',
    pin: options?.pin ?? '7391',
  });
  await backend.updateChild(childId, {
    safeAdult: 'your teacher, Mr O’Neill',
    safePlace: 'the quiet corner',
  });

  return { backend, familyId, childId, userId: user.user!.id };
}

export function renderApp(backend: MemoryBackend, route = '/app'): RenderResult {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App backend={backend} />
    </MemoryRouter>,
  );
}
