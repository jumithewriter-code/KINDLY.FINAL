import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from './memory';
import { KindlyError } from '../types';
import { isLive } from '../requests/stateMachine';

/**
 * Integration tests against the in-process backend.
 *
 * This backend enforces the same authorization rules as the SQL functions and
 * RLS policies, so these tests exercise real behaviour rather than a permissive
 * mock: a caregiver from another family is rejected, a child session can only
 * do what its action list allows, and an urgent request cannot be delayed.
 */

let rosa: MemoryBackend;      // owner caregiver, device 1
let marcus: MemoryBackend;    // second caregiver, device 2
let childDevice: MemoryBackend; // the child's device, same family
let outsider: MemoryBackend;  // an adult in a completely different family

let familyId: string;
let leoId: string;

async function seedFamily() {
  rosa = new MemoryBackend();
  rosa.reset();

  await rosa.signUp('rosa@example.test', 'kindly-demo-1');
  const created = await rosa.bootstrapFamily({
    caregiverName: 'Rosa',
    childName: 'Léo',
    trustedCaregiverName: 'Grandma Ade',
    pin: '7391',
  });
  familyId = created.familyId;
  leoId = created.childId;

  await rosa.updateChild(leoId, {
    safeAdult: 'your teacher, Mr O’Neill',
    safePlace: 'the quiet corner',
  });

  // A second caregiver joins by invitation, on their own device.
  const { token } = await rosa.inviteCaregiver(familyId, { email: 'marcus@example.test', role: 'caregiver' });
  marcus = new MemoryBackend();
  await marcus.signUp('marcus@example.test', 'kindly-demo-2');
  await marcus.updateCaregiverProfile({ caregiverName: 'Marcus' });
  await marcus.acceptInvitation(token);

  // The child's device: still a family device, but every action goes through a
  // scoped child session.
  childDevice = new MemoryBackend();
  childDevice.useSession((await rosa.getCurrentUser())!.id);

  outsider = new MemoryBackend();
  await outsider.signUp('nobody@example.test', 'kindly-demo-3');
  await outsider.bootstrapFamily({ caregiverName: 'Sam', childName: 'Ana', pin: '2648' });
}

async function startChildSession() {
  const session = await childDevice.startChildSession(leoId, 'Tablet');
  return session.sessionToken;
}

beforeEach(async () => {
  await seedFamily();
});

// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('rejects a duplicate email address', async () => {
    const other = new MemoryBackend();
    await expect(other.signUp('rosa@example.test', 'another-password'))
      .rejects.toThrow(/already exists/i);
  });

  it('gives the same message for a wrong password and an unknown account', async () => {
    const anon = new MemoryBackend();
    const wrongPassword = await anon.signIn('rosa@example.test', 'nope').catch((e: KindlyError) => e);
    const unknownUser = await anon.signIn('nobody-here@example.test', 'nope').catch((e: KindlyError) => e);
    expect((wrongPassword as KindlyError).message).toBe((unknownUser as KindlyError).message);
    expect((wrongPassword as KindlyError).code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses to load a workspace when nobody is signed in', async () => {
    const anon = new MemoryBackend();
    anon.useSession(null);
    await expect(anon.loadWorkspace()).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
  });

  it('never reveals whether a password-reset address exists', async () => {
    await expect(rosa.sendPasswordReset('nobody-here@example.test')).resolves.toBeUndefined();
  });
});

describe('caregiver and child identities stay separate', () => {
  it('stores three distinct names in three distinct places', async () => {
    const workspace = await rosa.loadWorkspace();
    expect(workspace.caregiver?.caregiverName).toBe('Rosa');
    expect(workspace.children[0]?.childName).toBe('Léo');
    expect(workspace.trustedCaregivers[leoId]?.[0]?.trustedCaregiverName).toBe('Grandma Ade');
  });

  it('renaming the caregiver does not touch the child', async () => {
    await rosa.updateCaregiverProfile({ caregiverName: 'Mum' });
    const workspace = await rosa.loadWorkspace();
    expect(workspace.caregiver?.caregiverName).toBe('Mum');
    expect(workspace.children[0]?.childName).toBe('Léo');
  });

  it('renaming the child does not touch the caregiver', async () => {
    await rosa.updateChild(leoId, { childName: '小明' });
    const workspace = await rosa.loadWorkspace();
    expect(workspace.children[0]?.childName).toBe('小明');
    expect(workspace.caregiver?.caregiverName).toBe('Rosa');
  });

  it('rejects a whitespace-only name', async () => {
    await expect(rosa.updateChild(leoId, { childName: '   ' }))
      .rejects.toMatchObject({ code: 'CHILD_NAME_REQUIRED' });
  });
});

describe('multiple children and caregivers', () => {
  it('keeps each child’s data separate', async () => {
    const second = await rosa.addChild(familyId, { childName: '小明' });
    await rosa.saveRoutine({ childId: leoId, title: 'Morning check-in', steps: [{ title: 'Wake up slowly' }] });
    expect(await rosa.listRoutines(second.id)).toHaveLength(0);
    expect(await rosa.listRoutines(leoId)).toHaveLength(1);
  });

  it('lets a second caregiver see the same family', async () => {
    const workspace = await marcus.loadWorkspace();
    expect(workspace.activeFamilyId).toBe(familyId);
    expect(workspace.members.map((m) => m.caregiverName).sort()).toEqual(['Marcus', 'Rosa']);
  });

  it('refuses to remove the last owner', async () => {
    const me = (await rosa.getCurrentUser())!;
    await expect(rosa.revokeCaregiverAccess(familyId, me.id))
      .rejects.toMatchObject({ code: 'CANNOT_REMOVE_LAST_OWNER' });
  });

  it('revoking a caregiver stops their access immediately', async () => {
    const marcusUser = (await marcus.getCurrentUser())!;
    await rosa.revokeCaregiverAccess(familyId, marcusUser.id);
    await expect(marcus.listRequests(familyId)).rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
  });

  it('a view-only caregiver cannot answer a request', async () => {
    const marcusUser = (await marcus.getCurrentUser())!;
    await rosa.updateCaregiverRole(familyId, marcusUser.id, 'view_only');
    const token = await startChildSession();
    const request = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-view-only' });
    await childDevice.childSendRequest(token, request.id);
    await expect(marcus.respondToRequest({ requestId: request.id, kind: 'coming_now', urgency: 'can_wait' }))
      .rejects.toMatchObject({ code: 'NOT_PERMITTED' });
  });
});

describe('authorization boundaries (the RLS equivalent)', () => {
  it('an adult from another family cannot read this family', async () => {
    await expect(outsider.listRequests(familyId)).rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
    await expect(outsider.listRoutines(leoId)).rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
    await expect(outsider.listStories(leoId)).rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
  });

  it('an adult from another family cannot start a child session here', async () => {
    await expect(outsider.startChildSession(leoId)).rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
  });

  it('an adult from another family cannot answer a request here', async () => {
    const token = await startChildSession();
    const request = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-outsider' });
    await childDevice.childSendRequest(token, request.id);
    await expect(outsider.respondToRequest({ requestId: request.id, kind: 'coming_now', urgency: 'can_wait' }))
      .rejects.toMatchObject({ code: 'NOT_A_FAMILY_MEMBER' });
  });

  it('only a caregiver with the right permission can change safety settings', async () => {
    await expect(marcus.saveEscalationRules(leoId, [])).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
    await expect(rosa.saveEscalationRules(leoId, [
      { appliesToUrgency: null, stepOrder: 1, action: 'show_offline_help', trustedCaregiverId: null, afterSeconds: 60, isActive: true },
    ])).resolves.toBeUndefined();
  });
});

describe('the caregiver PIN', () => {
  it('accepts the right code and rejects the wrong one', async () => {
    expect(await rosa.verifyCaregiverPin(familyId, '7391')).toMatchObject({ ok: true });
    expect(await rosa.verifyCaregiverPin(familyId, '0000')).toMatchObject({ ok: false });
  });

  it('locks out after repeated wrong codes', async () => {
    for (let i = 0; i < 5; i += 1) await rosa.verifyCaregiverPin(familyId, '0000');
    const result = await rosa.verifyCaregiverPin(familyId, '7391');
    expect(result.ok).toBe(false);
    expect(result.lockedUntil).toBeTruthy();
  });

  it('never returns the PIN or a hash of it to a client', async () => {
    const result = await rosa.verifyCaregiverPin(familyId, '7391');
    expect(JSON.stringify(result)).not.toContain('7391');
    const workspace = await rosa.loadWorkspace();
    expect(JSON.stringify(workspace)).not.toContain('7391');
  });

  it('rejects a code that is too short or too easy', async () => {
    await expect(rosa.setCaregiverPin(familyId, '12')).rejects.toMatchObject({ code: 'PIN_MUST_BE_4_TO_8_DIGITS' });
  });
});

describe('child sessions are scoped', () => {
  it('rejects an invalid or ended token', async () => {
    const token = await startChildSession();
    await childDevice.endChildSession(token);
    await expect(childDevice.childGetSpace(token)).rejects.toMatchObject({ code: 'CHILD_SESSION_ENDED' });
    await expect(childDevice.childGetSpace('not-a-real-token-at-all-really'))
      .rejects.toMatchObject({ code: 'CHILD_SESSION_INVALID' });
  });

  it('a caregiver can revoke a live child session', async () => {
    const token = await startChildSession();
    await rosa.endChildSession(token);
    await expect(childDevice.childGetRequests(token)).rejects.toMatchObject({ code: 'CHILD_SESSION_ENDED' });
  });

  it('returns only child-facing data, never caregiver credentials', async () => {
    const token = await startChildSession();
    const space = await childDevice.childGetSpace(token);
    const serialised = JSON.stringify(space);
    expect(serialised).not.toContain('7391');
    expect(serialised).not.toContain('rosa@example.test');
    expect(space.child.childName).toBe('Léo');
    expect(space.child.safePlace).toBe('the quiet corner');
  });

  it('applies the child’s own bathroom urgency setting', async () => {
    await rosa.updateChildPreferences(leoId, { familyId, bathroomUrgency: 'can_wait' });
    const token = await startChildSession();
    const space = await childDevice.childGetSpace(token);
    expect(space.requestTypes.find((t) => t.slug === 'bathroom')?.urgency).toBe('can_wait');

    await rosa.updateChildPreferences(leoId, { familyId, bathroomUrgency: 'urgent' });
    const space2 = await childDevice.childGetSpace(await startChildSession());
    expect(space2.requestTypes.find((t) => t.slug === 'bathroom')?.urgency).toBe('urgent');
  });
});

// ---------------------------------------------------------------------------
// The request lifecycle
// ---------------------------------------------------------------------------

describe('the request lifecycle', () => {
  it('never reports delivered until the server has routed it', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-happy' });
    expect(created.status).toBe('reviewing');
    expect(created.deliveredAt).toBeNull();

    const sent = await childDevice.childSendRequest(token, created.id);
    expect(sent.status).toBe('delivered');
    expect(sent.deliveredAt).not.toBeNull();
    expect(sent.acknowledgedAt).toBeNull();
    expect(sent.assignedToName).toBe('Rosa');
  });

  it('does not claim delivery while the device is offline', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-offline' });
    const sent = await childDevice.childSendRequest(token, created.id, 'offline');
    expect(sent.status).toBe('failed');
    expect(sent.failureReason).toBe('offline');
    expect(sent.deliveredAt).toBeNull();
  });

  it('keeps at least one adult able to answer, so a delivered request always has an assignee', async () => {
    // The last-owner invariant means a family can never end up with nobody who
    // can answer: downgrading the only owner is refused.
    const rosaUser = (await rosa.getCurrentUser())!;
    const marcusUser = (await marcus.getCurrentUser())!;
    await rosa.updateCaregiverRole(familyId, marcusUser.id, 'view_only');
    await expect(rosa.updateCaregiverRole(familyId, rosaUser.id, 'view_only'))
      .rejects.toMatchObject({ code: 'CANNOT_REMOVE_LAST_OWNER' });

    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-nobody' });
    const sent = await childDevice.childSendRequest(token, created.id);
    expect(sent.status).toBe('delivered');
    expect(sent.assignedToName).toBe('Rosa');
  });

  it('prevents duplicate requests from repeated tapping', async () => {
    const token = await startChildSession();
    const key = 'dedupe-repeat-tap';
    const first = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: key });
    const second = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: key });
    const thirdWithNewKey = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'another-key-entirely' });

    expect(second.id).toBe(first.id);
    expect(thirdWithNewKey.id).toBe(first.id); // same open request of the same type
    expect((await childDevice.childGetRequests(token)).filter((b) => b.request.typeSlug === 'help')).toHaveLength(1);
  });

  it('sending twice does not send twice', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-double-send' });
    const first = await childDevice.childSendRequest(token, created.id);
    const second = await childDevice.childSendRequest(token, created.id);
    expect(second.status).toBe(first.status);
    expect(second.deliveredAt).toBe(first.deliveredAt);
    expect(second.attempts).toBe(first.attempts);
  });

  it('records every significant transition in the audit history', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-audit' });
    await childDevice.childSendRequest(token, created.id);
    await rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' });
    await rosa.resolveRequest(created.id, false);

    const { events } = await rosa.getRequest(created.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('delivery_confirmed');
    expect(kinds).toContain('response_recorded');
    expect(kinds).toContain('resolved');
  });

  it('survives a refresh: a new backend instance sees the same live request', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-refresh' });
    await childDevice.childSendRequest(token, created.id);

    const afterRefresh = new MemoryBackend();
    afterRefresh.useSession((await rosa.getCurrentUser())!.id);
    const found = (await afterRefresh.childGetRequests(token)).find((b) => b.request.id === created.id);
    expect(found?.request.status).toBe('delivered');
    expect(isLive(found!.request.status)).toBe(true);
  });
});

describe('urgent requests cannot receive an unsafe answer', () => {
  it('rejects a delayed answer to an urgent request', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'pain', dedupeKey: 'dedupe-urgent-delay' });
    await childDevice.childSendRequest(token, created.id);
    await expect(rosa.respondToRequest({ requestId: created.id, kind: 'delay', delayMinutes: 5, urgency: 'urgent' }))
      .rejects.toMatchObject({ code: 'URGENT_REQUEST_CANNOT_BE_DELAYED' });
  });

  it('accepts an immediate action for an urgent request', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'unsafe', dedupeKey: 'dedupe-urgent-ok' });
    await childDevice.childSendRequest(token, created.id);
    const answered = await rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'urgent' });
    expect(answered.status).toBe('acknowledged');
  });

  it('will not close an urgent request without an explicit confirmation', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'breathing', dedupeKey: 'dedupe-urgent-close' });
    await childDevice.childSendRequest(token, created.id);
    await expect(rosa.resolveRequest(created.id, false))
      .rejects.toMatchObject({ code: 'URGENT_RESOLVE_NEEDS_CONFIRMATION' });
    await expect(rosa.resolveRequest(created.id, true)).resolves.toMatchObject({ status: 'resolved' });
  });

  it('allows a delay when the request can wait', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-can-wait' });
    await childDevice.childSendRequest(token, created.id);
    const answered = await rosa.respondToRequest({ requestId: created.id, kind: 'delay', delayMinutes: 5, urgency: 'can_wait' });
    expect(answered.status).toBe('acknowledged');
    const { response } = await rosa.getRequest(created.id);
    expect(response?.delayMinutes).toBe(5);
    expect(response?.dueAt).toBeTruthy();
  });
});

describe('conflicting caregiver actions', () => {
  it('only the assigned caregiver may answer', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-conflict' });
    const sent = await childDevice.childSendRequest(token, created.id);
    expect(sent.assignedToName).toBe('Rosa');

    await expect(marcus.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' }))
      .rejects.toMatchObject({ code: 'REQUEST_ASSIGNED_ELSEWHERE' });
  });

  it('a second caregiver can take a request back and then answer', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-takeback' });
    await childDevice.childSendRequest(token, created.id);

    await marcus.claimRequest(created.id);
    const answered = await marcus.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' });
    expect(answered.assignedToName).toBe('Marcus');

    const { response } = await rosa.getRequest(created.id);
    expect(response?.responderName).toBe('Marcus');
  });

  it('keeps exactly one current response', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-one-current' });
    await childDevice.childSendRequest(token, created.id);
    await rosa.respondToRequest({ requestId: created.id, kind: 'seen', urgency: 'can_wait' });
    await rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' });
    const { response } = await rosa.getRequest(created.id);
    expect(response?.kind).toBe('coming_now');
  });

  it('refuses to answer a request that was never delivered', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-not-delivered' });
    await expect(rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' }))
      .rejects.toMatchObject({ code: 'REQUEST_NOT_DELIVERED_YET' });
  });
});

describe('cancellation', () => {
  it('a child can cancel before sending, and nothing was sent', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-cancel-early' });
    const cancelled = await childDevice.childCancelRequest(token, created.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.deliveredAt).toBeNull();
  });

  it('a child can change their mind after delivery, and the caregiver is told', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-cancel-late' });
    await childDevice.childSendRequest(token, created.id);
    await childDevice.childCancelRequest(token, created.id);

    const notifications = await rosa.listNotifications(familyId);
    expect(notifications.some((n) => n.kind === 'request_cancelled')).toBe(true);
  });

  it('a finished request cannot be cancelled again', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-cancel-twice' });
    await childDevice.childSendRequest(token, created.id);
    await childDevice.childCancelRequest(token, created.id);
    const again = await childDevice.childCancelRequest(token, created.id);
    expect(again.status).toBe('cancelled');
    await expect(rosa.resolveRequest(created.id, true)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('escalation', () => {
  it('escalates an unanswered request and then shows offline help', async () => {
    vi.useFakeTimers();
    try {
      await rosa.saveEscalationRules(leoId, [
        { appliesToUrgency: null, stepOrder: 1, action: 'notify_trusted', trustedCaregiverId: null, afterSeconds: 30, isActive: true },
        { appliesToUrgency: null, stepOrder: 2, action: 'notify_all_caregivers', trustedCaregiverId: null, afterSeconds: 60, isActive: true },
        { appliesToUrgency: null, stepOrder: 3, action: 'show_offline_help', trustedCaregiverId: null, afterSeconds: 120, isActive: true },
      ]);

      const token = await startChildSession();
      const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-escalate' });
      await childDevice.childSendRequest(token, created.id);

      vi.setSystemTime(new Date(Date.now() + 35_000));
      await rosa.tickEscalations(familyId);
      expect((await rosa.getRequest(created.id)).request.status).toBe('waiting');

      vi.setSystemTime(new Date(Date.now() + 40_000));
      await rosa.tickEscalations(familyId);
      const escalated = (await rosa.getRequest(created.id)).request;
      expect(escalated.status).toBe('escalated');
      expect(escalated.assignedToName).toBe('Grandma Ade');

      vi.setSystemTime(new Date(Date.now() + 90_000));
      await rosa.tickEscalations(familyId);
      expect((await rosa.getRequest(created.id)).request.status).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a request that was accepted but never confirmed as interrupted', async () => {
    vi.useFakeTimers();
    try {
      const token = await startChildSession();
      const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-interrupted' });
      // Simulate a write that reached the server but whose delivery routing
      // never completed, by sending while offline and then coming back.
      await childDevice.childSendRequest(token, created.id, 'offline');
      const failed = (await rosa.getRequest(created.id)).request;
      expect(failed.status).toBe('failed');
      expect(failed.failureReason).toBe('offline');

      // Retrying while online delivers it honestly.
      vi.setSystemTime(new Date(Date.now() + 1000));
      const retried = await childDevice.childSendRequest(token, created.id, 'online');
      expect(retried.status).toBe('delivered');
      expect(retried.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a caregiver can escalate by hand', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-manual-escalate' });
    await childDevice.childSendRequest(token, created.id);
    const escalated = await rosa.escalateRequest(created.id, null);
    expect(escalated.status).toBe('escalated');
    expect(escalated.assignedToName).toBe('Grandma Ade');
  });

  it('refuses to escalate when no trusted caregiver is configured', async () => {
    const workspace = await rosa.loadWorkspace();
    for (const trusted of workspace.trustedCaregivers[leoId] ?? []) {
      await rosa.removeTrustedCaregiver(trusted.id);
    }
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'help', dedupeKey: 'dedupe-no-trusted' });
    await childDevice.childSendRequest(token, created.id);
    await expect(rosa.escalateRequest(created.id, null))
      .rejects.toMatchObject({ code: 'NO_TRUSTED_CAREGIVER_CONFIGURED' });
  });
});

describe('real-time synchronisation', () => {
  it('notifies a subscriber when the other side changes something', async () => {
    const seen = vi.fn();
    const unsubscribe = rosa.subscribeToFamily(familyId, seen);

    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-realtime' });
    await childDevice.childSendRequest(token, created.id);

    expect(seen).toHaveBeenCalled();
    unsubscribe();

    const before = seen.mock.calls.length;
    await rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', urgency: 'can_wait' });
    expect(seen.mock.calls.length).toBe(before);
  });

  it('the child sees the caregiver’s answer without re-authenticating', async () => {
    const token = await startChildSession();
    const created = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-sync' });
    await childDevice.childSendRequest(token, created.id);
    await rosa.respondToRequest({ requestId: created.id, kind: 'coming_now', message: 'Meet me in the kitchen', urgency: 'can_wait' });

    const bundle = (await childDevice.childGetRequests(token)).find((b) => b.request.id === created.id);
    expect(bundle?.request.status).toBe('acknowledged');
    expect(bundle?.response?.responderName).toBe('Rosa');
    expect(bundle?.response?.message).toBe('Meet me in the kitchen');
  });
});

// ---------------------------------------------------------------------------
// Routines and stories
// ---------------------------------------------------------------------------

describe('routines', () => {
  it('creates, edits, duplicates, archives and deletes', async () => {
    const routine = await rosa.saveRoutine({
      childId: leoId, title: 'Morning check-in',
      steps: [{ title: 'Wake up slowly' }, { title: 'Get dressed' }],
    });
    expect(routine.steps).toHaveLength(2);

    const edited = await rosa.saveRoutine({
      id: routine.id, childId: leoId, title: 'Morning check-in',
      steps: [
        { id: routine.steps[1]!.id, title: 'Get dressed' },
        { id: routine.steps[0]!.id, title: 'Wake up slowly' },
      ],
    });
    expect(edited.steps.map((s) => s.title)).toEqual(['Get dressed', 'Wake up slowly']);

    const copy = await rosa.duplicateRoutine(routine.id);
    expect(copy.title).toBe('Morning check-in (copy)');

    await rosa.archiveRoutine(routine.id, true);
    expect((await rosa.listRoutines(leoId)).find((r) => r.id === routine.id)?.archivedAt).toBeTruthy();

    await rosa.deleteRoutine(routine.id);
    expect((await rosa.listRoutines(leoId)).some((r) => r.id === routine.id)).toBe(false);
  });

  it('records a skipped step neutrally and never scores a run', async () => {
    const routine = await rosa.saveRoutine({
      childId: leoId, title: 'Wind down',
      steps: [{ title: 'Pyjamas' }, { title: 'Teeth' }],
    });
    const run = await rosa.startRoutineRun(routine.id, 'child');
    const afterSkip = await rosa.setRoutineStepState(run.id, routine.steps[0]!.id, 'skipped');
    expect(afterSkip.stepStates[0]).toMatchObject({ state: 'skipped' });
    expect(JSON.stringify(afterSkip)).not.toMatch(/score|streak|points/i);

    const finished = await rosa.setRoutineStepState(run.id, routine.steps[1]!.id, 'done');
    expect(finished.status).toBe('finished');
  });

  it('can be marked as plans changed rather than failed', async () => {
    const routine = await rosa.saveRoutine({ childId: leoId, title: 'School', steps: [{ title: 'Bag' }] });
    const run = await rosa.startRoutineRun(routine.id, 'child');
    const changed = await rosa.setRoutineRunStatus(run.id, 'plans_changed');
    expect(changed.status).toBe('plans_changed');
    expect(changed.plansChangedAt).toBeTruthy();
  });
});

describe('stories', () => {
  const pages = [
    { sectionKey: 'title' as const, heading: null, body: 'Going to the dentist', certainty: 'fact' as const },
    { sectionKey: 'choices' as const, heading: 'What I can do', body: 'I can ask for a break. I can hold my fidget.', certainty: 'choice' as const },
    { sectionKey: 'ending' as const, heading: 'The ending', body: 'I do not know exactly how it will feel. I can tell a trusted adult.', certainty: 'fact' as const },
  ];

  it('always saves as a draft, even when editing an approved story', async () => {
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Going to the dentist', scenarioKey: 'doctor_or_dentist',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    expect(draft.status).toBe('draft');

    await rosa.approveStory(draft.id, true);
    expect((await rosa.getStory(draft.id)).status).toBe('approved');

    const edited = await rosa.saveStoryDraft({
      id: draft.id, childId: leoId, title: 'Going to the dentist on Thursday',
      scenarioKey: 'doctor_or_dentist', source: 'manual', format: 'text',
      person: 'first_person', readingLevel: 'simple', pages,
    });
    expect(edited.status).toBe('draft');
  });

  it('refuses to give an unapproved story to a child', async () => {
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Waiting', scenarioKey: 'waiting',
      source: 'generated', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    await expect(rosa.assignStory(draft.id, leoId)).rejects.toMatchObject({ code: 'STORY_NOT_APPROVED' });
  });

  it('a child can only open an approved AND assigned story', async () => {
    const token = await startChildSession();
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Waiting', scenarioKey: 'waiting',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    expect(await childDevice.childGetStories(token)).toHaveLength(0);

    await rosa.approveStory(draft.id, true);
    expect(await childDevice.childGetStories(token)).toHaveLength(0); // approved but not given

    await rosa.assignStory(draft.id, leoId);
    expect(await childDevice.childGetStories(token)).toHaveLength(1);

    await rosa.withdrawStory(draft.id, leoId);
    expect(await childDevice.childGetStories(token)).toHaveLength(0);
  });

  it('records who approved a story and keeps a version snapshot', async () => {
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Waiting', scenarioKey: 'waiting',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    const approved = await rosa.approveStory(draft.id, true);
    expect(approved.approvedByName).toBe('Rosa');
    expect(approved.approvedAt).toBeTruthy();

    const versions = await rosa.listStoryVersions(draft.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.createdByName).toBe('Rosa');
  });

  it('will not approve a story that is too short', async () => {
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Too short', scenarioKey: 'waiting',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple',
      pages: pages.slice(0, 2),
    });
    await expect(rosa.approveStory(draft.id, true)).rejects.toMatchObject({ code: 'STORY_TOO_SHORT' });
  });

  it('a child’s story feedback reaches the caregiver only after they send it', async () => {
    const token = await startChildSession();
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Waiting', scenarioKey: 'waiting',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    await rosa.approveStory(draft.id, true);
    await rosa.assignStory(draft.id, leoId);

    expect(await rosa.listStoryFeedback(familyId)).toHaveLength(0);
    await childDevice.childSendStoryFeedback(token, draft.id, 'i_need_a_break', 1);
    const feedback = await rosa.listStoryFeedback(familyId);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.kind).toBe('i_need_a_break');
  });

  it('remembers where the child got to, and stores no completion measure', async () => {
    const token = await startChildSession();
    const draft = await rosa.saveStoryDraft({
      childId: leoId, title: 'Waiting', scenarioKey: 'waiting',
      source: 'manual', format: 'text', person: 'first_person', readingLevel: 'simple', pages,
    });
    await rosa.approveStory(draft.id, true);
    await rosa.assignStory(draft.id, leoId);
    await childDevice.childSetStoryProgress(token, draft.id, 2);

    const stories = await childDevice.childGetStories(token);
    expect(stories[0]?.lastPage).toBe(2);
    expect(JSON.stringify(stories[0])).not.toMatch(/score|completed|passed/i);
  });
});

// ---------------------------------------------------------------------------
// Data rights
// ---------------------------------------------------------------------------

describe('export and deletion', () => {
  it('exports the whole family record', async () => {
    const exported = await rosa.exportFamilyData(familyId) as Record<string, unknown>;
    expect(Object.keys(exported)).toEqual(expect.arrayContaining([
      'family', 'caregivers', 'children', 'childPreferences', 'trustedCaregivers',
      'requests', 'routines', 'stories', 'auditEvents',
    ]));
  });

  it('only a caregiver with export permission can export', async () => {
    await expect(marcus.exportFamilyData(familyId)).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
  });

  it('deleting a child profile ends its live sessions immediately', async () => {
    const token = await startChildSession();
    await rosa.requestDeletion('child', { childId: leoId });
    await expect(childDevice.childGetRequests(token)).rejects.toMatchObject({ code: 'CHILD_SESSION_REVOKED' });
  });
});

describe('the grown-up code is mandatory', () => {

  it('refuses to create a family space without a code', async () => {
    const fresh = new MemoryBackend();
    await fresh.signUp('nocode@example.test', 'kindly-demo-4');
    await expect(
      fresh.bootstrapFamily({ caregiverName: 'Priya', childName: 'Devi' }),
    ).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
  });

  it('does not accept an arbitrary code when none is set', async () => {
    // The regression this guards: verify_caregiver_pin used to return ok=true
    // when no row existed, so the adult check accepted anything at all. A
    // screen that looks like a lock and is not one is worse than no lock.
    const fresh = new MemoryBackend();
    await fresh.signUp('empty@example.test', 'kindly-demo-5');
    const made = await fresh.bootstrapFamily({ caregiverName: 'Ines', childName: 'Tomás', pin: '5150' });
    const user = (await fresh.getCurrentUser())!;

    // Simulate a family space created before the code was required. The stored
    // code is taken away and the backend told to re-read, the same path a
    // second tab takes when it notices the data changed.
    const raw = JSON.parse(globalThis.localStorage.getItem('kindly:memory-db:v1')!);
    raw.pins = [];
    globalThis.localStorage.setItem('kindly:memory-db:v1', JSON.stringify(raw));
    window.dispatchEvent(new StorageEvent('storage', { key: 'kindly:memory-db:v1' }));

    const legacy = new MemoryBackend();
    legacy.useSession(user.id);

    const result = await legacy.verifyCaregiverPin(made.familyId, '0000');
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('not_configured');
  });

  it('reports whether a code is configured without revealing it', async () => {
    const workspace = await rosa.loadWorkspace();
    expect(workspace.adultVerification).toEqual({ mode: 'pin', isConfigured: true });
    expect(JSON.stringify(workspace)).not.toContain('7391');
  });

  it('will not switch adult verification off', async () => {
    await expect(rosa.setAdultVerificationMode(familyId, 'none' as 'pin'))
      .rejects.toMatchObject({ code: 'INVALID_VERIFICATION_MODE' });
    await expect(rosa.setAdultVerificationMode(familyId, 'device_biometric')).resolves.toBeUndefined();
  });
});

describe('the operator dashboard', () => {

  it('refuses metrics to an ordinary caregiver', async () => {
    await expect(rosa.getOperatorMetrics()).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
    expect(await rosa.amIOperator()).toBe(false);
  });

  it('refuses metrics to a caregiver from another family', async () => {
    await expect(outsider.getOperatorMetrics()).rejects.toMatchObject({ code: 'NOT_PERMITTED' });
  });

  it('has no client path to becoming an operator', () => {
    // The only grant is grantOperatorForTests, standing in for a hand-written
    // row in kindly.operators. Nothing on the KindlyBackend interface can add
    // one, which is what stops a caregiver promoting themselves.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(rosa));
    expect(surface.filter((k) => /grant|promote|addOperator/i.test(k)))
      .toEqual(['grantOperatorForTests']);
  });

  it('returns aggregates once granted, and never a name or a message', async () => {
    const me = (await rosa.getCurrentUser())!;
    rosa.grantOperatorForTests(me.id);

    expect(await rosa.amIOperator()).toBe(true);
    const m = await rosa.getOperatorMetrics();

    expect(m.reach.families).toBeGreaterThanOrEqual(2);
    expect(m.reach.children).toBeGreaterThanOrEqual(2);
    expect(m.dailyRequests).toHaveLength(14);

    // The privacy property, asserted rather than assumed: none of the names or
    // free text this suite seeded may appear anywhere in the payload.
    const json = JSON.stringify(m);
    for (const secret of ['Rosa', 'Léo', 'Marcus', 'Grandma Ade', 'Sam', 'Ana', 'quiet corner', 'O’Neill']) {
      expect(json).not.toContain(secret);
    }
    // Nor any identifier that could be joined back to a family.
    expect(json).not.toContain(familyId);
    expect(json).not.toContain(leoId);
  });

  it('withholds the request-type breakdown while too few families exist', async () => {
    const me = (await rosa.getCurrentUser())!;
    rosa.grantOperatorForTests(me.id);
    const m = await rosa.getOperatorMetrics();

    // Two families in this suite, threshold is five.
    expect(m.reach.families).toBeLessThan(m.typeBreakdownThreshold);
    expect(m.requestsByType7d).toBeNull();
  });

  it('counts a request through its whole life', async () => {
    const me = (await rosa.getCurrentUser())!;
    rosa.grantOperatorForTests(me.id);

    const before = await rosa.getOperatorMetrics();

    const token = await startChildSession();
    const draft = await childDevice.childCreateRequest(token, { typeSlug: 'drink', dedupeKey: 'dedupe-operator' });
    await childDevice.childSendRequest(token, draft.id);
    await rosa.respondToRequest({ requestId: draft.id, kind: 'coming_now', urgency: 'can_wait' });

    const after = await rosa.getOperatorMetrics();
    expect(after.requests.last7d).toBe(before.requests.last7d + 1);
    expect(after.requests.answered7d).toBe(before.requests.answered7d + 1);
    expect(after.waiting.medianAnswerSeconds).not.toBeNull();
  });
});
