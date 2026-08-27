import type {
  AppNotification, AuthUser, CaregiverProfile, ChildPreferences, ChildProfile, ChildSession,
  ChildSpace, CommunicationMethod, EscalationRule, Family, FamilyMember, HelpRequest,
  MediaAsset, RequestBundle, RequestType, Routine, RoutineRun, RoutineStepState,
  SensoryPreference, Story, StoryFeedback, StoryVersion, TrustedCaregiver, Urgency,
} from '../types';
import type { ResponseKind } from '../requests/stateMachine';

/**
 * The one interface the whole frontend talks to.
 *
 * Two implementations exist:
 *   - SupabaseBackend: the production path. Every method is a PostgREST select
 *     or an RPC call to one of the SECURITY DEFINER functions in
 *     supabase/migrations. Nothing is trusted to the client.
 *   - MemoryBackend: a deterministic in-process implementation with identical
 *     semantics, used by unit tests and by the end-to-end suite so CI never
 *     depends on a live project. It enforces the same authorization rules so
 *     that a test which passes against it is testing real behaviour.
 *
 * No implementation may use localStorage as the source of truth for accounts,
 * profiles, requests, stories, routines or safety settings.
 */

export interface Workspace {
  user: AuthUser;
  caregiver: CaregiverProfile | null;
  families: Family[];
  /** The family currently in context. */
  activeFamilyId: string | null;
  members: FamilyMember[];
  children: ChildProfile[];
  preferences: Record<string, ChildPreferences>;
  communicationMethods: Record<string, CommunicationMethod[]>;
  sensoryPreferences: Record<string, SensoryPreference[]>;
  trustedCaregivers: Record<string, TrustedCaregiver[]>;
  escalationRules: Record<string, EscalationRule[]>;
  requestTypes: RequestType[];
  adultVerification: { mode: 'pin' | 'device_biometric' | 'none'; isConfigured: boolean };
  pendingInvitations: { id: string; familyName: string; role: string; invitedEmail: string }[];
}

export interface SignUpResult {
  needsEmailVerification: boolean;
  user: AuthUser | null;
}

export type Unsubscribe = () => void;

export interface RoutineInput {
  id?: string;
  childId: string;
  title: string;
  description?: string | null;
  iconKey?: string | null;
  colorKey?: Routine['colorKey'];
  scheduleLabel?: string | null;
  scheduleDays?: number[] | null;
  scheduleTime?: string | null;
  allowReorder?: boolean;
  allowSkip?: boolean;
  transitionWarningSeconds?: number;
  steps: {
    id?: string;
    title: string;
    detail?: string | null;
    pictogramKey?: string | null;
    photoMediaId?: string | null;
    audioMediaId?: string | null;
    estimatedSeconds?: number | null;
    isOptional?: boolean;
    plansChangedNote?: string | null;
  }[];
}

export interface StoryDraftInput {
  childId: string;
  title: string;
  scenarioKey: string;
  source: 'manual' | 'generated';
  format: Story['format'];
  person: Story['person'];
  readingLevel: Story['readingLevel'];
  inputs?: Record<string, unknown>;
  pages: {
    id?: string;
    sectionKey: Story['pages'][number]['sectionKey'];
    heading?: string | null;
    body: string;
    certainty: 'fact' | 'possibility' | 'choice';
    pictogramKey?: string | null;
    imageMediaId?: string | null;
    audioMediaId?: string | null;
    altText?: string | null;
  }[];
  generation?: { model: string; promptVersion: string; generatedAt: string } | null;
}

export interface GeneratedStory {
  title: string;
  pages: { sectionKey: string; heading: string | null; body: string; certainty: 'fact' | 'possibility' | 'choice'; position: number }[];
  provenance: { model: string; promptVersion: string; generatedAt: string };
}

export interface KindlyBackend {
  readonly kind: 'supabase' | 'memory';

  // -- authentication ------------------------------------------------------
  getCurrentUser(): Promise<AuthUser | null>;
  onAuthStateChange(cb: (user: AuthUser | null) => void): Unsubscribe;
  signUp(email: string, password: string): Promise<SignUpResult>;
  signIn(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
  resendVerificationEmail(email: string): Promise<void>;

  // -- workspace -----------------------------------------------------------
  loadWorkspace(activeFamilyId?: string | null): Promise<Workspace>;
  bootstrapFamily(input: {
    caregiverName: string; childName: string; familyName?: string | null;
    trustedCaregiverName?: string | null; pin?: string | null;
  }): Promise<{ familyId: string; childId: string }>;
  saveOnboardingDraft(stage: CaregiverProfile['onboardingStage'], data: Record<string, unknown>): Promise<void>;
  updateCaregiverProfile(input: { caregiverName: string; pronouns?: string | null; relationshipLabel?: string | null }): Promise<void>;

  // -- children ------------------------------------------------------------
  addChild(familyId: string, input: { childName: string; pronouns?: string | null }): Promise<ChildProfile>;
  updateChild(childId: string, input: Partial<Pick<ChildProfile, 'childName' | 'pronouns' | 'safeAdult' | 'safePlace' | 'emergencyInstructions'>>): Promise<void>;
  archiveChild(childId: string, archived: boolean): Promise<void>;
  updateChildPreferences(childId: string, prefs: Partial<ChildPreferences>): Promise<void>;
  setCommunicationMethods(childId: string, methods: Omit<CommunicationMethod, 'id' | 'childId'>[]): Promise<void>;
  setSensoryPreferences(childId: string, items: Omit<SensoryPreference, 'id' | 'childId'>[]): Promise<void>;
  saveEscalationRules(childId: string, rules: Omit<EscalationRule, 'id' | 'childId'>[]): Promise<void>;

  // -- caregivers ----------------------------------------------------------
  upsertTrustedCaregiver(input: Omit<TrustedCaregiver, 'id' | 'familyId'> & { id?: string }): Promise<void>;
  removeTrustedCaregiver(id: string): Promise<void>;
  inviteCaregiver(familyId: string, input: { email: string; role: 'caregiver' | 'trusted' | 'view_only'; invitedName?: string | null; message?: string | null }): Promise<{ invitationId: string; token: string }>;
  listInvitations(familyId: string): Promise<{ id: string; invitedEmail: string; role: string; status: string; expiresAt: string }[]>;
  revokeInvitation(invitationId: string): Promise<void>;
  acceptInvitation(token: string): Promise<{ familyId: string }>;
  revokeCaregiverAccess(familyId: string, userId: string): Promise<void>;
  updateCaregiverRole(familyId: string, userId: string, role: FamilyMember['role']): Promise<void>;

  // -- adult verification --------------------------------------------------
  setCaregiverPin(familyId: string, pin: string): Promise<void>;
  verifyCaregiverPin(familyId: string, pin: string): Promise<{ ok: boolean; lockedUntil?: string; attemptsRemaining?: number; mode: string }>;
  setAdultVerificationMode(familyId: string, mode: 'pin' | 'device_biometric' | 'none'): Promise<void>;

  // -- requests (caregiver side) -------------------------------------------
  listRequests(familyId: string): Promise<RequestBundle[]>;
  getRequest(requestId: string): Promise<RequestBundle>;
  respondToRequest(input: { requestId: string; kind: ResponseKind; delayMinutes?: number | null; message?: string | null; urgency: Urgency }): Promise<HelpRequest>;
  claimRequest(requestId: string): Promise<HelpRequest>;
  escalateRequest(requestId: string, trustedCaregiverId?: string | null): Promise<HelpRequest>;
  resolveRequest(requestId: string, confirmUrgent: boolean): Promise<HelpRequest>;
  cancelRequestAsCaregiver(requestId: string, reason?: string): Promise<HelpRequest>;
  tickEscalations(familyId: string): Promise<number>;
  subscribeToFamily(familyId: string, cb: () => void): Unsubscribe;

  // -- child session -------------------------------------------------------
  startChildSession(childId: string, deviceLabel?: string): Promise<ChildSession>;
  endChildSession(token: string): Promise<void>;
  childGetSpace(token: string): Promise<ChildSpace>;
  childGetRequests(token: string): Promise<RequestBundle[]>;
  childCreateRequest(token: string, input: {
    typeSlug: string; dedupeKey: string; customMessage?: string | null;
    connectionState?: 'online' | 'offline' | 'unknown'; labelOverride?: string | null; detailOverride?: string | null;
  }): Promise<HelpRequest>;
  childSendRequest(token: string, requestId: string, connectionState?: 'online' | 'offline' | 'unknown'): Promise<HelpRequest>;
  childCancelRequest(token: string, requestId: string): Promise<HelpRequest>;
  childResolveRequest(token: string, requestId: string): Promise<HelpRequest>;
  childGetStories(token: string): Promise<{ id: string; title: string; scenarioKey: string; format: string; lastPage: number; pages: { position: number; sectionKey: string; heading: string | null; body: string; certainty: string; pictogramKey: string | null; altText: string | null }[] }[]>;
  childSetStoryProgress(token: string, storyId: string, page: number): Promise<void>;
  childSendStoryFeedback(token: string, storyId: string, kind: StoryFeedback['kind'], pagePosition?: number | null): Promise<void>;
  childGetRoutines(token: string): Promise<Routine[]>;
  subscribeToChild(childId: string, cb: () => void): Unsubscribe;

  // -- routines ------------------------------------------------------------
  listRoutines(childId: string): Promise<Routine[]>;
  saveRoutine(input: RoutineInput): Promise<Routine>;
  duplicateRoutine(routineId: string): Promise<Routine>;
  archiveRoutine(routineId: string, archived: boolean): Promise<void>;
  deleteRoutine(routineId: string): Promise<void>;
  reorderRoutines(childId: string, orderedIds: string[]): Promise<void>;
  startRoutineRun(routineId: string, by: 'child' | 'caregiver', childSessionToken?: string): Promise<RoutineRun>;
  setRoutineStepState(runId: string, stepId: string, state: RoutineStepState): Promise<RoutineRun>;
  setRoutineRunStatus(runId: string, status: RoutineRun['status']): Promise<RoutineRun>;
  getActiveRoutineRun(routineId: string): Promise<RoutineRun | null>;

  // -- stories -------------------------------------------------------------
  listStories(childId: string): Promise<Story[]>;
  getStory(storyId: string): Promise<Story>;
  saveStoryDraft(input: StoryDraftInput & { id?: string }): Promise<Story>;
  approveStory(storyId: string, acknowledgeFlags: boolean): Promise<Story>;
  assignStory(storyId: string, childId: string): Promise<void>;
  withdrawStory(storyId: string, childId: string): Promise<void>;
  archiveStory(storyId: string, archived: boolean): Promise<void>;
  deleteStory(storyId: string): Promise<void>;
  duplicateStory(storyId: string): Promise<Story>;
  /**
   * Asks the generation service for a draft. Throws a KindlyError when the
   * service is unavailable, declined, or failed — the caller falls back to the
   * built-in builder, which is a complete feature rather than a degraded one.
   */
  generateStory(childId: string, input: Record<string, unknown>): Promise<GeneratedStory>;
  listStoryVersions(storyId: string): Promise<StoryVersion[]>;
  listStoryFeedback(familyId: string): Promise<StoryFeedback[]>;
  markStoryFeedbackSeen(feedbackId: string): Promise<void>;

  // -- notifications -------------------------------------------------------
  listNotifications(familyId: string): Promise<AppNotification[]>;
  markNotificationsRead(ids?: string[]): Promise<void>;

  // -- media ---------------------------------------------------------------
  listMedia(familyId: string): Promise<MediaAsset[]>;
  uploadMedia(input: { familyId: string; childId?: string | null; kind: MediaAsset['kind']; file: File; altText: string; caption?: string | null }): Promise<MediaAsset>;
  getSignedMediaUrl(mediaId: string): Promise<string>;
  deleteMedia(mediaId: string): Promise<void>;

  // -- data rights ---------------------------------------------------------
  exportFamilyData(familyId: string): Promise<unknown>;
  requestDeletion(scope: 'account' | 'child' | 'family', opts?: { familyId?: string; childId?: string }): Promise<string>;
}
