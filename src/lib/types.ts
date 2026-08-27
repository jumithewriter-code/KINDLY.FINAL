import type { RequestStatus, ResponseKind, Urgency } from './requests/stateMachine';

export type { RequestStatus, ResponseKind, Urgency };

export type FamilyRole = 'owner' | 'caregiver' | 'trusted' | 'view_only';

export interface Permissions {
  can_answer_requests: boolean;
  can_edit_routines: boolean;
  can_edit_stories: boolean;
  can_approve_stories: boolean;
  can_manage_children: boolean;
  can_manage_caregivers: boolean;
  can_manage_safety: boolean;
  can_export_data: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface CaregiverProfile {
  id: string;
  userId: string;
  /** The adult's own name. Never a child name, never a placeholder. */
  caregiverName: string;
  pronouns: string | null;
  relationshipLabel: string | null;
  onboardingStage: 'names' | 'preferences' | 'safety' | 'notifications' | 'complete';
  onboardingData: Record<string, unknown>;
}

export interface Family {
  id: string;
  familyName: string;
  emergencyInstructions: string | null;
  emergencyServicesNote: string;
}

export interface FamilyMember {
  userId: string;
  familyId: string;
  role: FamilyRole;
  permissions: Permissions;
  /** The member's own caregiver name, read from their caregiver profile. */
  caregiverName: string;
  email: string | null;
  joinedAt: string;
  revokedAt: string | null;
  isSelf: boolean;
}

export interface ChildProfile {
  id: string;
  familyId: string;
  /** The child's own name. */
  childName: string;
  pronouns: string | null;
  safeAdult: string | null;
  safePlace: string | null;
  emergencyInstructions: string | null;
  archivedAt: string | null;
}

export interface TrustedCaregiver {
  id: string;
  familyId: string;
  childId: string;
  userId: string | null;
  /** The third, separate name field. */
  trustedCaregiverName: string;
  relationshipLabel: string | null;
  escalationOrder: number;
  isActive: boolean;
}

export interface ChildPreferences {
  childId: string;
  familyId: string;
  textScale: number;
  highContrast: boolean;
  lowStimulation: boolean;
  symbolSystem: 'kindly_default' | 'photos' | 'custom' | 'pcs_like' | 'arasaac_like' | 'text_only';
  pairTextWithSymbols: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  animationEnabled: boolean;
  countdownsVisible: boolean;
  readAloudEnabled: boolean;
  readAloudRate: number;
  processingTimeSeconds: number;
  transitionWarnings: boolean;
  escalationDelaySeconds: number;
  unavailableDelaySeconds: number;
  bathroomUrgency: Urgency;
  allowCustomMessage: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursAllowUrgent: boolean;
}

export interface CommunicationMethod {
  id: string;
  childId: string;
  method:
    | 'spoken_words' | 'written_words' | 'pictograms' | 'photos' | 'gestures'
    | 'sign_language' | 'aac_device' | 'typing' | 'yes_no_choices' | 'other';
  label: string;
  detail: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface SensoryPreference {
  id: string;
  childId: string;
  category: 'sound' | 'light' | 'touch' | 'movement' | 'smell' | 'taste' | 'crowding' | 'temperature' | 'other';
  kind: 'helps' | 'hard';
  label: string;
  detail: string | null;
  sortOrder: number;
}

export interface EscalationRule {
  id: string;
  childId: string;
  appliesToUrgency: Urgency | null;
  stepOrder: number;
  action: 'notify_assigned' | 'notify_trusted' | 'notify_all_caregivers' | 'show_offline_help';
  trustedCaregiverId: string | null;
  afterSeconds: number;
  isActive: boolean;
}

export interface RequestType {
  slug: string;
  childFacingLabel: string;
  childFacingDetail: string | null;
  urgency: Urgency;
  pictogramKey: string | null;
  pictogramMediaId: string | null;
  colorKey: 'coral' | 'blue' | 'purple' | 'yellow' | 'mint' | 'peach';
  sortOrder: number;
}

export interface HelpRequest {
  id: string;
  familyId: string;
  childId: string;
  childSessionId: string | null;
  typeSlug: string;
  childFacingLabel: string;
  childFacingDetail: string | null;
  urgency: Urgency;
  pictogramKey: string | null;
  pictogramMediaId: string | null;
  customMessage: string | null;
  status: RequestStatus;
  createdAt: string;
  sendingStartedAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  waitingSince: string | null;
  escalatedAt: string | null;
  unavailableAt: string | null;
  assignedToUserId: string | null;
  assignedToTrustedId: string | null;
  assignedToName: string | null;
  attempts: number;
  failureReason: 'offline' | 'interrupted' | 'server_error' | 'timeout' | null;
  cancelledBy: 'child' | 'caregiver' | 'system' | null;
  deviceLabel: string | null;
  connectionState: 'online' | 'offline' | 'unknown' | null;
  /** Idempotency key for the tap-intent that created this request. */
  clientDedupeKey: string | null;
  lockVersion: number;
  updatedAt: string;
}

export interface RequestResponse {
  id: string;
  requestId: string;
  kind: ResponseKind;
  delayMinutes: number | null;
  dueAt: string | null;
  message: string | null;
  responderUserId: string | null;
  responderTrustedId: string | null;
  /** Snapshot of the responder's name at the time they answered. */
  responderName: string;
  isCurrent: boolean;
  createdAt: string;
}

export interface RequestEvent {
  id: number;
  requestId: string;
  kind: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus | null;
  actorKind: 'child' | 'caregiver' | 'system';
  actorName: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface RequestBundle {
  request: HelpRequest;
  response: RequestResponse | null;
  events: RequestEvent[];
}

export interface RoutineStep {
  id: string;
  routineId: string;
  position: number;
  title: string;
  detail: string | null;
  pictogramKey: string | null;
  photoMediaId: string | null;
  audioMediaId: string | null;
  estimatedSeconds: number | null;
  isOptional: boolean;
  plansChangedNote: string | null;
}

export interface Routine {
  id: string;
  familyId: string;
  childId: string;
  title: string;
  description: string | null;
  iconKey: string | null;
  colorKey: 'coral' | 'blue' | 'purple' | 'yellow' | 'mint' | 'peach';
  scheduleLabel: string | null;
  scheduleDays: number[] | null;
  scheduleTime: string | null;
  allowReorder: boolean;
  allowSkip: boolean;
  transitionWarningSeconds: number;
  sortOrder: number;
  archivedAt: string | null;
  steps: RoutineStep[];
}

export type RoutineRunStatus = 'running' | 'paused' | 'finished' | 'abandoned' | 'plans_changed';
export type RoutineStepState = 'pending' | 'done' | 'skipped' | 'changed';

export interface RoutineRun {
  id: string;
  routineId: string;
  childId: string;
  status: RoutineRunStatus;
  currentStepId: string | null;
  stepStates: { stepId: string; state: RoutineStepState; at: string }[];
  startedAt: string;
  pausedAt: string | null;
  finishedAt: string | null;
  plansChangedAt: string | null;
}

export type StoryStatus = 'draft' | 'in_review' | 'approved' | 'archived';
export type StoryFormat = 'text' | 'pictogram' | 'photo' | 'audio' | 'mixed';
export type StoryPerson = 'first_person' | 'third_person';
export type StorySectionKey =
  | 'title' | 'situation' | 'where_when' | 'who' | 'what_you_may_notice'
  | 'what_may_change' | 'feelings' | 'choices' | 'sensory_options'
  | 'asking_for_help' | 'afterwards' | 'ending' | 'custom';

export interface StoryPage {
  id: string;
  storyId: string;
  position: number;
  sectionKey: StorySectionKey;
  heading: string | null;
  body: string;
  /** Keeps facts and possibilities visibly separate for the reader. */
  certainty: 'fact' | 'possibility' | 'choice';
  pictogramKey: string | null;
  imageMediaId: string | null;
  audioMediaId: string | null;
  altText: string | null;
  reviewFlags: ReviewFlag[];
}

export interface ReviewFlag {
  rule: string;
  severity: 'block' | 'warn' | 'info';
  note: string;
  excerpt?: string;
  pagePosition?: number;
}

export interface Story {
  id: string;
  familyId: string;
  childId: string;
  title: string;
  scenarioKey: string;
  status: StoryStatus;
  source: 'manual' | 'generated';
  format: StoryFormat;
  person: StoryPerson;
  readingLevel: 'pre_reader' | 'simple' | 'developing' | 'confident';
  targetPageCount: number;
  inputs: Record<string, unknown>;
  generationModel: string | null;
  generationPromptVersion: string | null;
  generatedAt: string | null;
  generationError: string | null;
  reviewFlags: ReviewFlag[];
  requiresSafetyReview: boolean;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  archivedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  pages: StoryPage[];
  assignedChildIds: string[];
}

export interface StoryVersion {
  id: string;
  storyId: string;
  familyId: string;
  version: number;
  changeNote: string | null;
  createdByName: string | null;
  createdAt: string;
  snapshot: unknown;
}

export interface StoryFeedback {
  id: string;
  storyId: string;
  childId: string;
  pagePosition: number | null;
  kind: 'this_is_different' | 'i_have_a_question' | 'i_need_a_break' | 'i_do_not_want_this_story';
  createdAt: string;
  seenAt: string | null;
}

export interface AppNotification {
  id: string;
  familyId: string;
  kind: string;
  title: string;
  body: string | null;
  requestId: string | null;
  storyId: string | null;
  childId: string | null;
  route: string | null;
  isUrgent: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface ChildSession {
  sessionId: string;
  sessionToken: string;
  childId: string;
  familyId: string;
  expiresAt: string;
}

export interface ChildSpace {
  child: {
    id: string;
    childName: string;
    pronouns: string | null;
    safeAdult: string | null;
    safePlace: string | null;
    emergencyInstructions: string | null;
  };
  preferences: ChildPreferences;
  requestTypes: RequestType[];
  trustedCaregivers: { trustedCaregiverName: string; escalationOrder: number }[];
  session: { id: string; childId: string; expiresAt: string };
}

export interface FeelingOption {
  key: string;
  label: string;
  detail: string | null;
  pictogramKey: string;
  colorKey: 'coral' | 'blue' | 'purple' | 'yellow' | 'mint' | 'peach';
  /** Body sensations are offered alongside feelings, never instead of them. */
  group: 'feeling' | 'body' | 'unsure';
}

export interface MediaAsset {
  id: string;
  familyId: string;
  childId: string | null;
  kind: 'pictogram' | 'photo' | 'audio' | 'other';
  storagePath: string;
  mimeType: string;
  altText: string;
  caption: string | null;
  createdAt: string;
}

/** A typed error every backend method rejects with, so the UI can be specific. */
export class KindlyError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, opts?: { detail?: string; retryable?: boolean }) {
    super(message);
    this.name = 'KindlyError';
    this.code = code;
    this.detail = opts?.detail;
    this.retryable = opts?.retryable ?? false;
  }
}
