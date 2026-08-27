/**
 * Live integration test against a real Supabase project.
 *
 * This is the only test that touches a network, and it exercises the real
 * SupabaseBackend — the row mappers, the error translation, the RPC argument
 * shapes — rather than the in-process double. Everything else in the suite
 * proves the application logic; this proves the production data path.
 *
 * Skipped unless KINDLY_LIVE_TEST=1, so `npm test` stays offline and
 * deterministic. Run it with:
 *
 *   KINDLY_LIVE_TEST=1 npx vitest run src/lib/backend/supabase.live.test.ts
 *
 * It creates real rows in whatever project .env.local points at. Never point it
 * at a project holding real family data.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { SupabaseBackend } from './supabase';
import { __setEnvForTests } from '../env';
import { KindlyError } from '../types';

const LIVE = process.env.KINDLY_LIVE_TEST === '1';
const suite = LIVE ? describe : describe.skip;

function readEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

suite('SupabaseBackend against a live project', () => {
  let backend: SupabaseBackend;
  let familyId: string;
  let childId: string;
  const stamp = Date.now();

  beforeAll(async () => {
    const env = readEnvLocal();
    __setEnvForTests({
      backend: 'supabase',
      supabaseUrl: env.VITE_SUPABASE_URL!,
      supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY!,
      siteUrl: 'http://localhost:5173',
    });
    // The shared test setup clears localStorage before every test, which would
    // wipe a persisted Supabase session. Inject a client that holds its session
    // in memory instead — the backend code under test is unchanged.
    const client = createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    backend = new SupabaseBackend(client);
    await backend.signUp(`live.${stamp}@example.com`, 'kindly-live-1');
  }, 60_000);

  it('creates a family and reads it back through loadWorkspace', async () => {
    const created = await backend.bootstrapFamily({
      caregiverName: 'Rosa', childName: 'Léo',
      trustedCaregiverName: 'Grandma Ade', pin: '7391',
    });
    familyId = created.familyId;
    childId = created.childId;

    const workspace = await backend.loadWorkspace();
    expect(workspace.caregiver?.caregiverName).toBe('Rosa');
    expect(workspace.children[0]?.childName).toBe('Léo');
    expect(workspace.activeFamilyId).toBe(familyId);
    expect(workspace.members.some((m) => m.isSelf && m.role === 'owner')).toBe(true);
    expect(workspace.trustedCaregivers[childId]?.[0]?.trustedCaregiverName).toBe('Grandma Ade');
    // The built-in request vocabulary should have loaded.
    expect(workspace.requestTypes.length).toBeGreaterThanOrEqual(8);
    // Read back through get_adult_verification, not the old hardcoded stub.
    expect(workspace.adultVerification).toEqual({ mode: 'pin', isConfigured: true });
  }, 60_000);

  it('will not create a family space without a grown-up code', async () => {
    // The pin check runs before any insert, so a rejected call leaves nothing
    // behind. Proves patch 02 reached this project.
    await expect(
      backend.bootstrapFamily({ caregiverName: 'Priya', childName: 'Devi' }),
    ).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
  }, 60_000);

  it('does not accept a wrong grown-up code', async () => {
    const wrong = await backend.verifyCaregiverPin(familyId, '0000');
    expect(wrong.ok).toBe(false);
    const right = await backend.verifyCaregiverPin(familyId, '7391');
    expect(right.ok).toBe(true);
  }, 60_000);

  it('will not switch the adult check off', async () => {
    await expect(
      backend.setAdultVerificationMode(familyId, 'none'),
    ).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_MODE' });
  }, 60_000);

  it('saves and reads back child preferences and sensory notes', async () => {
    await backend.updateChild(childId, { safeAdult: 'your teacher', safePlace: 'the quiet corner' });
    await backend.updateChildPreferences(childId, {
      familyId, textScale: 1.4, lowStimulation: true, countdownsVisible: true, bathroomUrgency: 'can_wait',
    });
    await backend.setSensoryPreferences(childId, [
      { category: 'sound', kind: 'helps', label: 'Quiet spaces', detail: null, sortOrder: 0 },
      { category: 'crowding', kind: 'hard', label: 'Busy corridors', detail: null, sortOrder: 1 },
    ]);

    const workspace = await backend.loadWorkspace(familyId);
    expect(workspace.preferences[childId]?.textScale).toBe(1.4);
    expect(workspace.preferences[childId]?.lowStimulation).toBe(true);
    expect(workspace.preferences[childId]?.bathroomUrgency).toBe('can_wait');
    expect(workspace.sensoryPreferences[childId]).toHaveLength(2);
    expect(workspace.children[0]?.safePlace).toBe('the quiet corner');
  }, 60_000);

  it('runs a request from creation to resolution', async () => {
    const session = await backend.startChildSession(childId, 'Tablet');
    const token = session.sessionToken;

    const space = await backend.childGetSpace(token);
    expect(space.child.childName).toBe('Léo');
    // The child's own bathroom setting must win over the built-in default.
    expect(space.requestTypes.find((t) => t.slug === 'bathroom')?.urgency).toBe('can_wait');

    const created = await backend.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: `live-${stamp}` });
    expect(created.status).toBe('reviewing');
    expect(created.deliveredAt).toBeNull();

    const sent = await backend.childSendRequest(token, created.id);
    expect(sent.status).toBe('delivered');
    expect(sent.deliveredAt).not.toBeNull();
    expect(sent.acknowledgedAt).toBeNull();
    expect(sent.assignedToName).toBe('Rosa');

    const answered = await backend.respondToRequest({
      requestId: created.id, kind: 'coming_now', message: 'Meet me in the kitchen', urgency: 'can_wait',
    });
    expect(answered.status).toBe('acknowledged');

    // The caregiver's list view, with responses and events joined.
    const list = await backend.listRequests(familyId);
    const bundle = list.find((b) => b.request.id === created.id);
    expect(bundle?.response?.responderName).toBe('Rosa');
    expect(bundle?.response?.message).toBe('Meet me in the kitchen');
    expect(bundle!.events.length).toBeGreaterThanOrEqual(3);

    // And the child's view of the same thing.
    const childView = await backend.childGetRequests(token);
    expect(childView.find((b) => b.request.id === created.id)?.response?.kind).toBe('coming_now');

    const resolved = await backend.resolveRequest(created.id, false);
    expect(resolved.status).toBe('resolved');
  }, 90_000);

  it('refuses to delay an urgent request, with a readable message', async () => {
    const session = await backend.startChildSession(childId);
    const created = await backend.childCreateRequest(session.sessionToken, {
      typeSlug: 'pain', dedupeKey: `live-urgent-${stamp}`,
    });
    await backend.childSendRequest(session.sessionToken, created.id);

    const error = await backend
      .respondToRequest({ requestId: created.id, kind: 'delay', delayMinutes: 5, urgency: 'urgent' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(KindlyError);
    expect((error as KindlyError).code).toBe('URGENT_REQUEST_CANNOT_BE_DELAYED');
    // The message must be something a caregiver can act on, not a Postgres string.
    expect((error as KindlyError).message).toMatch(/cannot be answered with a delay/i);
  }, 90_000);

  it('creates, edits and approves a story, and only then can it reach a child', async () => {
    const pages = [
      { sectionKey: 'title' as const, heading: null, body: 'Going to the dentist', certainty: 'fact' as const },
      { sectionKey: 'choices' as const, heading: 'What I can do', body: 'I can ask for a break. I can hold my fidget.', certainty: 'choice' as const },
      { sectionKey: 'ending' as const, heading: 'The ending', body: 'I do not know exactly how it will feel. I can tell a trusted adult.', certainty: 'fact' as const },
    ];

    const draft = await backend.saveStoryDraft({
      childId, title: 'Going to the dentist', scenarioKey: 'doctor_or_dentist',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    expect(draft.status).toBe('draft');
    expect(draft.pages).toHaveLength(3);

    const notApproved = await backend.assignStory(draft.id, childId).catch((e) => e);
    expect((notApproved as KindlyError).code).toBe('STORY_NOT_APPROVED');

    const approved = await backend.approveStory(draft.id, true);
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();

    await backend.assignStory(draft.id, childId);
    const session = await backend.startChildSession(childId);
    const childStories = await backend.childGetStories(session.sessionToken);
    expect(childStories.map((s) => s.title)).toContain('Going to the dentist');

    await backend.withdrawStory(draft.id, childId);
    expect(await backend.childGetStories(session.sessionToken)).toHaveLength(0);
  }, 120_000);

  it('saves a routine and runs it without scoring anything', async () => {
    const routine = await backend.saveRoutine({
      childId, title: 'Morning check-in',
      steps: [{ title: 'Wake up slowly' }, { title: 'Get dressed' }],
    });
    expect(routine.steps.map((s) => s.title)).toEqual(['Wake up slowly', 'Get dressed']);

    const run = await backend.startRoutineRun(routine.id, 'child');
    const skipped = await backend.setRoutineStepState(run.id, routine.steps[0]!.id, 'skipped');
    expect(skipped.stepStates[0]?.state).toBe('skipped');
    const finished = await backend.setRoutineStepState(run.id, routine.steps[1]!.id, 'done');
    expect(finished.status).toBe('finished');
    expect(JSON.stringify(finished)).not.toMatch(/score|streak|points/i);
  }, 90_000);

  it('exports the family record and lists notifications', async () => {
    const exported = await backend.exportFamilyData(familyId) as Record<string, unknown>;
    expect(Object.keys(exported)).toEqual(expect.arrayContaining(['family', 'children', 'requests', 'stories']));

    const notifications = await backend.listNotifications(familyId);
    expect(notifications.length).toBeGreaterThan(0);
    await backend.markNotificationsRead();
    expect((await backend.listNotifications(familyId)).every((n) => n.readAt)).toBe(true);
  }, 60_000);
});
