/**
 * MemoryBackend — a deterministic, in-process stand-in for the Supabase backend.
 *
 * WHAT THIS IS
 * ------------
 * This class emulates the *server*: the Postgres tables, the RLS predicates and
 * the SECURITY DEFINER functions defined in supabase/migrations. It is used by
 * the unit/integration suites and by the end-to-end suite so that CI never
 * depends on a live Supabase project, and by the offline demo build.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not the application storing its data locally. The emulated database is
 * serialised into one `localStorage` key so that a page refresh behaves like a
 * real server that kept the row — exactly as a test harness would keep an
 * in-memory Postgres between requests. Application code never reads that key;
 * only this file does, and this file is only bundled when
 * VITE_KINDLY_BACKEND=memory. In the production build the whole module is
 * tree-shaken away and Supabase is the only source of truth.
 *
 * Authorization is enforced here the same way it is enforced in SQL, so a test
 * that passes against this backend is testing real behaviour rather than a
 * permissive mock.
 */
import {
  KindlyError,
  type AppNotification, type AuthUser, type CaregiverProfile, type ChildPreferences,
  type ChildProfile, type ChildSession, type ChildSpace, type CommunicationMethod,
  type EscalationRule, type Family, type FamilyMember, type HelpRequest, type MediaAsset,
  type Permissions, type RequestBundle, type RequestEvent, type RequestResponse,
  type RequestType, type Routine, type RoutineRun, type RoutineStep, type RoutineStepState,
  type SensoryPreference, type Story, type StoryFeedback, type StoryPage, type StoryVersion,
  type TrustedCaregiver, type Urgency,
} from '../types';
import { canTransition, type RequestStatus, type ResponseKind } from '../requests/stateMachine';
import { normalizeName } from '../names';
import { reviewStory } from '../stories/safetyReview';
import type { KindlyBackend, OperatorMetrics, RoutineInput, SignUpResult, StoryDraftInput, Unsubscribe, Workspace } from './types';

const DB_KEY = 'kindly:memory-db:v1';
const SESSION_KEY = 'kindly:memory-session:v1';
const CHANNEL = 'kindly:memory-db';

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;

const nowIso = (): string => new Date().toISOString();
const clean = (v: unknown): string => normalizeName(typeof v === 'string' ? v : '');
const cleanOrNull = (v: unknown): string | null => clean(v) || null;

/** Not real cryptography — a stand-in so no plaintext secret is ever stored. */
function weakHash(value: string, salt = 'kindly'): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${salt}:${value}`;
  for (let i = 0; i < input.length; i += 1) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) * (i + 1), 2246822519) >>> 0;
  }
  return `mh$${h1.toString(36)}${h2.toString(36)}`;
}

interface DbUser { id: string; email: string; passwordHash: string; emailVerifiedAt: string | null; createdAt: string; lastSeenAt: string | null; deletedAt: string | null }
interface DbMember extends Permissions { familyId: string; userId: string; role: FamilyMember['role']; joinedAt: string; revokedAt: string | null }
interface DbInvitation { id: string; familyId: string; invitedEmail: string; invitedName: string | null; role: FamilyMember['role']; tokenHash: string; status: string; expiresAt: string; invitedBy: string }
interface DbPin { familyId: string; pinHash: string | null; mode: 'pin' | 'device_biometric' | 'none'; failedAttempts: number; lockedUntil: string | null }
interface DbChildSession { id: string; familyId: string; childId: string; tokenHash: string; state: 'active' | 'ended' | 'expired' | 'revoked'; startedBy: string; deviceLabel: string | null; allowedActions: string[]; expiresAt: string }
interface DbStoryAssignment { storyId: string; childId: string; familyId: string; assignedBy: string; assignedAt: string; withdrawnAt: string | null }
interface DbStoryProgress { storyId: string; childId: string; lastPage: number }

interface Db {
  users: DbUser[];
  caregivers: (CaregiverProfile & { deletedAt: string | null })[];
  families: (Family & { createdBy: string; createdAt: string; deletedAt: string | null })[];
  members: DbMember[];
  children: (ChildProfile & { deletedAt: string | null })[];
  preferences: ChildPreferences[];
  communicationMethods: CommunicationMethod[];
  sensoryPreferences: SensoryPreference[];
  trusted: TrustedCaregiver[];
  escalationRules: EscalationRule[];
  invitations: DbInvitation[];
  pins: DbPin[];
  operators: string[];
  childSessions: DbChildSession[];
  requestTypes: RequestType[];
  requests: HelpRequest[];
  responses: RequestResponse[];
  events: RequestEvent[];
  routines: (Omit<Routine, 'steps'> & { deletedAt: string | null })[];
  routineSteps: (RoutineStep & { deletedAt: string | null })[];
  routineRuns: RoutineRun[];
  stories: (Omit<Story, 'pages' | 'assignedChildIds'> & { deletedAt: string | null })[];
  storyPages: (StoryPage & { deletedAt: string | null })[];
  storyVersions: StoryVersion[];
  storyAssignments: DbStoryAssignment[];
  storyProgress: DbStoryProgress[];
  storyFeedback: (StoryFeedback & { familyId: string })[];
  notifications: (AppNotification & { userId: string })[];
  media: (MediaAsset & { dataUrl: string; deletedAt: string | null })[];
  audit: { id: number; familyId: string | null; actorUserId: string | null; action: string; entityType: string; entityId: string | null; detail: Record<string, unknown>; occurredAt: string }[];
  eventSeq: number;
  auditSeq: number;
}

const BUILTIN_TYPES: RequestType[] = [
  { slug: 'help', childFacingLabel: 'Help', childFacingDetail: 'Something is tricky', urgency: 'urgent', pictogramKey: 'i-help', pictogramMediaId: null, colorKey: 'coral', sortOrder: 10 },
  { slug: 'pain', childFacingLabel: 'It hurts', childFacingDetail: 'I have pain', urgency: 'urgent', pictogramKey: 'i-hurt', pictogramMediaId: null, colorKey: 'coral', sortOrder: 20 },
  { slug: 'breathing', childFacingLabel: 'Hard to breathe', childFacingDetail: 'Breathing is difficult', urgency: 'urgent', pictogramKey: 'i-breath', pictogramMediaId: null, colorKey: 'coral', sortOrder: 30 },
  { slug: 'unsafe', childFacingLabel: 'I feel unsafe', childFacingDetail: 'Something is scary', urgency: 'urgent', pictogramKey: 'i-shield', pictogramMediaId: null, colorKey: 'coral', sortOrder: 40 },
  { slug: 'bathroom', childFacingLabel: 'Bathroom', childFacingDetail: 'I need to go', urgency: 'urgent', pictogramKey: 'i-bathroom', pictogramMediaId: null, colorKey: 'yellow', sortOrder: 50 },
  { slug: 'drink', childFacingLabel: 'Drink', childFacingDetail: 'I am thirsty', urgency: 'can_wait', pictogramKey: 'i-droplet', pictogramMediaId: null, colorKey: 'blue', sortOrder: 60 },
  { slug: 'break', childFacingLabel: 'Break', childFacingDetail: 'I need quiet', urgency: 'can_wait', pictogramKey: 'i-pause', pictogramMediaId: null, colorKey: 'purple', sortOrder: 70 },
  { slug: 'other', childFacingLabel: 'Something else', childFacingDetail: 'I will show you', urgency: 'can_wait', pictogramKey: 'i-more', pictogramMediaId: null, colorKey: 'blue', sortOrder: 80 },
  { slug: 'feeling', childFacingLabel: 'How I feel', childFacingDetail: 'I want to share this', urgency: 'can_wait', pictogramKey: 'i-heart', pictogramMediaId: null, colorKey: 'purple', sortOrder: 90 },
];

/** Mirrors `k_min_families` in migration 0014. Changing one means changing both. */
const OPERATOR_TYPE_BREAKDOWN_MIN_FAMILIES = 5;

function emptyDb(): Db {
  return {
    users: [], caregivers: [], families: [], members: [], children: [], preferences: [],
    communicationMethods: [], sensoryPreferences: [], trusted: [], escalationRules: [],
    invitations: [], pins: [], operators: [],
    childSessions: [], requestTypes: [...BUILTIN_TYPES], requests: [], responses: [], events: [],
    routines: [], routineSteps: [], routineRuns: [], stories: [], storyPages: [], storyVersions: [],
    storyAssignments: [], storyProgress: [], storyFeedback: [], notifications: [], media: [],
    audit: [], eventSeq: 1, auditSeq: 1,
  };
}

function defaultPreferences(childId: string, familyId: string): ChildPreferences {
  return {
    childId, familyId,
    textScale: 1, highContrast: false, lowStimulation: false,
    symbolSystem: 'kindly_default', pairTextWithSymbols: true,
    soundEnabled: false, vibrationEnabled: false, animationEnabled: false,
    countdownsVisible: false, readAloudEnabled: false, readAloudRate: 1,
    processingTimeSeconds: 10, transitionWarnings: true,
    escalationDelaySeconds: 120, unavailableDelaySeconds: 120,
    bathroomUrgency: 'urgent', allowCustomMessage: true,
    quietHoursStart: null, quietHoursEnd: null, quietHoursAllowUrgent: true,
  };
}

function permissionsForRole(role: FamilyMember['role']): Permissions {
  switch (role) {
    case 'owner':
      return { can_answer_requests: true, can_edit_routines: true, can_edit_stories: true, can_approve_stories: true, can_manage_children: true, can_manage_caregivers: true, can_manage_safety: true, can_export_data: true };
    case 'caregiver':
      return { can_answer_requests: true, can_edit_routines: true, can_edit_stories: true, can_approve_stories: true, can_manage_children: false, can_manage_caregivers: false, can_manage_safety: false, can_export_data: false };
    case 'trusted':
      return { can_answer_requests: true, can_edit_routines: false, can_edit_stories: false, can_approve_stories: false, can_manage_children: false, can_manage_caregivers: false, can_manage_safety: false, can_export_data: false };
    default:
      return { can_answer_requests: false, can_edit_routines: false, can_edit_stories: false, can_approve_stories: false, can_manage_children: false, can_manage_caregivers: false, can_manage_safety: false, can_export_data: false };
  }
}

// ---------------------------------------------------------------------------

/**
 * The emulated database is shared by every MemoryBackend in the same JavaScript
 * realm, exactly as one Postgres instance is shared by every connection. Tests
 * can therefore open two independent sessions (two caregivers, or a caregiver
 * and a child device) against the same data.
 */
let sharedDb: Db | null = null;

/**
 * The change bus, shared the way Supabase Realtime is: a write on one device
 * wakes the subscribers on every other device.
 */
const sharedListeners = new Set<() => void>();

export class MemoryBackend implements KindlyBackend {
  readonly kind = 'memory' as const;

  private currentUserId: string | null = null;
  private authListeners = new Set<(u: AuthUser | null) => void>();
  private readonly changeListeners = sharedListeners;
  private channel: BroadcastChannel | null = null;

  private get db(): Db {
    if (!sharedDb) sharedDb = this.readDb();
    return sharedDb;
  }

  private set db(next: Db) {
    sharedDb = next;
  }

  constructor() {
    if (!sharedDb) sharedDb = this.readDb();
    this.currentUserId = this.readSessionUserId();

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = () => {
        this.db = this.readDb();
        this.changeListeners.forEach((cb) => cb());
      };
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === DB_KEY) {
          this.db = this.readDb();
          this.changeListeners.forEach((cb) => cb());
        }
      });
    }
  }

  // -- emulated persistence -------------------------------------------------

  private readDb(): Db {
    try {
      const raw = globalThis.localStorage?.getItem(DB_KEY);
      if (!raw) return emptyDb();
      return { ...emptyDb(), ...(JSON.parse(raw) as Db) };
    } catch {
      return emptyDb();
    }
  }

  private commit(): void {
    try {
      globalThis.localStorage?.setItem(DB_KEY, JSON.stringify(this.db));
    } catch {
      /* running without storage (SSR / private mode): stay in memory only */
    }
    this.channel?.postMessage({ at: Date.now() });
    this.changeListeners.forEach((cb) => cb());
  }

  // Kept in localStorage, matching how Supabase persists a session: a second
  // tab in the same browser profile is signed in as the same adult.
  private readSessionUserId(): string | null {
    try {
      return globalThis.localStorage?.getItem(SESSION_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private writeSessionUserId(id: string | null): void {
    try {
      if (id) globalThis.localStorage?.setItem(SESSION_KEY, id);
      else globalThis.localStorage?.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
    this.currentUserId = id;
    // Only this instance's listeners are told: a second instance represents a
    // different device and keeps its own signed-in identity.
    const user = id ? this.toAuthUser(this.db.users.find((u) => u.id === id)) : null;
    this.authListeners.forEach((cb) => cb(user));
  }

  /** Test helper: wipes the emulated database. Never called by app code. */
  reset(): void {
    sharedDb = emptyDb();
    sharedListeners.clear();
    this.commit();
    this.writeSessionUserId(null);
  }

  /**
   * Test helper: signs this instance in as a specific user without a password,
   * so a test can hold two independent caregiver sessions at once.
   */
  useSession(userId: string | null): void {
    this.currentUserId = userId;
  }

  // -- authorization helpers (mirror of the SQL predicates) ------------------

  private requireUser(): DbUser {
    const u = this.currentUserId ? this.db.users.find((x) => x.id === this.currentUserId) : null;
    if (!u) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in to continue.');
    return u;
  }

  private memberOf(familyId: string): DbMember {
    const u = this.requireUser();
    const m = this.db.members.find((x) => x.familyId === familyId && x.userId === u.id && !x.revokedAt);
    if (!m) throw new KindlyError('NOT_A_FAMILY_MEMBER', 'You do not have access to this family space.');
    return m;
  }

  private requirePermission(familyId: string, permission: keyof Permissions): DbMember {
    const m = this.memberOf(familyId);
    if (!m[permission]) {
      throw new KindlyError('NOT_PERMITTED', 'Your role does not allow that. Ask a family owner to change your permissions.');
    }
    return m;
  }

  private familyOfChild(childId: string): string {
    const c = this.db.children.find((x) => x.id === childId);
    if (!c) throw new KindlyError('CHILD_NOT_FOUND', 'That child profile could not be found.');
    return c.familyId;
  }

  private caregiverNameOf(userId: string | null | undefined): string | null {
    if (!userId) return null;
    return this.db.caregivers.find((c) => c.userId === userId && !c.deletedAt)?.caregiverName ?? null;
  }

  private toAuthUser(u: DbUser | undefined | null): AuthUser | null {
    if (!u || u.deletedAt) return null;
    return { id: u.id, email: u.email, emailVerified: Boolean(u.emailVerifiedAt) };
  }

  private audit(familyId: string | null, action: string, entityType: string, entityId: string | null, detail: Record<string, unknown> = {}): void {
    this.db.audit.push({
      id: this.db.auditSeq++, familyId, actorUserId: this.currentUserId,
      action, entityType, entityId, detail, occurredAt: nowIso(),
    });
  }

  private recordEvent(
    request: HelpRequest, kind: string, from: RequestStatus | null, to: RequestStatus | null,
    actorKind: 'child' | 'caregiver' | 'system', actorName: string | null, detail: Record<string, unknown> = {},
  ): void {
    this.db.events.push({
      id: this.db.eventSeq++, requestId: request.id, kind, fromStatus: from, toStatus: to,
      actorKind, actorName, detail, occurredAt: nowIso(),
    });
  }

  private eligibleResponders(familyId: string): { userId: string; caregiverName: string; joinedAt: string }[] {
    return this.db.members
      .filter((m) => m.familyId === familyId && !m.revokedAt && m.can_answer_requests)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.userId.localeCompare(b.userId))
      .map((m) => ({ userId: m.userId, caregiverName: this.caregiverNameOf(m.userId) ?? 'A caregiver', joinedAt: m.joinedAt }));
    }

  private notify(familyId: string, userIds: string[], n: Omit<AppNotification, 'id' | 'familyId' | 'readAt' | 'createdAt'>): void {
    for (const userId of userIds) {
      this.db.notifications.push({
        ...n, id: uid(), familyId, userId, readAt: null, createdAt: nowIso(),
      });
    }
  }

  // -- authentication -------------------------------------------------------

  async getCurrentUser(): Promise<AuthUser | null> {
    return this.toAuthUser(this.db.users.find((u) => u.id === this.currentUserId));
  }

  onAuthStateChange(cb: (user: AuthUser | null) => void): Unsubscribe {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const normalized = email.trim().toLowerCase();
    if (this.db.users.some((u) => u.email === normalized)) {
      throw new KindlyError('EMAIL_ALREADY_REGISTERED', 'An account already exists for that email address. Try signing in instead.');
    }
    const user: DbUser = {
      id: uid(), email: normalized, passwordHash: weakHash(password),
      // The emulated project has email confirmation switched off so the tests
      // exercise the signed-in path; the verification banner is still driven by
      // this flag and can be flipped by MemoryBackend.setEmailVerified().
      emailVerifiedAt: nowIso(), createdAt: nowIso(), lastSeenAt: nowIso(), deletedAt: null,
    };
    this.db.users.push(user);
    this.commit();
    this.writeSessionUserId(user.id);
    return { needsEmailVerification: false, user: this.toAuthUser(user) };
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const normalized = email.trim().toLowerCase();
    const user = this.db.users.find((u) => u.email === normalized && !u.deletedAt);
    if (!user || user.passwordHash !== weakHash(password)) {
      // Deliberately identical message for both cases: no account enumeration.
      throw new KindlyError('INVALID_CREDENTIALS', 'That email address and password do not match. Please try again.');
    }
    this.writeSessionUserId(user.id);
    return this.toAuthUser(user)!;
  }

  async signOut(): Promise<void> {
    this.writeSessionUserId(null);
  }

  async sendPasswordReset(email: string): Promise<void> {
    // Always succeeds so the response cannot be used to discover accounts.
    void email;
  }

  async updatePassword(newPassword: string): Promise<void> {
    const u = this.requireUser();
    u.passwordHash = weakHash(newPassword);
    this.commit();
  }

  async resendVerificationEmail(email: string): Promise<void> {
    void email;
  }

  /** Test helper. */
  setEmailVerified(userId: string, verified: boolean): void {
    const u = this.db.users.find((x) => x.id === userId);
    if (u) u.emailVerifiedAt = verified ? nowIso() : null;
    this.commit();
  }

  // -- workspace ------------------------------------------------------------

  async loadWorkspace(activeFamilyId?: string | null): Promise<Workspace> {
    const user = this.requireUser();
    const caregiver = this.db.caregivers.find((c) => c.userId === user.id && !c.deletedAt) ?? null;
    const memberships = this.db.members.filter((m) => m.userId === user.id && !m.revokedAt);
    const families = this.db.families.filter((f) => !f.deletedAt && memberships.some((m) => m.familyId === f.id));

    const familyId = activeFamilyId && families.some((f) => f.id === activeFamilyId)
      ? activeFamilyId
      : families[0]?.id ?? null;

    const children = familyId
      ? this.db.children.filter((c) => c.familyId === familyId && !c.deletedAt)
      : [];

    const members: FamilyMember[] = familyId
      ? this.db.members
          .filter((m) => m.familyId === familyId)
          .map((m) => ({
            userId: m.userId, familyId: m.familyId, role: m.role,
            permissions: { can_answer_requests: m.can_answer_requests, can_edit_routines: m.can_edit_routines, can_edit_stories: m.can_edit_stories, can_approve_stories: m.can_approve_stories, can_manage_children: m.can_manage_children, can_manage_caregivers: m.can_manage_caregivers, can_manage_safety: m.can_manage_safety, can_export_data: m.can_export_data },
            caregiverName: this.caregiverNameOf(m.userId) ?? '',
            email: this.db.users.find((u) => u.id === m.userId)?.email ?? null,
            joinedAt: m.joinedAt, revokedAt: m.revokedAt, isSelf: m.userId === user.id,
          }))
      : [];

    const byChild = <T extends { childId: string }>(rows: T[]): Record<string, T[]> => {
      const out: Record<string, T[]> = {};
      for (const c of children) out[c.id] = rows.filter((r) => r.childId === c.id);
      return out;
    };

    const preferences: Record<string, ChildPreferences> = {};
    for (const c of children) {
      preferences[c.id] = this.db.preferences.find((p) => p.childId === c.id) ?? defaultPreferences(c.id, c.familyId);
    }

    const pin = familyId ? this.db.pins.find((p) => p.familyId === familyId) : undefined;

    const pendingInvitations = this.db.invitations
      .filter((i) => i.status === 'pending' && i.invitedEmail === user.email && new Date(i.expiresAt) > new Date())
      .map((i) => ({
        id: i.id,
        familyName: this.db.families.find((f) => f.id === i.familyId)?.familyName ?? 'A family space',
        role: i.role, invitedEmail: i.invitedEmail,
      }));

    return {
      user: this.toAuthUser(user)!,
      caregiver,
      families: families.map((f) => ({ id: f.id, familyName: f.familyName, emergencyInstructions: f.emergencyInstructions, emergencyServicesNote: f.emergencyServicesNote })),
      activeFamilyId: familyId,
      members,
      children,
      preferences,
      communicationMethods: byChild(this.db.communicationMethods),
      sensoryPreferences: byChild(this.db.sensoryPreferences),
      trustedCaregivers: byChild(this.db.trusted),
      escalationRules: byChild(this.escalationRulesTable),
      requestTypes: this.db.requestTypes.slice().sort((a, b) => a.sortOrder - b.sortOrder),
      adultVerification: { mode: pin?.mode ?? 'pin', isConfigured: Boolean(pin?.pinHash) },
      pendingInvitations,
    };
  }

  /** Tolerates an emulated database saved before this table existed. */
  private get escalationRulesTable(): EscalationRule[] {
    if (!Array.isArray(this.db.escalationRules)) this.db.escalationRules = [];
    return this.db.escalationRules;
  }

  async bootstrapFamily(input: {
    caregiverName: string; childName: string; familyName?: string | null;
    trustedCaregiverName?: string | null; pin?: string | null;
  }): Promise<{ familyId: string; childId: string }> {
    const user = this.requireUser();
    const caregiverName = clean(input.caregiverName);
    const childName = clean(input.childName);
    if (!caregiverName) throw new KindlyError('CAREGIVER_NAME_REQUIRED', 'Please enter a name for yourself.');
    if (!childName) throw new KindlyError('CHILD_NAME_REQUIRED', 'Please enter your child’s name.');

    let caregiver = this.db.caregivers.find((c) => c.userId === user.id);
    if (caregiver) {
      caregiver.caregiverName = caregiverName;
      caregiver.onboardingStage = 'preferences';
    } else {
      caregiver = {
        id: uid(), userId: user.id, caregiverName, pronouns: null, relationshipLabel: null,
        onboardingStage: 'preferences', onboardingData: {}, deletedAt: null,
      };
      this.db.caregivers.push(caregiver);
    }

    const familyId = uid();
    this.db.families.push({
      id: familyId,
      familyName: clean(input.familyName) || `${caregiverName} + ${childName}`,
      createdBy: user.id,
      createdAt: nowIso(),
      emergencyInstructions: null,
      emergencyServicesNote: 'KINDLY is not an emergency service. In an emergency call your local emergency number.',
      deletedAt: null,
    });

    this.db.members.push({ familyId, userId: user.id, role: 'owner', joinedAt: nowIso(), revokedAt: null, ...permissionsForRole('owner') });

    const childId = uid();
    this.db.children.push({
      id: childId, familyId, childName, pronouns: null, safeAdult: null, safePlace: null,
      emergencyInstructions: null, archivedAt: null, deletedAt: null,
    });
    this.db.preferences.push(defaultPreferences(childId, familyId));

    const trustedName = clean(input.trustedCaregiverName);
    if (trustedName) {
      this.db.trusted.push({
        id: uid(), familyId, childId, userId: null, trustedCaregiverName: trustedName,
        relationshipLabel: null, escalationOrder: 1, isActive: true,
      });
    }

    this.escalationRulesTable.push(
      { id: uid(), childId, appliesToUrgency: null, stepOrder: 1, action: 'notify_trusted', trustedCaregiverId: null, afterSeconds: 120, isActive: true },
      { id: uid(), childId, appliesToUrgency: null, stepOrder: 2, action: 'notify_all_caregivers', trustedCaregiverId: null, afterSeconds: 240, isActive: true },
      { id: uid(), childId, appliesToUrgency: null, stepOrder: 3, action: 'show_offline_help', trustedCaregiverId: null, afterSeconds: 360, isActive: true },
    );

    // The grown-up code is required: without it the adult check has nothing to
    // check against, and the caregiver view would be open to anyone.
    if (!input.pin) throw new KindlyError('PIN_REQUIRED', 'Please choose a grown-up code.');
    this.db.pins.push({ familyId, pinHash: weakHash(input.pin, familyId), mode: 'pin', failedAttempts: 0, lockedUntil: null });

    this.audit(familyId, 'family.bootstrap', 'family', familyId, { childId });
    this.commit();
    return { familyId, childId };
  }

  async saveOnboardingDraft(stage: CaregiverProfile['onboardingStage'], data: Record<string, unknown>): Promise<void> {
    const user = this.requireUser();
    let caregiver = this.db.caregivers.find((c) => c.userId === user.id);
    if (!caregiver) {
      caregiver = { id: uid(), userId: user.id, caregiverName: '', pronouns: null, relationshipLabel: null, onboardingStage: stage, onboardingData: {}, deletedAt: null };
      this.db.caregivers.push(caregiver);
    }
    caregiver.onboardingStage = stage;
    caregiver.onboardingData = { ...caregiver.onboardingData, ...data };
    this.commit();
  }

  async updateCaregiverProfile(input: { caregiverName: string; pronouns?: string | null; relationshipLabel?: string | null }): Promise<void> {
    const user = this.requireUser();
    const name = clean(input.caregiverName);
    if (!name) throw new KindlyError('CAREGIVER_NAME_REQUIRED', 'Please enter a name for yourself.');

    // An invited caregiver has an account before they have a profile, so this
    // creates one on first save rather than failing.
    let caregiver = this.db.caregivers.find((c) => c.userId === user.id);
    if (!caregiver) {
      caregiver = {
        id: uid(), userId: user.id, caregiverName: name, pronouns: null,
        relationshipLabel: null, onboardingStage: 'complete', onboardingData: {}, deletedAt: null,
      };
      this.db.caregivers.push(caregiver);
    }
    caregiver.caregiverName = name;
    caregiver.pronouns = cleanOrNull(input.pronouns);
    caregiver.relationshipLabel = cleanOrNull(input.relationshipLabel);
    this.commit();
  }

  // -- children -------------------------------------------------------------

  async addChild(familyId: string, input: { childName: string; pronouns?: string | null }): Promise<ChildProfile> {
    this.requirePermission(familyId, 'can_manage_children');
    const childName = clean(input.childName);
    if (!childName) throw new KindlyError('CHILD_NAME_REQUIRED', 'Please enter your child’s name.');
    const child = {
      id: uid(), familyId, childName, pronouns: cleanOrNull(input.pronouns),
      safeAdult: null, safePlace: null, emergencyInstructions: null,
      archivedAt: null, deletedAt: null,
    };
    this.db.children.push(child);
    this.db.preferences.push(defaultPreferences(child.id, familyId));
    this.escalationRulesTable.push(
      { id: uid(), childId: child.id, appliesToUrgency: null, stepOrder: 1, action: 'notify_trusted', trustedCaregiverId: null, afterSeconds: 120, isActive: true },
      { id: uid(), childId: child.id, appliesToUrgency: null, stepOrder: 2, action: 'show_offline_help', trustedCaregiverId: null, afterSeconds: 300, isActive: true },
    );
    this.audit(familyId, 'child.created', 'child_profile', child.id, {});
    this.commit();
    return child;
  }

  async updateChild(childId: string, input: Partial<Pick<ChildProfile, 'childName' | 'pronouns' | 'safeAdult' | 'safePlace' | 'emergencyInstructions'>>): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.requirePermission(familyId, 'can_manage_children');
    const child = this.db.children.find((c) => c.id === childId)!;
    if (input.childName !== undefined) {
      const name = clean(input.childName);
      if (!name) throw new KindlyError('CHILD_NAME_REQUIRED', 'Please enter your child’s name.');
      child.childName = name;
    }
    if (input.pronouns !== undefined) child.pronouns = cleanOrNull(input.pronouns);
    if (input.safeAdult !== undefined) child.safeAdult = cleanOrNull(input.safeAdult);
    if (input.safePlace !== undefined) child.safePlace = cleanOrNull(input.safePlace);
    if (input.emergencyInstructions !== undefined) child.emergencyInstructions = cleanOrNull(input.emergencyInstructions);
    this.audit(familyId, 'child.updated', 'child_profile', childId, {});
    this.commit();
  }

  async archiveChild(childId: string, archived: boolean): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.requirePermission(familyId, 'can_manage_children');
    const child = this.db.children.find((c) => c.id === childId)!;
    child.archivedAt = archived ? nowIso() : null;
    this.commit();
  }

  async updateChildPreferences(childId: string, prefs: Partial<ChildPreferences>): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.memberOf(familyId);
    let row = this.db.preferences.find((p) => p.childId === childId);
    if (!row) {
      row = defaultPreferences(childId, familyId);
      this.db.preferences.push(row);
    }
    Object.assign(row, prefs, { childId, familyId, quietHoursAllowUrgent: true });
    this.audit(familyId, 'child.preferences_updated', 'child_preferences', childId, {});
    this.commit();
  }

  async setCommunicationMethods(childId: string, methods: Omit<CommunicationMethod, 'id' | 'childId'>[]): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.memberOf(familyId);
    this.db.communicationMethods = this.db.communicationMethods.filter((m) => m.childId !== childId);
    methods.forEach((m, i) => this.db.communicationMethods.push({ ...m, id: uid(), childId, sortOrder: i }));
    this.commit();
  }

  async setSensoryPreferences(childId: string, items: Omit<SensoryPreference, 'id' | 'childId'>[]): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.memberOf(familyId);
    this.db.sensoryPreferences = this.db.sensoryPreferences.filter((s) => s.childId !== childId);
    items.forEach((s, i) => this.db.sensoryPreferences.push({ ...s, id: uid(), childId, sortOrder: i }));
    this.commit();
  }

  async saveEscalationRules(childId: string, rules: Omit<EscalationRule, 'id' | 'childId'>[]): Promise<void> {
    const familyId = this.familyOfChild(childId);
    this.requirePermission(familyId, 'can_manage_safety');
    const kept = this.escalationRulesTable.filter((r) => r.childId !== childId);
    kept.push(...rules.map((r) => ({ ...r, id: uid(), childId })));
    this.db.escalationRules = kept;
    this.audit(familyId, 'safety.escalation_updated', 'child_profile', childId, { count: rules.length });
    this.commit();
  }

  // -- caregivers -----------------------------------------------------------

  async upsertTrustedCaregiver(input: Omit<TrustedCaregiver, 'id' | 'familyId'> & { id?: string }): Promise<void> {
    const familyId = this.familyOfChild(input.childId);
    this.requirePermission(familyId, 'can_manage_caregivers');
    const name = clean(input.trustedCaregiverName);
    if (!name) throw new KindlyError('TRUSTED_NAME_REQUIRED', 'Please enter this person’s name.');

    const existing = input.id ? this.db.trusted.find((t) => t.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, { ...input, trustedCaregiverName: name, familyId });
    } else {
      this.db.trusted.push({ ...input, id: uid(), familyId, trustedCaregiverName: name });
    }
    this.audit(familyId, 'caregiver.trusted_saved', 'trusted_caregiver', existing?.id ?? null, {});
    this.commit();
  }

  async removeTrustedCaregiver(id: string): Promise<void> {
    const row = this.db.trusted.find((t) => t.id === id);
    if (!row) return;
    this.requirePermission(row.familyId, 'can_manage_caregivers');
    this.db.trusted = this.db.trusted.filter((t) => t.id !== id);
    this.audit(row.familyId, 'caregiver.trusted_removed', 'trusted_caregiver', id, {});
    this.commit();
  }

  async inviteCaregiver(familyId: string, input: { email: string; role: 'caregiver' | 'trusted' | 'view_only'; invitedName?: string | null; message?: string | null }): Promise<{ invitationId: string; token: string }> {
    this.requirePermission(familyId, 'can_manage_caregivers');
    const token = uid() + uid();
    const invitation: DbInvitation = {
      id: uid(), familyId, invitedEmail: input.email.trim().toLowerCase(),
      invitedName: cleanOrNull(input.invitedName), role: input.role,
      tokenHash: weakHash(token), status: 'pending',
      expiresAt: new Date(Date.now() + 14 * 864e5).toISOString(),
      invitedBy: this.requireUser().id,
    };
    this.db.invitations.push(invitation);
    this.audit(familyId, 'caregiver.invited', 'invitation', invitation.id, { role: input.role });
    this.commit();
    return { invitationId: invitation.id, token };
  }

  async listInvitations(familyId: string): Promise<{ id: string; invitedEmail: string; role: string; status: string; expiresAt: string }[]> {
    this.memberOf(familyId);
    return this.db.invitations
      .filter((i) => i.familyId === familyId)
      .map((i) => ({ id: i.id, invitedEmail: i.invitedEmail, role: i.role, status: i.status, expiresAt: i.expiresAt }));
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    const inv = this.db.invitations.find((i) => i.id === invitationId);
    if (!inv) return;
    this.requirePermission(inv.familyId, 'can_manage_caregivers');
    inv.status = 'revoked';
    this.audit(inv.familyId, 'caregiver.invitation_revoked', 'invitation', invitationId, {});
    this.commit();
  }

  async acceptInvitation(token: string): Promise<{ familyId: string }> {
    const user = this.requireUser();
    const inv = this.db.invitations.find((i) => i.tokenHash === weakHash(token));
    if (!inv) throw new KindlyError('INVITATION_NOT_FOUND', 'That invitation link is not valid.');
    if (inv.status !== 'pending') throw new KindlyError('INVITATION_USED', 'That invitation has already been used or withdrawn.');
    if (new Date(inv.expiresAt) <= new Date()) {
      inv.status = 'expired';
      this.commit();
      throw new KindlyError('INVITATION_EXPIRED', 'That invitation has expired. Ask for a new one.');
    }
    if (inv.invitedEmail !== user.email) {
      throw new KindlyError('INVITATION_EMAIL_MISMATCH', 'This invitation was sent to a different email address.');
    }

    const existing = this.db.members.find((m) => m.familyId === inv.familyId && m.userId === user.id);
    if (existing) {
      existing.revokedAt = null;
      existing.role = inv.role;
      Object.assign(existing, permissionsForRole(inv.role));
    } else {
      this.db.members.push({ familyId: inv.familyId, userId: user.id, role: inv.role, joinedAt: nowIso(), revokedAt: null, ...permissionsForRole(inv.role) });
    }
    inv.status = 'accepted';

    const others = this.db.members.filter((m) => m.familyId === inv.familyId && !m.revokedAt && m.userId !== user.id).map((m) => m.userId);
    this.notify(inv.familyId, others, {
      kind: 'invitation_accepted',
      title: 'A caregiver joined your family space',
      body: `${this.caregiverNameOf(user.id) ?? 'A new caregiver'} can now help.`,
      requestId: null, storyId: null, childId: null, route: '/app/settings/caregivers', isUrgent: false,
    });
    this.audit(inv.familyId, 'caregiver.joined', 'family_member', null, { role: inv.role });
    this.commit();
    return { familyId: inv.familyId };
  }

  async revokeCaregiverAccess(familyId: string, userId: string): Promise<void> {
    this.requirePermission(familyId, 'can_manage_caregivers');
    const owners = this.db.members.filter((m) => m.familyId === familyId && m.role === 'owner' && !m.revokedAt && m.userId !== userId);
    if (owners.length === 0) {
      throw new KindlyError('CANNOT_REMOVE_LAST_OWNER', 'A family space must always have at least one owner.');
    }
    const member = this.db.members.find((m) => m.familyId === familyId && m.userId === userId && !m.revokedAt);
    if (!member) return;
    member.revokedAt = nowIso();

    for (const r of this.db.requests) {
      if (r.familyId === familyId && r.assignedToUserId === userId && !['resolved', 'cancelled'].includes(r.status)) {
        r.assignedToUserId = null;
        r.assignedToName = null;
        r.lockVersion += 1;
      }
    }
    this.notify(familyId, [userId], {
      kind: 'caregiver_removed', title: 'Your access to this family space ended',
      body: 'You can no longer see or answer requests for this family.',
      requestId: null, storyId: null, childId: null, route: '/app', isUrgent: false,
    });
    this.audit(familyId, 'caregiver.revoked', 'family_member', null, { removedUser: userId });
    this.commit();
  }

  async updateCaregiverRole(familyId: string, userId: string, role: FamilyMember['role']): Promise<void> {
    this.requirePermission(familyId, 'can_manage_caregivers');
    const member = this.db.members.find((m) => m.familyId === familyId && m.userId === userId && !m.revokedAt);
    if (!member) throw new KindlyError('MEMBER_NOT_FOUND', 'That caregiver is not part of this family space.');
    if (member.role === 'owner' && role !== 'owner') {
      const otherOwners = this.db.members.filter((m) => m.familyId === familyId && m.role === 'owner' && !m.revokedAt && m.userId !== userId);
      if (otherOwners.length === 0) throw new KindlyError('CANNOT_REMOVE_LAST_OWNER', 'A family space must always have at least one owner.');
    }
    member.role = role;
    Object.assign(member, permissionsForRole(role));
    this.audit(familyId, 'caregiver.role_changed', 'family_member', null, { userId, role });
    this.commit();
  }

  // -- adult verification ---------------------------------------------------

  async setCaregiverPin(familyId: string, pin: string): Promise<void> {
    this.memberOf(familyId);
    if (!/^\d{4,8}$/.test(pin)) throw new KindlyError('PIN_MUST_BE_4_TO_8_DIGITS', 'Please use between 4 and 8 digits.');
    let row = this.db.pins.find((p) => p.familyId === familyId);
    if (!row) {
      row = { familyId, pinHash: null, mode: 'pin', failedAttempts: 0, lockedUntil: null };
      this.db.pins.push(row);
    }
    row.pinHash = weakHash(pin, familyId);
    row.mode = 'pin';
    row.failedAttempts = 0;
    row.lockedUntil = null;
    this.audit(familyId, 'security.pin_set', 'family', familyId, {});
    this.commit();
  }

  async verifyCaregiverPin(familyId: string, pin: string): Promise<{ ok: boolean; lockedUntil?: string; attemptsRemaining?: number; mode: string }> {
    this.memberOf(familyId);
    const row = this.db.pins.find((p) => p.familyId === familyId);
    // No code configured. Returning ok:true here would make the adult check
    // accept anything, which is worse than refusing.
    if (!row || !row.pinHash) return { ok: false, mode: 'not_configured' };

    if (row.lockedUntil && new Date(row.lockedUntil) > new Date()) {
      return { ok: false, lockedUntil: row.lockedUntil, mode: row.mode };
    }
    const ok = row.pinHash === weakHash(pin, familyId);
    if (ok) {
      row.failedAttempts = 0;
      row.lockedUntil = null;
    } else {
      row.failedAttempts += 1;
      if (row.failedAttempts >= 5) row.lockedUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      this.audit(familyId, 'security.pin_failed', 'family', familyId, { attempt: row.failedAttempts });
    }
    this.commit();
    return { ok, mode: row.mode, attemptsRemaining: Math.max(0, 5 - row.failedAttempts) };
  }

  async setAdultVerificationMode(familyId: string, mode: 'pin' | 'device_biometric' | 'none'): Promise<void> {
    this.requirePermission(familyId, 'can_manage_safety');
    if (mode === 'none') {
      throw new KindlyError('INVALID_VERIFICATION_MODE', 'The grown-up code cannot be switched off.');
    }
    let row = this.db.pins.find((p) => p.familyId === familyId);
    if (!row) {
      row = { familyId, pinHash: null, mode, failedAttempts: 0, lockedUntil: null };
      this.db.pins.push(row);
    }
    row.mode = mode;
    this.audit(familyId, 'security.verification_mode', 'family', familyId, { mode });
    this.commit();
  }

  // -- requests (caregiver side) -------------------------------------------

  private bundle(request: HelpRequest): RequestBundle {
    return {
      request,
      response: this.db.responses.find((r) => r.requestId === request.id && r.isCurrent) ?? null,
      events: this.db.events.filter((e) => e.requestId === request.id).sort((a, b) => a.id - b.id),
    };
  }

  async listRequests(familyId: string): Promise<RequestBundle[]> {
    this.memberOf(familyId);
    return this.db.requests
      .filter((r) => r.familyId === familyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.bundle(r));
  }

  async getRequest(requestId: string): Promise<RequestBundle> {
    const request = this.db.requests.find((r) => r.id === requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.memberOf(request.familyId);
    return this.bundle(request);
  }

  async respondToRequest(input: { requestId: string; kind: ResponseKind; delayMinutes?: number | null; message?: string | null; urgency: Urgency }): Promise<HelpRequest> {
    const user = this.requireUser();
    const request = this.db.requests.find((r) => r.id === input.requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.requirePermission(request.familyId, 'can_answer_requests');

    if (request.status === 'resolved' || request.status === 'cancelled') {
      throw new KindlyError('REQUEST_ALREADY_CLOSED', 'This request is already finished.');
    }
    if (!request.deliveredAt) {
      throw new KindlyError('REQUEST_NOT_DELIVERED_YET', 'This request has not been delivered yet.');
    }
    if (request.assignedToUserId && request.assignedToUserId !== user.id) {
      throw new KindlyError(
        'REQUEST_ASSIGNED_ELSEWHERE',
        `${request.assignedToName ?? 'Another caregiver'} is answering this request. Take it back first so your child does not get two different answers.`,
        { detail: request.assignedToName ?? undefined },
      );
    }
    if (request.urgency === 'urgent' && input.kind === 'delay') {
      throw new KindlyError('URGENT_REQUEST_CANNOT_BE_DELAYED', 'An urgent request cannot be answered with a delay. Choose an action that happens now.');
    }

    const myName = this.caregiverNameOf(user.id) ?? 'A caregiver';
    let responderName = myName;
    let trusted: TrustedCaregiver | undefined;

    if (input.kind === 'other_caregiver') {
      trusted = this.db.trusted
        .filter((t) => t.childId === request.childId && t.isActive)
        .sort((a, b) => a.escalationOrder - b.escalationOrder)[0];
      if (!trusted) throw new KindlyError('NO_TRUSTED_CAREGIVER_CONFIGURED', 'No trusted caregiver has been added for this child yet.');
      responderName = trusted.trustedCaregiverName;
    }

    if (input.kind === 'delay' && (input.delayMinutes == null || input.delayMinutes < 1 || input.delayMinutes > 120)) {
      throw new KindlyError('DELAY_MINUTES_OUT_OF_RANGE', 'Please choose between 1 and 120 minutes.');
    }

    for (const r of this.db.responses) if (r.requestId === request.id) r.isCurrent = false;

    const at = nowIso();
    this.db.responses.push({
      id: uid(), requestId: request.id, kind: input.kind,
      delayMinutes: input.kind === 'delay' ? input.delayMinutes! : null,
      dueAt: input.kind === 'delay' ? new Date(Date.now() + input.delayMinutes! * 60_000).toISOString() : null,
      message: cleanOrNull(input.message),
      responderUserId: user.id, responderTrustedId: trusted?.id ?? null,
      responderName, isCurrent: true, createdAt: at,
    });

    const from = request.status;
    request.status = 'acknowledged';
    request.acknowledgedAt = request.acknowledgedAt ?? at;
    request.assignedToUserId = input.kind === 'other_caregiver' ? (trusted?.userId ?? null) : user.id;
    request.assignedToTrustedId = input.kind === 'other_caregiver' ? (trusted?.id ?? null) : request.assignedToTrustedId;
    request.assignedToName = responderName;
    request.lockVersion += 1;
    request.updatedAt = at;

    this.recordEvent(request, 'response_recorded', from, 'acknowledged', 'caregiver', myName, {
      kind: input.kind, delayMinutes: input.delayMinutes ?? null, responderName,
    });
    if (input.kind === 'other_caregiver') {
      this.recordEvent(request, 'assigned', 'acknowledged', 'acknowledged', 'caregiver', myName, {
        to: responderName, reason: `Reassigned by ${myName}`,
      });
    }
    this.commit();
    return request;
  }

  async claimRequest(requestId: string): Promise<HelpRequest> {
    const user = this.requireUser();
    const request = this.db.requests.find((r) => r.id === requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.requirePermission(request.familyId, 'can_answer_requests');
    if (request.status === 'resolved' || request.status === 'cancelled') {
      throw new KindlyError('REQUEST_ALREADY_CLOSED', 'This request is already finished.');
    }
    const myName = this.caregiverNameOf(user.id) ?? 'A caregiver';
    request.assignedToUserId = user.id;
    request.assignedToTrustedId = null;
    request.assignedToName = myName;
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'assigned', request.status, request.status, 'caregiver', myName, { to: myName, reason: 'Taken back' });
    this.commit();
    return request;
  }

  async escalateRequest(requestId: string, trustedCaregiverId?: string | null): Promise<HelpRequest> {
    const user = this.requireUser();
    const request = this.db.requests.find((r) => r.id === requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.requirePermission(request.familyId, 'can_answer_requests');
    if (!canTransition(request.status, 'escalated')) {
      throw new KindlyError('INVALID_TRANSITION', 'This request cannot be passed on right now.');
    }
    const trusted = trustedCaregiverId
      ? this.db.trusted.find((t) => t.id === trustedCaregiverId && t.childId === request.childId)
      : this.db.trusted.filter((t) => t.childId === request.childId && t.isActive).sort((a, b) => a.escalationOrder - b.escalationOrder)[0];
    if (!trusted) throw new KindlyError('NO_TRUSTED_CAREGIVER_CONFIGURED', 'No trusted caregiver has been added for this child yet.');

    const myName = this.caregiverNameOf(user.id) ?? 'A caregiver';
    const from = request.status;
    request.status = 'escalated';
    request.escalatedAt = nowIso();
    request.assignedToUserId = trusted.userId;
    request.assignedToTrustedId = trusted.id;
    request.assignedToName = trusted.trustedCaregiverName;
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'escalated', from, 'escalated', 'caregiver', myName, {
      to: trusted.trustedCaregiverName, reason: `Escalated by ${myName}`,
    });
    this.notify(request.familyId, this.eligibleResponders(request.familyId).map((r) => r.userId), {
      kind: 'request_escalated', title: `Passed to ${trusted.trustedCaregiverName}`,
      body: `The request “${request.childFacingLabel}” is now with ${trusted.trustedCaregiverName}.`,
      requestId: request.id, storyId: null, childId: request.childId,
      route: `/app/requests/${request.id}`, isUrgent: request.urgency === 'urgent',
    });
    this.commit();
    return request;
  }

  async resolveRequest(requestId: string, confirmUrgent: boolean): Promise<HelpRequest> {
    const user = this.requireUser();
    const request = this.db.requests.find((r) => r.id === requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.requirePermission(request.familyId, 'can_answer_requests');
    if (!canTransition(request.status, 'resolved')) {
      throw new KindlyError('INVALID_TRANSITION', 'This request cannot be finished from its current state.');
    }
    if (request.urgency === 'urgent' && !confirmUrgent) {
      throw new KindlyError('URGENT_RESOLVE_NEEDS_CONFIRMATION', 'Please confirm your child is safe and no longer waiting.');
    }
    const from = request.status;
    request.status = 'resolved';
    request.resolvedAt = nowIso();
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'resolved', from, 'resolved', 'caregiver', this.caregiverNameOf(user.id), {});
    this.commit();
    return request;
  }

  async cancelRequestAsCaregiver(requestId: string, reason?: string): Promise<HelpRequest> {
    const user = this.requireUser();
    const request = this.db.requests.find((r) => r.id === requestId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    this.requirePermission(request.familyId, 'can_answer_requests');
    if (!canTransition(request.status, 'cancelled')) {
      throw new KindlyError('INVALID_TRANSITION', 'This request cannot be cancelled from its current state.');
    }
    const from = request.status;
    request.status = 'cancelled';
    request.cancelledAt = nowIso();
    request.cancelledBy = 'caregiver';
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'cancelled', from, 'cancelled', 'caregiver', this.caregiverNameOf(user.id), { reason: reason ?? '' });
    this.commit();
    return request;
  }

  async tickEscalations(familyId: string): Promise<number> {
    this.memberOf(familyId);
    let changed = 0;
    const now = Date.now();
    const rules = this.escalationRulesTable;

    for (const request of this.db.requests) {
      if (request.familyId !== familyId) continue;

      if ((request.status === 'sending' || request.status === 'retrying')
        && now - new Date(request.sendingStartedAt ?? request.createdAt).getTime() > 60_000) {
        this.recordEvent(request, 'delivery_failed', request.status, 'failed', 'system', null, { reason: 'interrupted' });
        request.status = 'failed';
        request.failureReason = 'interrupted';
        request.lockVersion += 1;
        request.updatedAt = nowIso();
        changed += 1;
        continue;
      }

      if (!request.deliveredAt) continue;
      if (!['delivered', 'waiting', 'escalated'].includes(request.status)) continue;

      const elapsed = Math.floor((now - new Date(request.deliveredAt).getTime()) / 1000);
      const rule = rules
        .filter((r) => r.childId === request.childId && r.isActive
          && (r.appliesToUrgency === null || r.appliesToUrgency === request.urgency)
          && r.afterSeconds <= elapsed)
        .sort((a, b) => b.stepOrder - a.stepOrder)[0];
      if (!rule) continue;

      const childName = this.db.children.find((c) => c.id === request.childId)?.childName ?? 'Your child';

      if (rule.action === 'notify_trusted' && request.status === 'delivered') {
        this.recordEvent(request, 'status_changed', 'delivered', 'waiting', 'system', null, { afterSeconds: elapsed });
        request.status = 'waiting';
        request.waitingSince = nowIso();
        request.lockVersion += 1;
        request.updatedAt = nowIso();
        changed += 1;
      } else if ((rule.action === 'notify_trusted' || rule.action === 'notify_all_caregivers') && request.status === 'waiting') {
        const trusted = this.db.trusted
          .filter((t) => t.childId === request.childId && t.isActive && (!rule.trustedCaregiverId || t.id === rule.trustedCaregiverId))
          .sort((a, b) => a.escalationOrder - b.escalationOrder)[0];
        if (trusted) {
          this.recordEvent(request, 'escalated', 'waiting', 'escalated', 'system', null, { to: trusted.trustedCaregiverName, reason: 'No answer in time' });
          request.status = 'escalated';
          request.escalatedAt = nowIso();
          request.assignedToUserId = trusted.userId;
          request.assignedToTrustedId = trusted.id;
          request.assignedToName = trusted.trustedCaregiverName;
          this.notify(familyId, this.eligibleResponders(familyId).map((r) => r.userId), {
            kind: 'request_escalated', title: `No answer yet for ${childName}`,
            body: `The request “${request.childFacingLabel}” was passed to ${trusted.trustedCaregiverName}.`,
            requestId: request.id, storyId: null, childId: request.childId,
            route: `/app/requests/${request.id}`, isUrgent: request.urgency === 'urgent',
          });
        } else {
          this.recordEvent(request, 'status_changed', 'waiting', 'unavailable', 'system', null, { reason: 'no_trusted_caregiver' });
          request.status = 'unavailable';
          request.unavailableAt = nowIso();
        }
        request.lockVersion += 1;
        request.updatedAt = nowIso();
        changed += 1;
      } else if (rule.action === 'show_offline_help' && (request.status === 'waiting' || request.status === 'escalated')) {
        this.recordEvent(request, 'status_changed', request.status, 'unavailable', 'system', null, { afterSeconds: elapsed });
        request.status = 'unavailable';
        request.unavailableAt = nowIso();
        request.lockVersion += 1;
        request.updatedAt = nowIso();
        this.notify(familyId, this.eligibleResponders(familyId).map((r) => r.userId), {
          kind: 'request_unanswered', title: `Still no answer for ${childName}`,
          body: 'KINDLY has shown offline help. Please check on them.',
          requestId: request.id, storyId: null, childId: request.childId,
          route: `/app/requests/${request.id}`, isUrgent: true,
        });
        changed += 1;
      }
    }

    if (changed) this.commit();
    return changed;
  }

  subscribeToFamily(_familyId: string, cb: () => void): Unsubscribe {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  subscribeToChild(_childId: string, cb: () => void): Unsubscribe {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  // -- child session --------------------------------------------------------

  async startChildSession(childId: string, deviceLabel?: string): Promise<ChildSession> {
    const familyId = this.familyOfChild(childId);
    const user = this.memberOf(familyId);
    for (const s of this.db.childSessions) {
      if (s.childId === childId && s.state === 'active') s.state = 'ended';
    }
    const token = uid() + uid();
    const session: DbChildSession = {
      id: uid(), familyId, childId, tokenHash: weakHash(token), state: 'active',
      startedBy: user.userId, deviceLabel: deviceLabel ?? 'This device',
      allowedActions: [
        'create_request', 'send_request', 'cancel_request', 'resolve_request',
        'read_own_requests', 'read_own_routines', 'run_routine',
        'read_assigned_stories', 'send_story_feedback', 'read_own_preferences',
      ],
      expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    };
    this.db.childSessions.push(session);
    this.audit(familyId, 'child_session.start', 'child_session', session.id, { childId });
    this.commit();
    return { sessionId: session.id, sessionToken: token, childId, familyId, expiresAt: session.expiresAt };
  }

  private assertChildSession(token: string, action: string): DbChildSession {
    const hash = weakHash(token ?? '');
    const s = this.db.childSessions.find((x) => x.tokenHash === hash);
    if (!s) throw new KindlyError('CHILD_SESSION_INVALID', 'This child session is no longer valid. Ask a grown-up to start it again.');
    if (s.state !== 'active') throw new KindlyError(`CHILD_SESSION_${s.state.toUpperCase()}`, 'This child session has ended. Ask a grown-up to start it again.');
    if (new Date(s.expiresAt) <= new Date()) {
      s.state = 'expired';
      this.commit();
      throw new KindlyError('CHILD_SESSION_EXPIRED', 'This child session has ended. Ask a grown-up to start it again.');
    }
    if (!s.allowedActions.includes(action)) {
      throw new KindlyError('CHILD_ACTION_NOT_PERMITTED', 'That is not something this session can do.');
    }
    return s;
  }

  async endChildSession(token: string): Promise<void> {
    const hash = weakHash(token ?? '');
    const s = this.db.childSessions.find((x) => x.tokenHash === hash);
    if (!s) return;
    s.state = 'ended';
    this.audit(s.familyId, 'child_session.end', 'child_session', s.id, {});
    this.commit();
  }

  async childGetSpace(token: string): Promise<ChildSpace> {
    const s = this.assertChildSession(token, 'read_own_preferences');
    const child = this.db.children.find((c) => c.id === s.childId)!;
    const prefs = this.db.preferences.find((p) => p.childId === s.childId) ?? defaultPreferences(s.childId, s.familyId);
    const family = this.db.families.find((f) => f.id === s.familyId);

    const types = this.db.requestTypes
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => (t.slug === 'bathroom' ? { ...t, urgency: prefs.bathroomUrgency } : t));

    return {
      child: {
        id: child.id, childName: child.childName, pronouns: child.pronouns,
        safeAdult: child.safeAdult, safePlace: child.safePlace,
        emergencyInstructions: child.emergencyInstructions ?? family?.emergencyInstructions ?? null,
      },
      preferences: prefs,
      requestTypes: types,
      trustedCaregivers: this.db.trusted
        .filter((t) => t.childId === s.childId && t.isActive)
        .sort((a, b) => a.escalationOrder - b.escalationOrder)
        .map((t) => ({ trustedCaregiverName: t.trustedCaregiverName, escalationOrder: t.escalationOrder })),
      session: { id: s.id, childId: s.childId, expiresAt: s.expiresAt },
    };
  }

  async childGetRequests(token: string): Promise<RequestBundle[]> {
    const s = this.assertChildSession(token, 'read_own_requests');
    const hourAgo = Date.now() - 3600_000;
    return this.db.requests
      .filter((r) => r.childId === s.childId
        && (!['resolved', 'cancelled'].includes(r.status) || new Date(r.updatedAt).getTime() > hourAgo))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.bundle(r));
  }

  async childCreateRequest(token: string, input: {
    typeSlug: string; dedupeKey: string; customMessage?: string | null;
    connectionState?: 'online' | 'offline' | 'unknown'; labelOverride?: string | null; detailOverride?: string | null;
  }): Promise<HelpRequest> {
    const s = this.assertChildSession(token, 'create_request');

    const existingByKey = this.db.requests.find((r) => r.childId === s.childId && r.clientDedupeKey === input.dedupeKey);
    if (existingByKey) return existingByKey;

    const type = this.db.requestTypes.find((t) => t.slug === input.typeSlug);
    if (!type) throw new KindlyError('UNKNOWN_REQUEST_TYPE', 'That request is not available.');

    const prefs = this.db.preferences.find((p) => p.childId === s.childId) ?? defaultPreferences(s.childId, s.familyId);
    const urgency: Urgency = type.slug === 'bathroom' ? prefs.bathroomUrgency : type.urgency;
    const label = clean(input.labelOverride) || type.childFacingLabel;
    const detail = clean(input.detailOverride) || type.childFacingDetail;

    const openDuplicate = this.db.requests.find((r) =>
      r.childId === s.childId && r.typeSlug === type.slug && r.childFacingLabel === label
      && !['resolved', 'cancelled'].includes(r.status));
    if (openDuplicate) return openDuplicate;

    const request: HelpRequest = {
      id: uid(), familyId: s.familyId, childId: s.childId, childSessionId: s.id,
      typeSlug: type.slug, childFacingLabel: label, childFacingDetail: detail,
      urgency, pictogramKey: type.pictogramKey, pictogramMediaId: type.pictogramMediaId,
      customMessage: prefs.allowCustomMessage ? cleanOrNull(input.customMessage) : null,
      status: 'reviewing', createdAt: nowIso(),
      sendingStartedAt: null, deliveredAt: null, acknowledgedAt: null, resolvedAt: null,
      cancelledAt: null, waitingSince: null, escalatedAt: null, unavailableAt: null,
      assignedToUserId: null, assignedToTrustedId: null, assignedToName: null,
      attempts: 0, failureReason: null, cancelledBy: null,
      deviceLabel: s.deviceLabel, connectionState: input.connectionState ?? 'online',
      lockVersion: 0, updatedAt: nowIso(),
      clientDedupeKey: input.dedupeKey,
    };

    this.db.requests.push(request);
    this.recordEvent(request, 'created', null, 'reviewing', 'child', null, { typeSlug: type.slug, urgency });
    this.commit();
    return request;
  }

  async childSendRequest(token: string, requestId: string, connectionState: 'online' | 'offline' | 'unknown' = 'online'): Promise<HelpRequest> {
    const s = this.assertChildSession(token, 'send_request');
    const request = this.db.requests.find((r) => r.id === requestId && r.childId === s.childId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');

    const from = request.status;
    const to: RequestStatus = from === 'reviewing' ? 'sending' : 'retrying';
    if (!canTransition(from, to)) return request;

    const childName = this.db.children.find((c) => c.id === request.childId)?.childName ?? 'Your child';

    request.status = to;
    request.sendingStartedAt = request.sendingStartedAt ?? nowIso();
    request.attempts += 1;
    request.failureReason = null;
    request.connectionState = connectionState;
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, to === 'retrying' ? 'retry_attempted' : 'status_changed', from, to, 'child', childName, { attempt: request.attempts });

    // The device says it is offline: never claim delivery.
    if (connectionState === 'offline') {
      request.status = 'failed';
      request.failureReason = 'offline';
      request.lockVersion += 1;
      request.updatedAt = nowIso();
      this.recordEvent(request, 'delivery_failed', to, 'failed', 'system', null, { reason: 'offline' });
      this.commit();
      return request;
    }

    const responders = this.eligibleResponders(request.familyId)
      .sort((a, b) => Number(b.userId === s.startedBy) - Number(a.userId === s.startedBy) || a.joinedAt.localeCompare(b.joinedAt));

    if (responders.length === 0) {
      request.status = 'unavailable';
      request.unavailableAt = nowIso();
      request.lockVersion += 1;
      request.updatedAt = nowIso();
      this.recordEvent(request, 'delivery_failed', to, 'unavailable', 'system', null, { reason: 'no_eligible_responder' });
      this.commit();
      return request;
    }

    request.assignedToUserId = responders[0]!.userId;
    request.assignedToName = responders[0]!.caregiverName;

    this.notify(request.familyId, responders.map((r) => r.userId), {
      kind: 'request_created',
      title: `${childName} asked for: ${request.childFacingLabel}`,
      body: request.urgency === 'urgent' ? 'Urgent request. Please answer now.' : 'This can wait a little, but please answer.',
      requestId: request.id, storyId: null, childId: request.childId,
      route: `/app/requests/${request.id}`, isUrgent: request.urgency === 'urgent',
    });

    request.status = 'delivered';
    request.deliveredAt = nowIso();
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'delivery_confirmed', to, 'delivered', 'system', null, { notified: responders.length });

    this.commit();
    return request;
  }

  async childCancelRequest(token: string, requestId: string): Promise<HelpRequest> {
    const s = this.assertChildSession(token, 'cancel_request');
    const request = this.db.requests.find((r) => r.id === requestId && r.childId === s.childId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    const from = request.status;
    if (!canTransition(from, 'cancelled')) return request;

    const childName = this.db.children.find((c) => c.id === request.childId)?.childName ?? 'Your child';
    const wasDelivered = Boolean(request.deliveredAt);

    request.status = 'cancelled';
    request.cancelledAt = nowIso();
    request.cancelledBy = 'child';
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'cancelled', from, 'cancelled', 'child', childName, { wasDelivered });

    if (wasDelivered) {
      this.notify(request.familyId, this.eligibleResponders(request.familyId).map((r) => r.userId), {
        kind: 'request_cancelled', title: `${childName} changed their mind`,
        body: `The request “${request.childFacingLabel}” was cancelled. No answer is needed now.`,
        requestId: request.id, storyId: null, childId: request.childId,
        route: `/app/requests/${request.id}`, isUrgent: false,
      });
    }
    this.commit();
    return request;
  }

  async childResolveRequest(token: string, requestId: string): Promise<HelpRequest> {
    const s = this.assertChildSession(token, 'resolve_request');
    const request = this.db.requests.find((r) => r.id === requestId && r.childId === s.childId);
    if (!request) throw new KindlyError('REQUEST_NOT_FOUND', 'That request could not be found.');
    const from = request.status;
    if (!canTransition(from, 'resolved')) return request;
    const childName = this.db.children.find((c) => c.id === request.childId)?.childName ?? null;
    request.status = 'resolved';
    request.resolvedAt = nowIso();
    request.lockVersion += 1;
    request.updatedAt = nowIso();
    this.recordEvent(request, 'resolved', from, 'resolved', 'child', childName, {});
    this.commit();
    return request;
  }

  async childGetStories(token: string) {
    const s = this.assertChildSession(token, 'read_assigned_stories');
    return this.db.storyAssignments
      .filter((a) => a.childId === s.childId && !a.withdrawnAt)
      .map((a) => this.db.stories.find((st) => st.id === a.storyId))
      .filter((st): st is NonNullable<typeof st> =>
        Boolean(st) && st!.status === 'approved' && !st!.deletedAt && !st!.archivedAt)
      .map((st) => ({
        id: st.id, title: st.title, scenarioKey: st.scenarioKey, format: st.format,
        lastPage: this.db.storyProgress.find((p) => p.storyId === st.id && p.childId === s.childId)?.lastPage ?? 0,
        pages: this.db.storyPages
          .filter((p) => p.storyId === st.id && !p.deletedAt)
          .sort((a, b) => a.position - b.position)
          .map((p) => ({
            position: p.position, sectionKey: p.sectionKey, heading: p.heading,
            body: p.body, certainty: p.certainty, pictogramKey: p.pictogramKey, altText: p.altText,
          })),
      }));
  }

  async childSetStoryProgress(token: string, storyId: string, page: number): Promise<void> {
    const s = this.assertChildSession(token, 'read_assigned_stories');
    const assigned = this.db.storyAssignments.some((a) => a.storyId === storyId && a.childId === s.childId && !a.withdrawnAt);
    if (!assigned) throw new KindlyError('STORY_NOT_ASSIGNED', 'That story is not available.');
    const row = this.db.storyProgress.find((p) => p.storyId === storyId && p.childId === s.childId);
    if (row) row.lastPage = Math.max(0, page);
    else this.db.storyProgress.push({ storyId, childId: s.childId, lastPage: Math.max(0, page) });
    this.commit();
  }

  async childSendStoryFeedback(token: string, storyId: string, kind: StoryFeedback['kind'], pagePosition?: number | null): Promise<void> {
    const s = this.assertChildSession(token, 'send_story_feedback');
    this.db.storyFeedback.push({
      id: uid(), storyId, childId: s.childId, familyId: s.familyId,
      pagePosition: pagePosition ?? null, kind, createdAt: nowIso(), seenAt: null,
    });
    const childName = this.db.children.find((c) => c.id === s.childId)?.childName ?? 'Your child';
    const title = this.db.stories.find((st) => st.id === storyId)?.title ?? 'A story';
    this.notify(s.familyId, this.eligibleResponders(s.familyId).map((r) => r.userId), {
      kind: 'child_story_feedback',
      title: `${childName} told you something about a story`,
      body: `${title} — ${kind.replace(/_/g, ' ')}`,
      requestId: null, storyId, childId: s.childId, route: `/app/stories/${storyId}`, isUrgent: false,
    });
    this.commit();
  }

  async childGetRoutines(token: string): Promise<Routine[]> {
    const s = this.assertChildSession(token, 'read_own_routines');
    return this.routinesFor(s.childId);
  }

  // -- routines -------------------------------------------------------------

  private routinesFor(childId: string): Routine[] {
    return this.db.routines
      .filter((r) => r.childId === childId && !r.deletedAt && !r.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => ({
        ...r,
        steps: this.db.routineSteps
          .filter((s) => s.routineId === r.id && !s.deletedAt)
          .sort((a, b) => a.position - b.position),
      }));
  }

  async listRoutines(childId: string): Promise<Routine[]> {
    this.memberOf(this.familyOfChild(childId));
    return this.db.routines
      .filter((r) => r.childId === childId && !r.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((r) => ({
        ...r,
        steps: this.db.routineSteps.filter((s) => s.routineId === r.id && !s.deletedAt).sort((a, b) => a.position - b.position),
      }));
  }

  async saveRoutine(input: RoutineInput): Promise<Routine> {
    const familyId = this.familyOfChild(input.childId);
    this.requirePermission(familyId, 'can_edit_routines');
    const title = clean(input.title);
    if (!title) throw new KindlyError('ROUTINE_TITLE_REQUIRED', 'Please give this routine a name.');
    if (!input.steps.length) throw new KindlyError('ROUTINE_NEEDS_STEPS', 'Please add at least one step.');

    let routine = input.id ? this.db.routines.find((r) => r.id === input.id) : undefined;
    if (!routine) {
      routine = {
        id: uid(), familyId, childId: input.childId, title, description: null, iconKey: null,
        colorKey: 'yellow', scheduleLabel: null, scheduleDays: null, scheduleTime: null,
        allowReorder: true, allowSkip: true, transitionWarningSeconds: 60,
        sortOrder: this.db.routines.filter((r) => r.childId === input.childId).length,
        archivedAt: null, deletedAt: null,
      };
      this.db.routines.push(routine);
    }
    Object.assign(routine, {
      title,
      description: cleanOrNull(input.description),
      iconKey: cleanOrNull(input.iconKey),
      colorKey: input.colorKey ?? routine.colorKey,
      scheduleLabel: cleanOrNull(input.scheduleLabel),
      scheduleDays: input.scheduleDays ?? null,
      scheduleTime: input.scheduleTime ?? null,
      allowReorder: input.allowReorder ?? true,
      allowSkip: input.allowSkip ?? true,
      transitionWarningSeconds: input.transitionWarningSeconds ?? 60,
    });

    const keptIds = new Set(input.steps.map((s) => s.id).filter(Boolean) as string[]);
    for (const s of this.db.routineSteps) {
      if (s.routineId === routine.id && !keptIds.has(s.id)) s.deletedAt = nowIso();
    }
    input.steps.forEach((step, index) => {
      const stepTitle = clean(step.title);
      if (!stepTitle) throw new KindlyError('STEP_TITLE_REQUIRED', 'Every step needs a name.');
      const existing = step.id ? this.db.routineSteps.find((s) => s.id === step.id) : undefined;
      if (existing) {
        Object.assign(existing, { ...step, title: stepTitle, position: index, deletedAt: null });
      } else {
        this.db.routineSteps.push({
          id: uid(), routineId: routine!.id, position: index, title: stepTitle,
          detail: cleanOrNull(step.detail), pictogramKey: cleanOrNull(step.pictogramKey),
          photoMediaId: step.photoMediaId ?? null, audioMediaId: step.audioMediaId ?? null,
          estimatedSeconds: step.estimatedSeconds ?? null, isOptional: step.isOptional ?? false,
          plansChangedNote: cleanOrNull(step.plansChangedNote), deletedAt: null,
        });
      }
    });

    this.audit(familyId, 'routine.saved', 'routine', routine.id, {});
    this.commit();
    return (await this.listRoutines(input.childId)).find((r) => r.id === routine!.id)!;
  }

  async duplicateRoutine(routineId: string): Promise<Routine> {
    const source = this.db.routines.find((r) => r.id === routineId);
    if (!source) throw new KindlyError('ROUTINE_NOT_FOUND', 'That routine could not be found.');
    this.requirePermission(source.familyId, 'can_edit_routines');
    const steps = this.db.routineSteps.filter((s) => s.routineId === routineId && !s.deletedAt).sort((a, b) => a.position - b.position);
    return this.saveRoutine({
      childId: source.childId,
      title: `${source.title} (copy)`,
      description: source.description, iconKey: source.iconKey, colorKey: source.colorKey,
      scheduleLabel: source.scheduleLabel, scheduleDays: source.scheduleDays, scheduleTime: source.scheduleTime,
      allowReorder: source.allowReorder, allowSkip: source.allowSkip,
      transitionWarningSeconds: source.transitionWarningSeconds,
      steps: steps.map((s) => ({
        title: s.title, detail: s.detail, pictogramKey: s.pictogramKey, photoMediaId: s.photoMediaId,
        audioMediaId: s.audioMediaId, estimatedSeconds: s.estimatedSeconds, isOptional: s.isOptional,
        plansChangedNote: s.plansChangedNote,
      })),
    });
  }

  async archiveRoutine(routineId: string, archived: boolean): Promise<void> {
    const routine = this.db.routines.find((r) => r.id === routineId);
    if (!routine) return;
    this.requirePermission(routine.familyId, 'can_edit_routines');
    routine.archivedAt = archived ? nowIso() : null;
    this.commit();
  }

  async deleteRoutine(routineId: string): Promise<void> {
    const routine = this.db.routines.find((r) => r.id === routineId);
    if (!routine) return;
    this.requirePermission(routine.familyId, 'can_edit_routines');
    routine.deletedAt = nowIso();
    this.audit(routine.familyId, 'routine.deleted', 'routine', routineId, {});
    this.commit();
  }

  async reorderRoutines(childId: string, orderedIds: string[]): Promise<void> {
    this.requirePermission(this.familyOfChild(childId), 'can_edit_routines');
    orderedIds.forEach((id, i) => {
      const r = this.db.routines.find((x) => x.id === id && x.childId === childId);
      if (r) r.sortOrder = i;
    });
    this.commit();
  }

  async startRoutineRun(routineId: string, by: 'child' | 'caregiver'): Promise<RoutineRun> {
    const routine = this.db.routines.find((r) => r.id === routineId);
    if (!routine) throw new KindlyError('ROUTINE_NOT_FOUND', 'That routine could not be found.');
    const existing = this.db.routineRuns.find((r) => r.routineId === routineId && ['running', 'paused'].includes(r.status));
    if (existing) {
      existing.status = 'running';
      existing.pausedAt = null;
      this.commit();
      return existing;
    }
    const steps = this.db.routineSteps.filter((s) => s.routineId === routineId && !s.deletedAt).sort((a, b) => a.position - b.position);
    const run: RoutineRun = {
      id: uid(), routineId, childId: routine.childId, status: 'running',
      currentStepId: steps[0]?.id ?? null, stepStates: [],
      startedAt: nowIso(), pausedAt: null, finishedAt: null, plansChangedAt: null,
    };
    this.db.routineRuns.push(run);
    this.audit(routine.familyId, 'routine.run_started', 'routine_run', run.id, { by });
    this.commit();
    return run;
  }

  async setRoutineStepState(runId: string, stepId: string, state: RoutineStepState): Promise<RoutineRun> {
    const run = this.db.routineRuns.find((r) => r.id === runId);
    if (!run) throw new KindlyError('RUN_NOT_FOUND', 'That routine is no longer running.');
    run.stepStates = [...run.stepStates.filter((s) => s.stepId !== stepId), { stepId, state, at: nowIso() }];
    const steps = this.db.routineSteps.filter((s) => s.routineId === run.routineId && !s.deletedAt).sort((a, b) => a.position - b.position);
    const index = steps.findIndex((s) => s.id === stepId);
    run.currentStepId = steps[index + 1]?.id ?? null;
    if (!run.currentStepId) {
      run.status = 'finished';
      run.finishedAt = nowIso();
    }
    this.commit();
    return run;
  }

  async setRoutineRunStatus(runId: string, status: RoutineRun['status']): Promise<RoutineRun> {
    const run = this.db.routineRuns.find((r) => r.id === runId);
    if (!run) throw new KindlyError('RUN_NOT_FOUND', 'That routine is no longer running.');
    run.status = status;
    run.pausedAt = status === 'paused' ? nowIso() : null;
    if (status === 'finished' || status === 'abandoned') run.finishedAt = nowIso();
    if (status === 'plans_changed') run.plansChangedAt = nowIso();
    this.commit();
    return run;
  }

  async getActiveRoutineRun(routineId: string): Promise<RoutineRun | null> {
    return this.db.routineRuns.find((r) => r.routineId === routineId && ['running', 'paused'].includes(r.status)) ?? null;
  }

  // -- stories --------------------------------------------------------------

  private hydrateStory(id: string): Story {
    const s = this.db.stories.find((x) => x.id === id);
    if (!s) throw new KindlyError('STORY_NOT_FOUND', 'That story could not be found.');
    return {
      ...s,
      approvedByName: this.caregiverNameOf(s.approvedBy),
      pages: this.db.storyPages.filter((p) => p.storyId === id && !p.deletedAt).sort((a, b) => a.position - b.position),
      assignedChildIds: this.db.storyAssignments.filter((a) => a.storyId === id && !a.withdrawnAt).map((a) => a.childId),
    };
  }

  async listStories(childId: string): Promise<Story[]> {
    this.memberOf(this.familyOfChild(childId));
    return this.db.stories
      .filter((s) => s.childId === childId && !s.deletedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.hydrateStory(s.id));
  }

  async getStory(storyId: string): Promise<Story> {
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) throw new KindlyError('STORY_NOT_FOUND', 'That story could not be found.');
    this.memberOf(story.familyId);
    return this.hydrateStory(storyId);
  }

  async saveStoryDraft(input: StoryDraftInput & { id?: string }): Promise<Story> {
    const familyId = this.familyOfChild(input.childId);
    this.requirePermission(familyId, 'can_edit_stories');

    const review = reviewStory(
      input.title,
      input.pages.map((p, i) => ({ position: i, heading: p.heading, body: p.body })),
    );

    let story = input.id ? this.db.stories.find((s) => s.id === input.id) : undefined;
    if (!story) {
      story = {
        id: uid(), familyId, childId: input.childId, title: input.title, scenarioKey: input.scenarioKey,
        // Every save produces a DRAFT. Approval is a separate, explicit action.
        status: 'draft', source: input.source, format: input.format, person: input.person,
        readingLevel: input.readingLevel, targetPageCount: input.pages.length, inputs: input.inputs ?? {},
        generationModel: null, generationPromptVersion: null, generatedAt: null, generationError: null,
        reviewFlags: [], requiresSafetyReview: false, approvedBy: null, approvedByName: null,
        approvedAt: null, archivedAt: null, version: 1,
        createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null,
      };
      this.db.stories.push(story);
    }

    Object.assign(story, {
      title: input.title, format: input.format, person: input.person,
      readingLevel: input.readingLevel, inputs: input.inputs ?? story.inputs,
      source: input.source, scenarioKey: input.scenarioKey,
      reviewFlags: review.flags, requiresSafetyReview: review.requiresSafetyReview,
      targetPageCount: input.pages.length, updatedAt: nowIso(),
      // Editing an approved story returns it to draft: the child keeps reading
      // the last approved version until a caregiver approves the new one.
      status: story.status === 'approved' ? 'draft' : story.status,
      generationModel: input.generation?.model ?? story.generationModel,
      generationPromptVersion: input.generation?.promptVersion ?? story.generationPromptVersion,
      generatedAt: input.generation?.generatedAt ?? story.generatedAt,
    });

    const keptIds = new Set(input.pages.map((p) => p.id).filter(Boolean) as string[]);
    for (const p of this.db.storyPages) {
      if (p.storyId === story.id && !keptIds.has(p.id)) p.deletedAt = nowIso();
    }
    input.pages.forEach((page, index) => {
      const flags = review.flags.filter((f) => f.pagePosition === index);
      const existing = page.id ? this.db.storyPages.find((p) => p.id === page.id) : undefined;
      if (existing) {
        Object.assign(existing, { ...page, position: index, reviewFlags: flags, deletedAt: null });
      } else {
        this.db.storyPages.push({
          id: uid(), storyId: story!.id, position: index, sectionKey: page.sectionKey,
          heading: page.heading ?? null, body: page.body, certainty: page.certainty,
          pictogramKey: page.pictogramKey ?? null, imageMediaId: page.imageMediaId ?? null,
          audioMediaId: page.audioMediaId ?? null, altText: page.altText ?? null,
          reviewFlags: flags, deletedAt: null,
        } as StoryPage & { deletedAt: string | null });
      }
    });

    this.audit(familyId, 'story.saved', 'story', story.id, { source: input.source });
    this.commit();
    return this.hydrateStory(story.id);
  }

  async approveStory(storyId: string, acknowledgeFlags: boolean): Promise<Story> {
    const user = this.requireUser();
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) throw new KindlyError('STORY_NOT_FOUND', 'That story could not be found.');
    this.requirePermission(story.familyId, 'can_approve_stories');

    const pages = this.db.storyPages.filter((p) => p.storyId === storyId && !p.deletedAt);
    if (pages.length < 3) throw new KindlyError('STORY_TOO_SHORT', 'A story needs at least three pages.');
    if ((story.requiresSafetyReview || story.reviewFlags.length > 0) && !acknowledgeFlags) {
      throw new KindlyError('STORY_HAS_UNREVIEWED_FLAGS', 'Please read the highlighted parts and confirm before approving.');
    }

    this.db.storyVersions.push({
      id: uid(), storyId, familyId: story.familyId, version: story.version,
      changeNote: `Approved by ${this.caregiverNameOf(user.id) ?? 'a caregiver'}`,
      createdByName: this.caregiverNameOf(user.id), createdAt: nowIso(),
      snapshot: { story: { ...story }, pages: pages.map((p) => ({ ...p })) },
    });

    story.status = 'approved';
    story.approvedBy = user.id;
    story.approvedAt = nowIso();
    story.version += 1;
    story.updatedAt = nowIso();
    this.audit(story.familyId, 'story.approved', 'story', storyId, { version: story.version });
    this.commit();
    return this.hydrateStory(storyId);
  }

  async assignStory(storyId: string, childId: string): Promise<void> {
    const user = this.requireUser();
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) throw new KindlyError('STORY_NOT_FOUND', 'That story could not be found.');
    this.requirePermission(story.familyId, 'can_approve_stories');
    // The single rule the whole story pipeline exists to protect.
    if (story.status !== 'approved') {
      throw new KindlyError('STORY_NOT_APPROVED', 'Only an approved story can be given to a child.');
    }
    if (this.familyOfChild(childId) !== story.familyId) {
      throw new KindlyError('CHILD_NOT_IN_FAMILY', 'That child is not part of this family space.');
    }
    const existing = this.db.storyAssignments.find((a) => a.storyId === storyId && a.childId === childId);
    if (existing) {
      existing.withdrawnAt = null;
      existing.assignedAt = nowIso();
    } else {
      this.db.storyAssignments.push({ storyId, childId, familyId: story.familyId, assignedBy: user.id, assignedAt: nowIso(), withdrawnAt: null });
    }
    this.audit(story.familyId, 'story.assigned', 'story', storyId, { childId });
    this.commit();
  }

  async withdrawStory(storyId: string, childId: string): Promise<void> {
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) return;
    this.requirePermission(story.familyId, 'can_approve_stories');
    const a = this.db.storyAssignments.find((x) => x.storyId === storyId && x.childId === childId);
    if (a) a.withdrawnAt = nowIso();
    this.audit(story.familyId, 'story.withdrawn', 'story', storyId, { childId });
    this.commit();
  }

  async archiveStory(storyId: string, archived: boolean): Promise<void> {
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) return;
    this.requirePermission(story.familyId, 'can_edit_stories');
    story.archivedAt = archived ? nowIso() : null;
    story.status = archived ? 'archived' : 'draft';
    this.commit();
  }

  async deleteStory(storyId: string): Promise<void> {
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) return;
    this.requirePermission(story.familyId, 'can_edit_stories');
    story.deletedAt = nowIso();
    for (const a of this.db.storyAssignments) if (a.storyId === storyId) a.withdrawnAt = nowIso();
    this.audit(story.familyId, 'story.deleted', 'story', storyId, {});
    this.commit();
  }

  async duplicateStory(storyId: string): Promise<Story> {
    const story = await this.getStory(storyId);
    return this.saveStoryDraft({
      childId: story.childId, title: `${story.title} (copy)`, scenarioKey: story.scenarioKey,
      source: story.source, format: story.format, person: story.person,
      readingLevel: story.readingLevel, inputs: story.inputs,
      pages: story.pages.map((p) => ({
        sectionKey: p.sectionKey, heading: p.heading, body: p.body, certainty: p.certainty,
        pictogramKey: p.pictogramKey, imageMediaId: p.imageMediaId, audioMediaId: p.audioMediaId, altText: p.altText,
      })),
    });
  }

  async generateStory(): Promise<never> {
    // There is no generation service in this backend. Saying so lets the editor
    // fall back to the built-in builder and tell the caregiver why.
    throw new KindlyError(
      'GENERATION_UNAVAILABLE',
      'Story generation is not configured. You can still write the story yourself.',
    );
  }

  async listStoryVersions(storyId: string): Promise<StoryVersion[]> {
    const story = this.db.stories.find((s) => s.id === storyId);
    if (!story) return [];
    this.memberOf(story.familyId);
    return this.db.storyVersions.filter((v) => v.storyId === storyId).sort((a, b) => b.version - a.version);
  }

  async listStoryFeedback(familyId: string): Promise<StoryFeedback[]> {
    this.memberOf(familyId);
    return this.db.storyFeedback.filter((f) => f.familyId === familyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markStoryFeedbackSeen(feedbackId: string): Promise<void> {
    const f = this.db.storyFeedback.find((x) => x.id === feedbackId);
    if (!f) return;
    this.memberOf(f.familyId);
    f.seenAt = nowIso();
    this.commit();
  }

  // -- notifications --------------------------------------------------------

  async listNotifications(familyId: string): Promise<AppNotification[]> {
    const user = this.requireUser();
    this.memberOf(familyId);
    return this.db.notifications
      .filter((n) => n.userId === user.id && n.familyId === familyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }

  async markNotificationsRead(ids?: string[]): Promise<void> {
    const user = this.requireUser();
    for (const n of this.db.notifications) {
      if (n.userId === user.id && !n.readAt && (!ids || ids.includes(n.id))) n.readAt = nowIso();
    }
    this.commit();
  }

  // -- media ----------------------------------------------------------------

  async listMedia(familyId: string): Promise<MediaAsset[]> {
    this.memberOf(familyId);
    return this.db.media.filter((m) => m.familyId === familyId && !m.deletedAt);
  }

  async uploadMedia(input: { familyId: string; childId?: string | null; kind: MediaAsset['kind']; file: File; altText: string; caption?: string | null }): Promise<MediaAsset> {
    const user = this.requireUser();
    this.memberOf(input.familyId);
    const altText = clean(input.altText);
    if (!altText) throw new KindlyError('ALT_TEXT_REQUIRED', 'Please describe this picture in words so it can be read aloud.');

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new KindlyError('UPLOAD_FAILED', 'That file could not be read. Please try again.'));
      reader.readAsDataURL(input.file);
    });

    const asset = {
      id: uid(), familyId: input.familyId, childId: input.childId ?? null, kind: input.kind,
      storagePath: `${input.familyId}/${input.childId ?? 'shared'}/${uid()}`,
      mimeType: input.file.type, altText, caption: cleanOrNull(input.caption),
      createdAt: nowIso(), dataUrl, deletedAt: null,
    };
    this.db.media.push(asset);
    this.audit(input.familyId, 'media.uploaded', 'media_asset', asset.id, { kind: input.kind });
    void user;
    this.commit();
    return asset;
  }

  async getSignedMediaUrl(mediaId: string): Promise<string> {
    const m = this.db.media.find((x) => x.id === mediaId && !x.deletedAt);
    if (!m) throw new KindlyError('MEDIA_NOT_FOUND', 'That picture could not be found.');
    this.memberOf(m.familyId);
    return m.dataUrl;
  }

  async deleteMedia(mediaId: string): Promise<void> {
    const m = this.db.media.find((x) => x.id === mediaId);
    if (!m) return;
    this.memberOf(m.familyId);
    m.deletedAt = nowIso();
    this.commit();
  }

  // -- operator -------------------------------------------------------------

  /**
   * Stands in for inserting a row into `kindly.operators` by hand. There is no
   * client path to this in either backend — an operator is granted from outside
   * the application, which is the whole point of the table having no policy.
   */
  grantOperatorForTests(userId: string): void {
    if (!this.db.operators.includes(userId)) this.db.operators.push(userId);
    this.commit();
  }

  async amIOperator(): Promise<boolean> {
    return this.currentUserId != null && this.db.operators.includes(this.currentUserId);
  }

  async getOperatorMetrics(): Promise<OperatorMetrics> {
    if (!this.currentUserId) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in.');
    if (!this.db.operators.includes(this.currentUserId)) {
      throw new KindlyError('NOT_PERMITTED', 'You do not have permission to do that.');
    }

    const now = Date.now();
    const since = (days: number) => now - days * 86_400_000;
    const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
    const recent = (r: HelpRequest, days: number) => (at(r.createdAt) ?? 0) > since(days);

    const all = this.db.requests;
    const week = all.filter((r) => recent(r, 7));
    const count = (list: HelpRequest[], pred: (r: HelpRequest) => boolean) => list.filter(pred).length;

    // Median and p90 over the gap from delivered to acknowledged, in seconds.
    const answerSeconds = week
      .filter((r) => r.acknowledgedAt && r.deliveredAt)
      .map((r) => (at(r.acknowledgedAt)! - at(r.deliveredAt)!) / 1000)
      .sort((a, b) => a - b);
    const quantile = (q: number): number | null => {
      if (!answerSeconds.length) return null;
      const pos = (answerSeconds.length - 1) * q;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      const value = lo === hi ? answerSeconds[lo]! : answerSeconds[lo]! + (answerSeconds[hi]! - answerSeconds[lo]!) * (pos - lo);
      return Math.round(value);
    };

    const tally = (list: HelpRequest[], key: (r: HelpRequest) => string | null | undefined) => {
      const out: Record<string, number> = {};
      for (const r of list) {
        const k = key(r);
        if (k) out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    };

    // Fourteen days of counts, oldest first, with empty days present as zero so
    // a gap reads as a quiet day rather than as missing data.
    const dailyRequests: { day: string; n: number }[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      dailyRequests.push({ day, n: count(all, (r) => (r.createdAt ?? '').slice(0, 10) === day) });
    }

    const families = this.db.families.filter((f) => !f.deletedAt).length;
    const OPEN: HelpRequest['status'][] = ['sending', 'retrying', 'delivered', 'waiting', 'escalated', 'acknowledged'];

    return {
      generatedAt: nowIso(),
      reach: {
        families,
        children: this.db.children.filter((c) => !c.deletedAt).length,
        caregivers: new Set(this.db.members.map((m) => m.userId)).size,
        trusted: this.db.trusted.length,
        familiesAdded7d: this.db.families.filter((f) => (at(f.createdAt) ?? 0) > since(7)).length,
      },
      requests: {
        total: all.length,
        last24h: count(all, (r) => recent(r, 1)),
        last7d: week.length,
        urgent7d: count(week, (r) => r.urgency === 'urgent'),
        answered7d: count(week, (r) => Boolean(r.acknowledgedAt)),
        resolved7d: count(week, (r) => Boolean(r.resolvedAt)),
        cancelled7d: count(week, (r) => Boolean(r.cancelledAt)),
      },
      waiting: {
        escalated7d: count(week, (r) => Boolean(r.escalatedAt)),
        unavailable7d: count(week, (r) => Boolean(r.unavailableAt)),
        failed7d: count(week, (r) => r.status === 'failed'),
        openNow: count(all, (r) => OPEN.includes(r.status)),
        medianAnswerSeconds: quantile(0.5),
        p90AnswerSeconds: quantile(0.9),
      },
      failures7d: tally(week, (r) => r.failureReason),
      dailyRequests,
      safety: {
        familiesWithCode: this.db.pins.filter((p2) => p2.pinHash).length,
        childrenWithSafeAdult: this.db.children.filter((c) => (c.safeAdult ?? '').trim() !== '').length,
        childrenWithOfflineHelpStep: new Set(
          this.db.escalationRules.filter((r) => r.action === 'show_offline_help' && r.isActive).map((r) => r.childId),
        ).size,
      },
      // Cumulative, exactly as the SQL defines it: a person counts at step N
      // only if they also met every step before it. See migration 0014 for why
      // a non-cumulative version can widen.
      funnel30d: (() => {
        const cohort = this.db.users
          .filter((u) => !u.deletedAt && (at(u.createdAt) ?? 0) > since(30))
          .map((u) => {
            const profile = this.db.caregivers.find((c) => c.userId === u.id && !c.deletedAt);
            const fams = new Set(this.db.members.filter((m) => m.userId === u.id).map((m) => m.familyId));
            return {
              verified: Boolean(u.emailVerifiedAt),
              hasProfile: Boolean(profile),
              onboarded: profile?.onboardingStage === 'complete',
              inFamily: fams.size > 0,
              familyAsked: this.db.requests.some((r) => fams.has(r.familyId)),
            };
          });
        const upTo = (pred: (c: (typeof cohort)[number]) => boolean) => cohort.filter(pred).length;
        return {
          accountsCreated: cohort.length,
          verifiedEmail: upTo((c) => c.verified),
          startedOnboarding: upTo((c) => c.verified && c.hasProfile),
          joinedAFamily: upTo((c) => c.verified && c.hasProfile && c.inFamily),
          finishedOnboarding: upTo((c) => c.verified && c.hasProfile && c.inFamily && c.onboarded),
          familySentRequest: upTo((c) => c.verified && c.hasProfile && c.inFamily && c.onboarded && c.familyAsked),
        };
      })(),
      active: {
        seen24h: this.db.users.filter((u) => !u.deletedAt && (at(u.lastSeenAt) ?? 0) > since(1)).length,
        seen7d: this.db.users.filter((u) => !u.deletedAt && (at(u.lastSeenAt) ?? 0) > since(7)).length,
        accountsTotal: this.db.users.filter((u) => !u.deletedAt).length,
      },
      content: {
        storiesTotal: this.db.stories.filter((s2) => !s2.deletedAt).length,
        storiesApproved: this.db.stories.filter((s2) => !s2.deletedAt && s2.status === 'approved').length,
        storiesDraft: this.db.stories.filter((s2) => !s2.deletedAt && s2.status === 'draft').length,
        routinesTotal: this.db.routines.filter((r) => !r.deletedAt).length,
      },
      // Mirrors the SQL: below the threshold a per-type breakdown describes one
      // child's day rather than a population, so it is withheld entirely.
      requestsByType7d: families >= OPERATOR_TYPE_BREAKDOWN_MIN_FAMILIES
        ? tally(week, (r) => r.typeSlug)
        : null,
      typeBreakdownThreshold: OPERATOR_TYPE_BREAKDOWN_MIN_FAMILIES,
    };
  }

  // -- data rights ----------------------------------------------------------

  async exportFamilyData(familyId: string): Promise<unknown> {
    this.requirePermission(familyId, 'can_export_data');
    const childIds = this.db.children.filter((c) => c.familyId === familyId).map((c) => c.id);
    const out = {
      exportedAt: nowIso(),
      family: this.db.families.find((f) => f.id === familyId),
      caregivers: this.db.members.filter((m) => m.familyId === familyId).map((m) => ({
        caregiverName: this.caregiverNameOf(m.userId), role: m.role, joinedAt: m.joinedAt, revokedAt: m.revokedAt,
      })),
      children: this.db.children.filter((c) => c.familyId === familyId),
      childPreferences: this.db.preferences.filter((p) => p.familyId === familyId),
      communicationMethods: this.db.communicationMethods.filter((m) => childIds.includes(m.childId)),
      sensoryPreferences: this.db.sensoryPreferences.filter((s) => childIds.includes(s.childId)),
      trustedCaregivers: this.db.trusted.filter((t) => t.familyId === familyId),
      escalationRules: this.escalationRulesTable.filter((r) => childIds.includes(r.childId)),
      requests: this.db.requests.filter((r) => r.familyId === familyId),
      requestResponses: this.db.responses.filter((r) => this.db.requests.some((q) => q.id === r.requestId && q.familyId === familyId)),
      requestEvents: this.db.events.filter((e) => this.db.requests.some((q) => q.id === e.requestId && q.familyId === familyId)),
      routines: this.db.routines.filter((r) => r.familyId === familyId),
      routineSteps: this.db.routineSteps.filter((s) => this.db.routines.some((r) => r.id === s.routineId && r.familyId === familyId)),
      routineRuns: this.db.routineRuns.filter((r) => childIds.includes(r.childId)),
      stories: this.db.stories.filter((s) => s.familyId === familyId),
      storyPages: this.db.storyPages.filter((p) => this.db.stories.some((s) => s.id === p.storyId && s.familyId === familyId)),
      storyVersions: this.db.storyVersions.filter((v) => v.familyId === familyId),
      auditEvents: this.db.audit.filter((a) => a.familyId === familyId),
    };
    this.audit(familyId, 'data.exported', 'family', familyId, {});
    this.commit();
    return out;
  }

  async requestDeletion(scope: 'account' | 'child' | 'family', opts?: { familyId?: string; childId?: string }): Promise<string> {
    const user = this.requireUser();
    if (scope === 'child') {
      if (!opts?.childId) throw new KindlyError('CHILD_REQUIRED', 'Please choose which child profile to delete.');
      const familyId = this.familyOfChild(opts.childId);
      this.requirePermission(familyId, 'can_manage_children');
      const child = this.db.children.find((c) => c.id === opts.childId)!;
      child.deletedAt = nowIso();
      for (const s of this.db.childSessions) if (s.childId === child.id && s.state === 'active') s.state = 'revoked';
      this.audit(familyId, 'data.deletion_requested', 'child_profile', child.id, { scope });
    } else if (scope === 'family') {
      if (!opts?.familyId) throw new KindlyError('FAMILY_REQUIRED', 'Please choose which family space to delete.');
      const member = this.memberOf(opts.familyId);
      if (member.role !== 'owner') throw new KindlyError('NOT_PERMITTED', 'Only a family owner can delete a family space.');
      this.db.families.find((f) => f.id === opts.familyId)!.deletedAt = nowIso();
      this.audit(opts.familyId, 'data.deletion_requested', 'family', opts.familyId, { scope });
    } else {
      this.db.users.find((u) => u.id === user.id)!.deletedAt = nowIso();
      this.audit(null, 'data.deletion_requested', 'user', user.id, { scope });
    }
    this.commit();
    if (scope === 'account') await this.signOut();
    return uid();
  }
}

export const memoryBackend = new MemoryBackend();
