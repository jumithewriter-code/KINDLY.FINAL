/**
 * SupabaseBackend — the production data path.
 *
 * Every read goes through PostgREST with Row Level Security applied, and every
 * write that changes a request, a child session, an invitation, a PIN or a
 * story's approval goes through a SECURITY DEFINER function. The client is
 * never trusted to set `delivered_at`, to decide who owns a request, or to put
 * a story in front of a child.
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';
import {
  KindlyError,
  type AppNotification, type AuthUser, type CaregiverProfile, type ChildPreferences,
  type ChildProfile, type ChildSession, type ChildSpace, type CommunicationMethod,
  type EscalationRule, type FamilyMember, type HelpRequest, type MediaAsset,
  type RequestBundle, type RequestEvent, type RequestResponse, type RequestType,
  type Routine, type RoutineRun, type RoutineStep, type RoutineStepState,
  type SensoryPreference, type Story, type StoryFeedback, type StoryPage,
  type StoryVersion, type TrustedCaregiver, type Urgency,
} from '../types';
import type { ResponseKind } from '../requests/stateMachine';
import type { KindlyBackend, RoutineInput, SignUpResult, StoryDraftInput, Unsubscribe, Workspace } from './types';

// ---------------------------------------------------------------------------
// Error translation: Postgres codes and our own RAISE messages become typed,
// human-readable KindlyErrors so the UI never shows a raw database string.
// ---------------------------------------------------------------------------

const MESSAGES: Record<string, { message: string; retryable?: boolean }> = {
  NOT_AUTHENTICATED: { message: 'Please sign in to continue.' },
  NOT_A_FAMILY_MEMBER: { message: 'You do not have access to this family space.' },
  NOT_PERMITTED: { message: 'Your role does not allow that. Ask a family owner to change your permissions.' },
  NOT_PERMITTED_TO_ANSWER: { message: 'Your role does not allow answering requests.' },
  CAREGIVER_NAME_REQUIRED: { message: 'Please enter a name for yourself.' },
  CHILD_NAME_REQUIRED: { message: 'Please enter your child’s name.' },
  PIN_MUST_BE_4_TO_8_DIGITS: { message: 'Please use between 4 and 8 digits.' },
  PIN_TOO_EASY_TO_GUESS: { message: 'Please choose a code that is harder to guess.' },
  PIN_REQUIRED: { message: 'Please choose a grown-up code. It is what unlocks the caregiver view.' },
  INVALID_VERIFICATION_MODE: { message: 'The grown-up code cannot be switched off.' },
  SET_A_CODE_FIRST: { message: 'Please set a grown-up code before changing how it is checked.' },
  RATE_LIMITED: { message: 'That has been tried too many times. Please wait a little and try again.', retryable: true },
  REQUEST_NOT_FOUND: { message: 'That request could not be found.' },
  REQUEST_ALREADY_CLOSED: { message: 'This request is already finished.' },
  REQUEST_NOT_DELIVERED_YET: { message: 'This request has not been delivered yet.' },
  REQUEST_ASSIGNED_ELSEWHERE: { message: 'Another caregiver is answering this request. Take it back first so your child does not get two different answers.' },
  URGENT_REQUEST_CANNOT_BE_DELAYED: { message: 'An urgent request cannot be answered with a delay. Choose an action that happens now.' },
  URGENT_RESOLVE_NEEDS_CONFIRMATION: { message: 'Please confirm your child is safe and no longer waiting.' },
  NO_TRUSTED_CAREGIVER_CONFIGURED: { message: 'No trusted caregiver has been added for this child yet.' },
  DELAY_MINUTES_OUT_OF_RANGE: { message: 'Please choose between 1 and 120 minutes.' },
  CHILD_SESSION_INVALID: { message: 'This child session is no longer valid. Ask a grown-up to start it again.' },
  CHILD_SESSION_EXPIRED: { message: 'This child session has ended. Ask a grown-up to start it again.' },
  CHILD_SESSION_ENDED: { message: 'This child session has ended. Ask a grown-up to start it again.' },
  CHILD_SESSION_REVOKED: { message: 'This child session was ended by a caregiver.' },
  CHILD_ACTION_NOT_PERMITTED: { message: 'That is not something this session can do.' },
  STORY_NOT_APPROVED: { message: 'Only an approved story can be given to a child.' },
  STORY_HAS_UNREVIEWED_FLAGS: { message: 'Please read the highlighted parts and confirm before approving.' },
  STORY_TOO_SHORT: { message: 'A story needs at least three pages.' },
  CANNOT_REMOVE_LAST_OWNER: { message: 'A family space must always have at least one owner.' },
  INVITATION_NOT_FOUND: { message: 'That invitation link is not valid.' },
  INVITATION_EXPIRED: { message: 'That invitation has expired. Ask for a new one.' },
  INVITATION_EMAIL_MISMATCH: { message: 'This invitation was sent to a different email address.' },
  INVALID_TRANSITION: { message: 'That is not possible from the current state. Refresh to see the latest.' },
};

function translate(error: unknown, fallback: string): KindlyError {
  if (error instanceof KindlyError) return error;
  const raw = error as { message?: string; code?: string; details?: string; status?: number } | null;
  const text = raw?.message ?? '';

  for (const key of Object.keys(MESSAGES)) {
    if (text.includes(key)) {
      const entry = MESSAGES[key]!;
      return new KindlyError(key, entry.message, { detail: raw?.details, retryable: entry.retryable });
    }
  }
  // Supabase Auth reports its own throttling as a 429 with a plain-English
  // message that matches none of the codes above. Without this the caller sees
  // a generic failure and has no idea that waiting would fix it.
  if (raw?.status === 429 || /rate limit/i.test(text)) {
    return new KindlyError(
      'RATE_LIMITED',
      'That has been tried too many times just now. Please wait a few minutes and try again.',
      { retryable: true },
    );
  }
  if (raw?.code === '23505') {
    return new KindlyError('DUPLICATE', 'That already exists. Nothing was created twice.');
  }
  if (raw?.code === '42501' || raw?.status === 401 || raw?.status === 403) {
    return new KindlyError('PERMISSION_DENIED', 'You do not have permission to do that.');
  }
  if (raw?.status === 0 || /fetch|network|Failed to fetch/i.test(text)) {
    return new KindlyError('NETWORK', 'KINDLY could not reach the internet. Your work is safe — try again when you are back online.', { retryable: true });
  }
  return new KindlyError('UNKNOWN', fallback, { detail: text, retryable: true });
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toRequest = (r: Row): HelpRequest => ({
  id: r.id, familyId: r.family_id, childId: r.child_id, childSessionId: r.child_session_id ?? null,
  typeSlug: r.type_slug, childFacingLabel: r.child_facing_label, childFacingDetail: r.child_facing_detail ?? null,
  urgency: r.urgency, pictogramKey: r.pictogram_key ?? null, pictogramMediaId: r.pictogram_media_id ?? null,
  customMessage: r.custom_message ?? null, status: r.status, createdAt: r.created_at,
  sendingStartedAt: r.sending_started_at ?? null, deliveredAt: r.delivered_at ?? null,
  acknowledgedAt: r.acknowledged_at ?? null, resolvedAt: r.resolved_at ?? null,
  cancelledAt: r.cancelled_at ?? null, waitingSince: r.waiting_since ?? null,
  escalatedAt: r.escalated_at ?? null, unavailableAt: r.unavailable_at ?? null,
  assignedToUserId: r.assigned_to_user_id ?? null, assignedToTrustedId: r.assigned_to_trusted_id ?? null,
  assignedToName: r.assigned_to_name ?? null, attempts: r.attempts ?? 0,
  failureReason: r.failure_reason ?? null, cancelledBy: r.cancelled_by ?? null,
  deviceLabel: r.device_label ?? null, connectionState: r.connection_state ?? null,
  clientDedupeKey: r.client_dedupe_key ?? null, lockVersion: r.lock_version ?? 0, updatedAt: r.updated_at,
});

const toResponse = (r: Row): RequestResponse => ({
  id: r.id, requestId: r.request_id, kind: r.kind, delayMinutes: r.delay_minutes ?? null,
  dueAt: r.due_at ?? null, message: r.message ?? null, responderUserId: r.responder_user_id ?? null,
  responderTrustedId: r.responder_trusted_id ?? null, responderName: r.responder_name,
  isCurrent: r.is_current, createdAt: r.created_at,
});

const toEvent = (r: Row): RequestEvent => ({
  id: Number(r.id), requestId: r.request_id, kind: r.kind, fromStatus: r.from_status ?? null,
  toStatus: r.to_status ?? null, actorKind: r.actor_kind, actorName: r.actor_name ?? null,
  detail: r.detail ?? {}, occurredAt: r.occurred_at,
});

const toChild = (r: Row): ChildProfile => ({
  id: r.id, familyId: r.family_id, childName: r.child_name, pronouns: r.pronouns ?? null,
  safeAdult: r.safe_adult ?? null, safePlace: r.safe_place ?? null,
  emergencyInstructions: r.emergency_instructions ?? null, archivedAt: r.archived_at ?? null,
});

const toPreferences = (r: Row): ChildPreferences => ({
  childId: r.child_id, familyId: r.family_id,
  textScale: Number(r.text_scale), highContrast: r.high_contrast, lowStimulation: r.low_stimulation,
  symbolSystem: r.symbol_system, pairTextWithSymbols: r.pair_text_with_symbols,
  soundEnabled: r.sound_enabled, vibrationEnabled: r.vibration_enabled, animationEnabled: r.animation_enabled,
  countdownsVisible: r.countdowns_visible, readAloudEnabled: r.read_aloud_enabled,
  readAloudRate: Number(r.read_aloud_rate), processingTimeSeconds: r.processing_time_seconds,
  transitionWarnings: r.transition_warnings, escalationDelaySeconds: r.escalation_delay_seconds,
  unavailableDelaySeconds: r.unavailable_delay_seconds, bathroomUrgency: r.bathroom_urgency,
  allowCustomMessage: r.allow_custom_message, quietHoursStart: r.quiet_hours_start ?? null,
  quietHoursEnd: r.quiet_hours_end ?? null, quietHoursAllowUrgent: r.quiet_hours_allow_urgent,
});

const prefsToRow = (childId: string, familyId: string, p: Partial<ChildPreferences>): Row => {
  const out: Row = { child_id: childId, family_id: familyId };
  const map: Record<string, string> = {
    textScale: 'text_scale', highContrast: 'high_contrast', lowStimulation: 'low_stimulation',
    symbolSystem: 'symbol_system', pairTextWithSymbols: 'pair_text_with_symbols',
    soundEnabled: 'sound_enabled', vibrationEnabled: 'vibration_enabled', animationEnabled: 'animation_enabled',
    countdownsVisible: 'countdowns_visible', readAloudEnabled: 'read_aloud_enabled', readAloudRate: 'read_aloud_rate',
    processingTimeSeconds: 'processing_time_seconds', transitionWarnings: 'transition_warnings',
    escalationDelaySeconds: 'escalation_delay_seconds', unavailableDelaySeconds: 'unavailable_delay_seconds',
    bathroomUrgency: 'bathroom_urgency', allowCustomMessage: 'allow_custom_message',
    quietHoursStart: 'quiet_hours_start', quietHoursEnd: 'quiet_hours_end',
  };
  for (const [key, column] of Object.entries(map)) {
    const value = (p as Row)[key];
    if (value !== undefined) out[column] = value;
  }
  return out;
};

const toTrusted = (r: Row): TrustedCaregiver => ({
  id: r.id, familyId: r.family_id, childId: r.child_id, userId: r.user_id ?? null,
  trustedCaregiverName: r.trusted_caregiver_name, relationshipLabel: r.relationship_label ?? null,
  escalationOrder: r.escalation_order, isActive: r.is_active,
});

const toRequestType = (r: Row): RequestType => ({
  slug: r.slug, childFacingLabel: r.child_facing_label, childFacingDetail: r.child_facing_detail ?? null,
  urgency: r.urgency, pictogramKey: r.pictogram_key ?? null, pictogramMediaId: r.pictogram_media_id ?? null,
  colorKey: r.color_key, sortOrder: r.sort_order,
});

const toRoutineStep = (r: Row): RoutineStep => ({
  id: r.id, routineId: r.routine_id, position: r.position, title: r.title, detail: r.detail ?? null,
  pictogramKey: r.pictogram_key ?? null, photoMediaId: r.photo_media_id ?? null,
  audioMediaId: r.audio_media_id ?? null, estimatedSeconds: r.estimated_seconds ?? null,
  isOptional: r.is_optional, plansChangedNote: r.plans_changed_note ?? null,
});

const toRoutine = (r: Row): Routine => ({
  id: r.id, familyId: r.family_id, childId: r.child_id, title: r.title, description: r.description ?? null,
  iconKey: r.icon_key ?? null, colorKey: r.color_key, scheduleLabel: r.schedule_label ?? null,
  scheduleDays: r.schedule_days ?? null, scheduleTime: r.schedule_time ?? null,
  allowReorder: r.allow_reorder, allowSkip: r.allow_skip,
  transitionWarningSeconds: r.transition_warning_seconds, sortOrder: r.sort_order,
  archivedAt: r.archived_at ?? null,
  steps: ((r.routine_steps ?? []) as Row[]).map(toRoutineStep).sort((a, b) => a.position - b.position),
});

const toRun = (r: Row): RoutineRun => ({
  id: r.id, routineId: r.routine_id, childId: r.child_id, status: r.status,
  currentStepId: r.current_step_id ?? null,
  stepStates: ((r.step_states ?? []) as Row[]).map((s) => ({ stepId: s.step_id ?? s.stepId, state: s.state, at: s.at })),
  startedAt: r.started_at, pausedAt: r.paused_at ?? null, finishedAt: r.finished_at ?? null,
  plansChangedAt: r.plans_changed_at ?? null,
});

const toStoryPage = (r: Row): StoryPage => ({
  id: r.id, storyId: r.story_id, position: r.position, sectionKey: r.section_key,
  heading: r.heading ?? null, body: r.body, certainty: r.certainty,
  pictogramKey: r.pictogram_key ?? null, imageMediaId: r.image_media_id ?? null,
  audioMediaId: r.audio_media_id ?? null, altText: r.alt_text ?? null, reviewFlags: r.review_flags ?? [],
});

const toStory = (r: Row): Story => ({
  id: r.id, familyId: r.family_id, childId: r.child_id, title: r.title, scenarioKey: r.scenario_key,
  status: r.status, source: r.source, format: r.format, person: r.person, readingLevel: r.reading_level,
  targetPageCount: r.target_page_count, inputs: r.inputs ?? {},
  generationModel: r.generation_model ?? null, generationPromptVersion: r.generation_prompt_version ?? null,
  generatedAt: r.generated_at ?? null, generationError: r.generation_error ?? null,
  reviewFlags: r.review_flags ?? [], requiresSafetyReview: r.requires_safety_review,
  approvedBy: r.approved_by ?? null,
  approvedByName: r.approver?.caregiver_name ?? null,
  approvedAt: r.approved_at ?? null, archivedAt: r.archived_at ?? null, version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at,
  pages: ((r.story_pages ?? []) as Row[]).map(toStoryPage).sort((a, b) => a.position - b.position),
  assignedChildIds: ((r.story_assignments ?? []) as Row[]).filter((a) => !a.withdrawn_at).map((a) => a.child_id),
});

const toNotification = (r: Row): AppNotification => ({
  id: r.id, familyId: r.family_id, kind: r.kind, title: r.title, body: r.body ?? null,
  requestId: r.request_id ?? null, storyId: r.story_id ?? null, childId: r.child_id ?? null,
  route: r.route ?? null, isUrgent: r.is_urgent, readAt: r.read_at ?? null, createdAt: r.created_at,
});

const toMedia = (r: Row): MediaAsset => ({
  id: r.id, familyId: r.family_id, childId: r.child_id ?? null, kind: r.kind,
  storagePath: r.storage_path, mimeType: r.mime_type, altText: r.alt_text,
  caption: r.caption ?? null, createdAt: r.created_at,
});

// ---------------------------------------------------------------------------

export class SupabaseBackend implements KindlyBackend {
  readonly kind = 'supabase' as const;
  private client: SupabaseClient;

  constructor(client?: SupabaseClient) {
    const e = env();
    this.client = client ?? createClient(e.supabaseUrl, e.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }

  private async rpc<T>(name: string, args: Row, fallback: string): Promise<T> {
    const { data, error } = await this.client.rpc(name, args);
    if (error) throw translate(error, fallback);
    return data as T;
  }

  private unwrap<T>(result: { data: T | null; error: unknown }, fallback: string): T {
    if (result.error) throw translate(result.error, fallback);
    return result.data as T;
  }

  // -- authentication -------------------------------------------------------

  async getCurrentUser(): Promise<AuthUser | null> {
    const { data } = await this.client.auth.getUser();
    const u = data.user;
    if (!u) return null;
    return { id: u.id, email: u.email ?? '', emailVerified: Boolean(u.email_confirmed_at) };
  }

  onAuthStateChange(cb: (user: AuthUser | null) => void): Unsubscribe {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      cb(u ? { id: u.id, email: u.email ?? '', emailVerified: Boolean(u.email_confirmed_at) } : null);
    });
    return () => data.subscription.unsubscribe();
  }

  async signUp(email: string, password: string): Promise<SignUpResult> {
    const { data, error } = await this.client.auth.signUp({
      email, password,
      options: { emailRedirectTo: `${env().siteUrl}/auth/callback` },
    });
    if (error) {
      if (/already registered|already exists/i.test(error.message)) {
        throw new KindlyError('EMAIL_ALREADY_REGISTERED', 'An account already exists for that email address. Try signing in instead.');
      }
      throw translate(error, 'Your account could not be created. Please try again.');
    }
    const u = data.user;
    return {
      needsEmailVerification: !data.session,
      user: u ? { id: u.id, email: u.email ?? email, emailVerified: Boolean(u.email_confirmed_at) } : null,
    };
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      if (/invalid login credentials/i.test(error.message)) {
        // Identical message for wrong password and unknown account.
        throw new KindlyError('INVALID_CREDENTIALS', 'That email address and password do not match. Please try again.');
      }
      if (/email not confirmed/i.test(error.message)) {
        throw new KindlyError('EMAIL_NOT_VERIFIED', 'Please confirm your email address first. Check your inbox for the link.');
      }
      throw translate(error, 'You could not be signed in. Please try again.');
    }
    const u = data.user!;
    return { id: u.id, email: u.email ?? email, emailVerified: Boolean(u.email_confirmed_at) };
  }

  async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) throw translate(error, 'You could not be signed out. Please try again.');
  }

  async sendPasswordReset(email: string): Promise<void> {
    // Supabase answers 200 for an address it does not know, so surfacing the
    // error here still never reveals whether an account exists. What it does
    // reveal is that nothing was sent at all — a rate limit or an SMTP failure
    // — which the caller previously swallowed, leaving people staring at an
    // inbox that was never going to receive anything.
    const { error } = await this.client.auth.resetPasswordForEmail(
      email, { redirectTo: `${env().siteUrl}/auth/reset` },
    );
    if (error) throw translate(error, 'That reset email could not be sent. Please try again in a few minutes.');
  }

  async updatePassword(newPassword: string): Promise<void> {
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw translate(error, 'Your password could not be changed. Please try again.');
  }

  async resendVerificationEmail(email: string): Promise<void> {
    const { error } = await this.client.auth.resend({
      type: 'signup', email, options: { emailRedirectTo: `${env().siteUrl}/auth/callback` },
    });
    if (error) throw translate(error, 'That email could not be sent again. Please try again in a few minutes.');
  }

  // -- workspace ------------------------------------------------------------

  async loadWorkspace(activeFamilyId?: string | null): Promise<Workspace> {
    const user = await this.getCurrentUser();
    if (!user) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in to continue.');

    const caregiverRow = this.unwrap(
      await this.client.from('caregiver_profiles').select('*').eq('user_id', user.id).maybeSingle(),
      'Your profile could not be loaded.',
    ) as Row | null;

    const caregiver: CaregiverProfile | null = caregiverRow
      ? {
          id: caregiverRow.id, userId: caregiverRow.user_id, caregiverName: caregiverRow.caregiver_name,
          pronouns: caregiverRow.pronouns ?? null, relationshipLabel: caregiverRow.relationship_label ?? null,
          onboardingStage: caregiverRow.onboarding_stage, onboardingData: caregiverRow.onboarding_data ?? {},
        }
      : null;

    const familyRows = (this.unwrap(
      await this.client.from('families').select('*').is('deleted_at', null).order('created_at'),
      'Your family spaces could not be loaded.',
    ) ?? []) as Row[];

    const families = familyRows.map((f) => ({
      id: f.id, familyName: f.family_name,
      emergencyInstructions: f.emergency_instructions ?? null,
      emergencyServicesNote: f.emergency_services_note,
    }));

    const familyId = activeFamilyId && families.some((f) => f.id === activeFamilyId)
      ? activeFamilyId
      : families[0]?.id ?? null;

    const empty: Workspace = {
      user, caregiver, families, activeFamilyId: familyId, members: [], children: [],
      preferences: {}, communicationMethods: {}, sensoryPreferences: {}, trustedCaregivers: {},
      escalationRules: {}, requestTypes: [], adultVerification: { mode: 'pin', isConfigured: false },
      pendingInvitations: [],
    };
    if (!familyId) return empty;

    const [memberRows, childRows, prefRows, commRows, sensoryRows, trustedRows, escalationRows, typeRows, inviteRows, verificationRow] =
      await Promise.all([
        this.client.from('family_members').select('*').eq('family_id', familyId),
        this.client.from('child_profiles').select('*').eq('family_id', familyId).is('deleted_at', null).order('created_at'),
        this.client.from('child_preferences').select('*').eq('family_id', familyId),
        this.client.from('communication_methods').select('*').eq('family_id', familyId).is('deleted_at', null).order('sort_order'),
        this.client.from('sensory_preferences').select('*').eq('family_id', familyId).is('deleted_at', null).order('sort_order'),
        this.client.from('trusted_caregivers').select('*').eq('family_id', familyId).is('deleted_at', null).order('escalation_order'),
        this.client.from('escalation_rules').select('*').eq('family_id', familyId).order('step_order'),
        this.client.from('request_types').select('*').is('deleted_at', null).eq('is_active', true).order('sort_order'),
        this.client.from('caregiver_invitations').select('*, families(family_name)').eq('status', 'pending'),
        // caregiver_pins has no client policy, so whether a code exists has to
        // come from a function. Never a stub: the adult check decides what to
        // show based on this.
        this.client.rpc('get_adult_verification', { p_family: familyId }),
      ]);

    const children = ((childRows.data ?? []) as Row[]).map(toChild);
    const group = <T>(rows: Row[], map: (r: Row) => T): Record<string, T[]> => {
      const out: Record<string, T[]> = {};
      for (const c of children) out[c.id] = [];
      for (const r of rows) {
        const key = r.child_id as string;
        (out[key] ??= []).push(map(r));
      }
      return out;
    };

    const preferences: Record<string, ChildPreferences> = {};
    for (const r of (prefRows.data ?? []) as Row[]) preferences[r.child_id] = toPreferences(r);

    // family_members and caregiver_profiles both point at users, but not at each
    // other, so PostgREST cannot embed one in the other — it has to be a second
    // query joined here. `users` is self-only by policy, so an email is
    // available for the signed-in adult and nobody else.
    const memberIds = ((memberRows.data ?? []) as Row[]).map((m) => m.user_id as string);
    const profileRows = memberIds.length
      ? (this.unwrap(
          await this.client.from('caregiver_profiles').select('user_id, caregiver_name').in('user_id', memberIds),
          'Caregiver names could not be loaded.',
        ) ?? []) as Row[]
      : [];
    const nameByUser = new Map(profileRows.map((p) => [p.user_id as string, p.caregiver_name as string]));

    const members: FamilyMember[] = ((memberRows.data ?? []) as Row[]).map((m) => ({
      userId: m.user_id, familyId: m.family_id, role: m.role,
      permissions: {
        can_answer_requests: m.can_answer_requests, can_edit_routines: m.can_edit_routines,
        can_edit_stories: m.can_edit_stories, can_approve_stories: m.can_approve_stories,
        can_manage_children: m.can_manage_children, can_manage_caregivers: m.can_manage_caregivers,
        can_manage_safety: m.can_manage_safety, can_export_data: m.can_export_data,
      },
      caregiverName: nameByUser.get(m.user_id as string) ?? '',
      email: m.user_id === user.id ? user.email : null,
      joinedAt: m.joined_at, revokedAt: m.revoked_at ?? null, isSelf: m.user_id === user.id,
    }));

    return {
      ...empty,
      members,
      children,
      preferences,
      communicationMethods: group((commRows.data ?? []) as Row[], (r) => ({
        id: r.id, childId: r.child_id, method: r.method, label: r.label,
        detail: r.detail ?? null, isPrimary: r.is_primary, sortOrder: r.sort_order,
      } as CommunicationMethod)),
      sensoryPreferences: group((sensoryRows.data ?? []) as Row[], (r) => ({
        id: r.id, childId: r.child_id, category: r.category, kind: r.kind,
        label: r.label, detail: r.detail ?? null, sortOrder: r.sort_order,
      } as SensoryPreference)),
      trustedCaregivers: group((trustedRows.data ?? []) as Row[], toTrusted),
      escalationRules: group((escalationRows.data ?? []) as Row[], (r) => ({
        id: r.id, childId: r.child_id, appliesToUrgency: r.applies_to_urgency ?? null,
        stepOrder: r.step_order, action: r.action, trustedCaregiverId: r.trusted_caregiver_id ?? null,
        afterSeconds: r.after_seconds, isActive: r.is_active,
      } as EscalationRule)),
      requestTypes: ((typeRows.data ?? []) as Row[]).map(toRequestType),
      adultVerification: {
        mode: (verificationRow.data?.mode ?? 'pin') as 'pin' | 'device_biometric' | 'none',
        isConfigured: Boolean(verificationRow.data?.is_configured),
      },
      pendingInvitations: ((inviteRows.data ?? []) as Row[])
        .filter((i) => i.invited_email?.toLowerCase() === user.email.toLowerCase())
        .map((i) => ({ id: i.id, familyName: i.families?.family_name ?? 'A family space', role: i.role, invitedEmail: i.invited_email })),
    };
  }

  async bootstrapFamily(input: {
    caregiverName: string; childName: string; familyName?: string | null;
    trustedCaregiverName?: string | null; pin?: string | null;
  }): Promise<{ familyId: string; childId: string }> {
    const data = await this.rpc<Row>('bootstrap_family', {
      p_caregiver_name: input.caregiverName,
      p_child_name: input.childName,
      p_family_name: input.familyName ?? null,
      p_trusted_caregiver_name: input.trustedCaregiverName ?? null,
      p_pin: input.pin ?? null,
    }, 'Your family space could not be created. Please try again.');
    return { familyId: data.family_id, childId: data.child_id };
  }

  async saveOnboardingDraft(stage: CaregiverProfile['onboardingStage'], data: Record<string, unknown>): Promise<void> {
    const user = await this.getCurrentUser();
    if (!user) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in to continue.');
    const { error } = await this.client.from('caregiver_profiles')
      .update({ onboarding_stage: stage, onboarding_data: data })
      .eq('user_id', user.id);
    if (error) throw translate(error, 'Your progress could not be saved.');
  }

  async updateCaregiverProfile(input: { caregiverName: string; pronouns?: string | null; relationshipLabel?: string | null }): Promise<void> {
    const user = await this.getCurrentUser();
    if (!user) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in to continue.');
    // An invited caregiver has an account before they have a profile, so this
    // upserts rather than failing on first save.
    const { error } = await this.client.from('caregiver_profiles').upsert({
      user_id: user.id,
      caregiver_name: input.caregiverName,
      pronouns: input.pronouns ?? null,
      relationship_label: input.relationshipLabel ?? null,
    }, { onConflict: 'user_id' });
    if (error) throw translate(error, 'Your name could not be saved.');
  }

  // -- children -------------------------------------------------------------

  async addChild(familyId: string, input: { childName: string; pronouns?: string | null }): Promise<ChildProfile> {
    const row = this.unwrap(
      await this.client.from('child_profiles')
        .insert({ family_id: familyId, child_name: input.childName, pronouns: input.pronouns ?? null })
        .select().single(),
      'That child profile could not be created.',
    ) as Row;
    await this.client.from('child_preferences').insert({ child_id: row.id, family_id: familyId });
    return toChild(row);
  }

  async updateChild(childId: string, input: Partial<Pick<ChildProfile, 'childName' | 'pronouns' | 'safeAdult' | 'safePlace' | 'emergencyInstructions'>>): Promise<void> {
    const patch: Row = {};
    if (input.childName !== undefined) patch.child_name = input.childName;
    if (input.pronouns !== undefined) patch.pronouns = input.pronouns;
    if (input.safeAdult !== undefined) patch.safe_adult = input.safeAdult;
    if (input.safePlace !== undefined) patch.safe_place = input.safePlace;
    if (input.emergencyInstructions !== undefined) patch.emergency_instructions = input.emergencyInstructions;
    const { error } = await this.client.from('child_profiles').update(patch).eq('id', childId);
    if (error) throw translate(error, 'That change could not be saved.');
  }

  async archiveChild(childId: string, archived: boolean): Promise<void> {
    const { error } = await this.client.from('child_profiles')
      .update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', childId);
    if (error) throw translate(error, 'That change could not be saved.');
  }

  async updateChildPreferences(childId: string, prefs: Partial<ChildPreferences>): Promise<void> {
    const familyId = prefs.familyId ?? (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', childId).single(),
      'That child profile could not be found.') as Row).family_id;
    const { error } = await this.client.from('child_preferences')
      .upsert(prefsToRow(childId, familyId, prefs), { onConflict: 'child_id' });
    if (error) throw translate(error, 'Those preferences could not be saved.');
  }

  async setCommunicationMethods(childId: string, methods: Omit<CommunicationMethod, 'id' | 'childId'>[]): Promise<void> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', childId).single(),
      'That child profile could not be found.') as Row).family_id;
    await this.client.from('communication_methods').delete().eq('child_id', childId);
    if (methods.length) {
      const { error } = await this.client.from('communication_methods').insert(
        methods.map((m, i) => ({
          child_id: childId, family_id: familyId, method: m.method, label: m.label,
          detail: m.detail ?? null, is_primary: m.isPrimary, sort_order: i,
        })));
      if (error) throw translate(error, 'Those preferences could not be saved.');
    }
  }

  async setSensoryPreferences(childId: string, items: Omit<SensoryPreference, 'id' | 'childId'>[]): Promise<void> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', childId).single(),
      'That child profile could not be found.') as Row).family_id;
    await this.client.from('sensory_preferences').delete().eq('child_id', childId);
    if (items.length) {
      const { error } = await this.client.from('sensory_preferences').insert(
        items.map((s, i) => ({
          child_id: childId, family_id: familyId, category: s.category, kind: s.kind,
          label: s.label, detail: s.detail ?? null, sort_order: i,
        })));
      if (error) throw translate(error, 'Those preferences could not be saved.');
    }
  }

  async saveEscalationRules(childId: string, rules: Omit<EscalationRule, 'id' | 'childId'>[]): Promise<void> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', childId).single(),
      'That child profile could not be found.') as Row).family_id;
    await this.client.from('escalation_rules').delete().eq('child_id', childId);
    if (rules.length) {
      const { error } = await this.client.from('escalation_rules').insert(
        rules.map((r) => ({
          child_id: childId, family_id: familyId, applies_to_urgency: r.appliesToUrgency,
          step_order: r.stepOrder, action: r.action, trusted_caregiver_id: r.trustedCaregiverId,
          after_seconds: r.afterSeconds, is_active: r.isActive,
        })));
      if (error) throw translate(error, 'Those settings could not be saved.');
    }
  }

  // -- caregivers -----------------------------------------------------------

  async upsertTrustedCaregiver(input: Omit<TrustedCaregiver, 'id' | 'familyId'> & { id?: string }): Promise<void> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', input.childId).single(),
      'That child profile could not be found.') as Row).family_id;
    const row: Row = {
      family_id: familyId, child_id: input.childId, user_id: input.userId ?? null,
      trusted_caregiver_name: input.trustedCaregiverName,
      relationship_label: input.relationshipLabel ?? null,
      escalation_order: input.escalationOrder, is_active: input.isActive,
    };
    const query = input.id
      ? this.client.from('trusted_caregivers').update(row).eq('id', input.id)
      : this.client.from('trusted_caregivers').insert(row);
    const { error } = await query;
    if (error) throw translate(error, 'That trusted caregiver could not be saved.');
  }

  async removeTrustedCaregiver(id: string): Promise<void> {
    const { error } = await this.client.from('trusted_caregivers')
      .update({ deleted_at: new Date().toISOString(), is_active: false }).eq('id', id);
    if (error) throw translate(error, 'That trusted caregiver could not be removed.');
  }

  async inviteCaregiver(familyId: string, input: { email: string; role: 'caregiver' | 'trusted' | 'view_only'; invitedName?: string | null; message?: string | null }) {
    const data = await this.rpc<Row>('create_caregiver_invitation', {
      p_family: familyId, p_email: input.email, p_role: input.role,
      p_invited_name: input.invitedName ?? null, p_message: input.message ?? null,
    }, 'That invitation could not be created.');
    return { invitationId: data.invitation_id, token: data.token };
  }

  async listInvitations(familyId: string) {
    const rows = (this.unwrap(
      await this.client.from('caregiver_invitations').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
      'Invitations could not be loaded.') ?? []) as Row[];
    return rows.map((i) => ({ id: i.id, invitedEmail: i.invited_email, role: i.role, status: i.status, expiresAt: i.expires_at }));
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    await this.rpc('revoke_caregiver_invitation', { p_invitation: invitationId }, 'That invitation could not be withdrawn.');
  }

  async acceptInvitation(token: string): Promise<{ familyId: string }> {
    const data = await this.rpc<Row>('accept_caregiver_invitation', { p_token: token }, 'That invitation could not be accepted.');
    return { familyId: data.family_id };
  }

  async revokeCaregiverAccess(familyId: string, userId: string): Promise<void> {
    await this.rpc('revoke_caregiver_access', { p_family: familyId, p_user: userId }, 'That caregiver could not be removed.');
  }

  async updateCaregiverRole(familyId: string, userId: string, role: FamilyMember['role']): Promise<void> {
    await this.rpc('update_caregiver_role', { p_family: familyId, p_user: userId, p_role: role }, 'That role could not be changed.');
  }

  // -- adult verification ---------------------------------------------------

  async setCaregiverPin(familyId: string, pin: string): Promise<void> {
    await this.rpc('set_caregiver_pin', { p_family: familyId, p_pin: pin }, 'That code could not be saved.');
  }

  async verifyCaregiverPin(familyId: string, pin: string) {
    const data = await this.rpc<Row>('verify_caregiver_pin', { p_family: familyId, p_pin: pin }, 'That code could not be checked.');
    return { ok: Boolean(data.ok), lockedUntil: data.locked_until ?? undefined, attemptsRemaining: data.attempts_remaining, mode: data.mode ?? 'pin' };
  }

  async setAdultVerificationMode(familyId: string, mode: 'pin' | 'device_biometric' | 'none'): Promise<void> {
    await this.rpc('set_adult_verification_mode', { p_family: familyId, p_mode: mode }, 'That setting could not be saved.');
  }

  // -- requests -------------------------------------------------------------

  async listRequests(familyId: string): Promise<RequestBundle[]> {
    const rows = (this.unwrap(
      await this.client.from('requests')
        .select('*, request_responses(*), request_events(*)')
        .eq('family_id', familyId)
        .order('created_at', { ascending: false })
        .limit(100),
      'Requests could not be loaded.') ?? []) as Row[];
    return rows.map((r) => ({
      request: toRequest(r),
      response: ((r.request_responses ?? []) as Row[]).filter((x) => x.is_current).map(toResponse)[0] ?? null,
      events: ((r.request_events ?? []) as Row[]).map(toEvent).sort((a, b) => a.id - b.id),
    }));
  }

  async getRequest(requestId: string): Promise<RequestBundle> {
    const r = this.unwrap(
      await this.client.from('requests').select('*, request_responses(*), request_events(*)').eq('id', requestId).single(),
      'That request could not be found.') as Row;
    return {
      request: toRequest(r),
      response: ((r.request_responses ?? []) as Row[]).filter((x) => x.is_current).map(toResponse)[0] ?? null,
      events: ((r.request_events ?? []) as Row[]).map(toEvent).sort((a, b) => a.id - b.id),
    };
  }

  async respondToRequest(input: { requestId: string; kind: ResponseKind; delayMinutes?: number | null; message?: string | null; urgency: Urgency }): Promise<HelpRequest> {
    if (input.urgency === 'urgent' && input.kind === 'delay') {
      throw new KindlyError('URGENT_REQUEST_CANNOT_BE_DELAYED', 'An urgent request cannot be answered with a delay. Choose an action that happens now.');
    }
    const row = await this.rpc<Row>('respond_to_request', {
      p_request_id: input.requestId, p_kind: input.kind,
      p_delay_minutes: input.delayMinutes ?? null, p_message: input.message ?? null,
    }, 'Your answer could not be sent.');
    return toRequest(row);
  }

  async claimRequest(requestId: string): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('claim_request', { p_request_id: requestId }, 'That request could not be taken back.'));
  }

  async escalateRequest(requestId: string, trustedCaregiverId?: string | null): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('escalate_request', {
      p_request_id: requestId, p_trusted_id: trustedCaregiverId ?? null,
    }, 'That request could not be passed on.'));
  }

  async resolveRequest(requestId: string, confirmUrgent: boolean): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('resolve_request', {
      p_request_id: requestId, p_confirm_urgent: confirmUrgent,
    }, 'That request could not be finished.'));
  }

  async cancelRequestAsCaregiver(requestId: string, reason?: string): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('cancel_request_as_caregiver', {
      p_request_id: requestId, p_reason: reason ?? null,
    }, 'That request could not be cancelled.'));
  }

  async tickEscalations(familyId: string): Promise<number> {
    return this.rpc<number>('tick_request_escalations', { p_family: familyId }, 'Escalation could not be checked.');
  }

  private channelFor(name: string, filter: { table: string; filter: string }[], cb: () => void): Unsubscribe {
    let channel: RealtimeChannel = this.client.channel(name);
    for (const f of filter) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: f.table, filter: f.filter }, () => cb());
    }
    channel.subscribe();
    return () => { void this.client.removeChannel(channel); };
  }

  subscribeToFamily(familyId: string, cb: () => void): Unsubscribe {
    return this.channelFor(`family:${familyId}`, [
      { table: 'requests', filter: `family_id=eq.${familyId}` },
      { table: 'request_responses', filter: `family_id=eq.${familyId}` },
      { table: 'notifications', filter: `family_id=eq.${familyId}` },
    ], cb);
  }

  subscribeToChild(childId: string, cb: () => void): Unsubscribe {
    return this.channelFor(`child:${childId}`, [
      { table: 'requests', filter: `child_id=eq.${childId}` },
    ], cb);
  }

  // -- child session --------------------------------------------------------

  async startChildSession(childId: string, deviceLabel?: string): Promise<ChildSession> {
    const data = await this.rpc<Row>('start_child_session', {
      p_child: childId, p_device_label: deviceLabel ?? null, p_hours: 12,
    }, 'Child mode could not be started.');
    return {
      sessionId: data.session_id, sessionToken: data.session_token,
      childId: data.child_id, familyId: data.family_id, expiresAt: data.expires_at,
    };
  }

  async endChildSession(token: string): Promise<void> {
    await this.rpc('end_child_session', { p_session_token: token }, 'Child mode could not be ended.');
  }

  async childGetSpace(token: string): Promise<ChildSpace> {
    const data = await this.rpc<Row>('child_get_space', { p_session_token: token }, 'Your space could not be loaded.');
    return {
      child: {
        id: data.child.id, childName: data.child.child_name, pronouns: data.child.pronouns ?? null,
        safeAdult: data.child.safe_adult ?? null, safePlace: data.child.safe_place ?? null,
        emergencyInstructions: data.child.emergency_instructions ?? null,
      },
      preferences: toPreferences(data.preferences),
      requestTypes: (data.request_types as Row[]).map(toRequestType),
      trustedCaregivers: (data.trusted_caregivers as Row[]).map((t) => ({
        trustedCaregiverName: t.trusted_caregiver_name, escalationOrder: t.escalation_order,
      })),
      session: { id: data.session.id, childId: data.session.child_id, expiresAt: data.session.expires_at },
    };
  }

  async childGetRequests(token: string): Promise<RequestBundle[]> {
    const data = await this.rpc<Row[]>('child_get_requests', { p_session_token: token }, 'Your requests could not be loaded.');
    return (data ?? []).map((entry) => ({
      request: toRequest(entry.request),
      response: entry.response ? toResponse(entry.response) : null,
      events: [],
    }));
  }

  async childCreateRequest(token: string, input: {
    typeSlug: string; dedupeKey: string; customMessage?: string | null;
    connectionState?: 'online' | 'offline' | 'unknown'; labelOverride?: string | null; detailOverride?: string | null;
  }): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('child_create_request', {
      p_session_token: token, p_type_slug: input.typeSlug, p_dedupe_key: input.dedupeKey,
      p_custom_message: input.customMessage ?? null, p_device_label: null,
      p_connection_state: input.connectionState ?? 'online',
      p_label_override: input.labelOverride ?? null, p_detail_override: input.detailOverride ?? null,
    }, 'That request could not be started.'));
  }

  async childSendRequest(token: string, requestId: string, connectionState: 'online' | 'offline' | 'unknown' = 'online'): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('child_send_request', {
      p_session_token: token, p_request_id: requestId, p_connection_state: connectionState,
    }, 'Your request could not be sent.'));
  }

  async childCancelRequest(token: string, requestId: string): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('child_cancel_request', {
      p_session_token: token, p_request_id: requestId,
    }, 'Your request could not be cancelled.'));
  }

  async childResolveRequest(token: string, requestId: string): Promise<HelpRequest> {
    return toRequest(await this.rpc<Row>('child_resolve_request', {
      p_session_token: token, p_request_id: requestId,
    }, 'That could not be finished.'));
  }

  async childGetStories(token: string) {
    const data = await this.rpc<Row[]>('child_get_stories', { p_session_token: token }, 'Your stories could not be loaded.');
    return (data ?? []).map((s) => ({
      id: s.id, title: s.title, scenarioKey: s.scenario_key, format: s.format, lastPage: s.last_page ?? 0,
      pages: ((s.pages ?? []) as Row[]).map((p) => ({
        position: p.position, sectionKey: p.section_key, heading: p.heading ?? null,
        body: p.body, certainty: p.certainty, pictogramKey: p.pictogram_key ?? null, altText: p.alt_text ?? null,
      })),
    }));
  }

  async childSetStoryProgress(token: string, storyId: string, page: number): Promise<void> {
    await this.rpc('child_set_story_progress', { p_session_token: token, p_story: storyId, p_page: page }, 'That could not be saved.');
  }

  async childSendStoryFeedback(token: string, storyId: string, kind: StoryFeedback['kind'], pagePosition?: number | null): Promise<void> {
    await this.rpc('child_send_story_feedback', {
      p_session_token: token, p_story: storyId, p_kind: kind, p_page: pagePosition ?? null,
    }, 'That message could not be sent.');
  }

  async childGetRoutines(token: string): Promise<Routine[]> {
    const data = await this.rpc<Row[]>('child_get_routines', { p_session_token: token }, 'Your day could not be loaded.');
    return (data ?? []).map((r) => ({
      id: r.id, familyId: '', childId: '', title: r.title, description: null,
      iconKey: r.icon_key ?? null, colorKey: r.color_key, scheduleLabel: r.schedule_label ?? null,
      scheduleDays: null, scheduleTime: null, allowReorder: true, allowSkip: r.allow_skip,
      transitionWarningSeconds: r.transition_warning_seconds, sortOrder: 0, archivedAt: null,
      steps: ((r.steps ?? []) as Row[]).map((s) => ({
        id: s.id, routineId: r.id, position: s.position, title: s.title, detail: s.detail ?? null,
        pictogramKey: s.pictogram_key ?? null, photoMediaId: s.photo_media_id ?? null,
        audioMediaId: s.audio_media_id ?? null, estimatedSeconds: null,
        isOptional: s.is_optional, plansChangedNote: s.plans_changed_note ?? null,
      })),
    }));
  }

  // -- routines -------------------------------------------------------------

  async listRoutines(childId: string): Promise<Routine[]> {
    const rows = (this.unwrap(
      await this.client.from('routines').select('*, routine_steps(*)')
        .eq('child_id', childId).is('deleted_at', null).order('sort_order'),
      'Routines could not be loaded.') ?? []) as Row[];
    return rows.map(toRoutine);
  }

  async saveRoutine(input: RoutineInput): Promise<Routine> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', input.childId).single(),
      'That child profile could not be found.') as Row).family_id;

    const routineRow: Row = {
      family_id: familyId, child_id: input.childId, title: input.title,
      description: input.description ?? null, icon_key: input.iconKey ?? null,
      color_key: input.colorKey ?? 'yellow', schedule_label: input.scheduleLabel ?? null,
      schedule_days: input.scheduleDays ?? null, schedule_time: input.scheduleTime ?? null,
      allow_reorder: input.allowReorder ?? true, allow_skip: input.allowSkip ?? true,
      transition_warning_seconds: input.transitionWarningSeconds ?? 60,
    };

    const saved = this.unwrap(
      input.id
        ? await this.client.from('routines').update(routineRow).eq('id', input.id).select().single()
        : await this.client.from('routines').insert(routineRow).select().single(),
      'That routine could not be saved.') as Row;

    const keepIds = input.steps.map((s) => s.id).filter(Boolean) as string[];
    let del = this.client.from('routine_steps').update({ deleted_at: new Date().toISOString() }).eq('routine_id', saved.id);
    if (keepIds.length) del = del.not('id', 'in', `(${keepIds.join(',')})`);
    await del;

    for (const [index, step] of input.steps.entries()) {
      const stepRow: Row = {
        routine_id: saved.id, family_id: familyId, position: index, title: step.title,
        detail: step.detail ?? null, pictogram_key: step.pictogramKey ?? null,
        photo_media_id: step.photoMediaId ?? null, audio_media_id: step.audioMediaId ?? null,
        estimated_seconds: step.estimatedSeconds ?? null, is_optional: step.isOptional ?? false,
        plans_changed_note: step.plansChangedNote ?? null, deleted_at: null,
      };
      const { error } = step.id
        ? await this.client.from('routine_steps').update(stepRow).eq('id', step.id)
        : await this.client.from('routine_steps').insert(stepRow);
      if (error) throw translate(error, 'A step could not be saved.');
    }

    const fresh = (await this.listRoutines(input.childId)).find((r) => r.id === saved.id);
    if (!fresh) throw new KindlyError('ROUTINE_NOT_FOUND', 'That routine could not be reloaded.');
    return fresh;
  }

  async duplicateRoutine(routineId: string): Promise<Routine> {
    const row = this.unwrap(
      await this.client.from('routines').select('*, routine_steps(*)').eq('id', routineId).single(),
      'That routine could not be found.') as Row;
    const source = toRoutine(row);
    return this.saveRoutine({
      childId: source.childId, title: `${source.title} (copy)`, description: source.description,
      iconKey: source.iconKey, colorKey: source.colorKey, scheduleLabel: source.scheduleLabel,
      scheduleDays: source.scheduleDays, scheduleTime: source.scheduleTime,
      allowReorder: source.allowReorder, allowSkip: source.allowSkip,
      transitionWarningSeconds: source.transitionWarningSeconds,
      steps: source.steps.map((s) => ({
        title: s.title, detail: s.detail, pictogramKey: s.pictogramKey, photoMediaId: s.photoMediaId,
        audioMediaId: s.audioMediaId, estimatedSeconds: s.estimatedSeconds, isOptional: s.isOptional,
        plansChangedNote: s.plansChangedNote,
      })),
    });
  }

  async archiveRoutine(routineId: string, archived: boolean): Promise<void> {
    const { error } = await this.client.from('routines')
      .update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', routineId);
    if (error) throw translate(error, 'That routine could not be archived.');
  }

  async deleteRoutine(routineId: string): Promise<void> {
    const { error } = await this.client.from('routines')
      .update({ deleted_at: new Date().toISOString() }).eq('id', routineId);
    if (error) throw translate(error, 'That routine could not be deleted.');
  }

  async reorderRoutines(childId: string, orderedIds: string[]): Promise<void> {
    for (const [i, id] of orderedIds.entries()) {
      await this.client.from('routines').update({ sort_order: i }).eq('id', id).eq('child_id', childId);
    }
  }

  async startRoutineRun(routineId: string, by: 'child' | 'caregiver'): Promise<RoutineRun> {
    const routine = this.unwrap(
      await this.client.from('routines').select('*, routine_steps(*)').eq('id', routineId).single(),
      'That routine could not be found.') as Row;
    const existing = this.unwrap(
      await this.client.from('routine_runs').select('*').eq('routine_id', routineId).in('status', ['running', 'paused']).maybeSingle(),
      'That routine could not be started.') as Row | null;
    if (existing) {
      const resumed = this.unwrap(
        await this.client.from('routine_runs').update({ status: 'running', paused_at: null }).eq('id', existing.id).select().single(),
        'That routine could not be resumed.') as Row;
      return toRun(resumed);
    }
    const steps = ((routine.routine_steps ?? []) as Row[]).filter((s) => !s.deleted_at).sort((a, b) => a.position - b.position);
    const row = this.unwrap(
      await this.client.from('routine_runs').insert({
        routine_id: routineId, family_id: routine.family_id, child_id: routine.child_id,
        status: 'running', current_step_id: steps[0]?.id ?? null,
        started_by_kind: by, step_states: [],
      }).select().single(),
      'That routine could not be started.') as Row;
    return toRun(row);
  }

  async setRoutineStepState(runId: string, stepId: string, state: RoutineStepState): Promise<RoutineRun> {
    const run = this.unwrap(
      await this.client.from('routine_runs').select('*').eq('id', runId).single(),
      'That routine is no longer running.') as Row;
    const steps = (this.unwrap(
      await this.client.from('routine_steps').select('id, position').eq('routine_id', run.routine_id)
        .is('deleted_at', null).order('position'),
      'That routine could not be loaded.') ?? []) as Row[];

    const states = ((run.step_states ?? []) as Row[]).filter((s) => (s.step_id ?? s.stepId) !== stepId);
    states.push({ step_id: stepId, state, at: new Date().toISOString() });
    const index = steps.findIndex((s) => s.id === stepId);
    const next = steps[index + 1]?.id ?? null;

    const updated = this.unwrap(
      await this.client.from('routine_runs').update({
        step_states: states, current_step_id: next,
        status: next ? run.status : 'finished',
        finished_at: next ? run.finished_at : new Date().toISOString(),
      }).eq('id', runId).select().single(),
      'That step could not be saved.') as Row;
    return toRun(updated);
  }

  async setRoutineRunStatus(runId: string, status: RoutineRun['status']): Promise<RoutineRun> {
    const patch: Row = { status };
    patch.paused_at = status === 'paused' ? new Date().toISOString() : null;
    if (status === 'finished' || status === 'abandoned') patch.finished_at = new Date().toISOString();
    if (status === 'plans_changed') patch.plans_changed_at = new Date().toISOString();
    const row = this.unwrap(
      await this.client.from('routine_runs').update(patch).eq('id', runId).select().single(),
      'That change could not be saved.') as Row;
    return toRun(row);
  }

  async getActiveRoutineRun(routineId: string): Promise<RoutineRun | null> {
    const row = this.unwrap(
      await this.client.from('routine_runs').select('*').eq('routine_id', routineId).in('status', ['running', 'paused']).maybeSingle(),
      'That routine could not be loaded.') as Row | null;
    return row ? toRun(row) : null;
  }

  // -- stories --------------------------------------------------------------

  async listStories(childId: string): Promise<Story[]> {
    const rows = (this.unwrap(
      await this.client.from('stories').select('*, story_pages(*), story_assignments(child_id, withdrawn_at)')
        .eq('child_id', childId).is('deleted_at', null).order('updated_at', { ascending: false }),
      'Stories could not be loaded.') ?? []) as Row[];
    return rows.map(toStory);
  }

  async getStory(storyId: string): Promise<Story> {
    const row = this.unwrap(
      await this.client.from('stories').select('*, story_pages(*), story_assignments(child_id, withdrawn_at)').eq('id', storyId).single(),
      'That story could not be found.') as Row;
    return toStory(row);
  }

  async saveStoryDraft(input: StoryDraftInput & { id?: string }): Promise<Story> {
    const familyId = (this.unwrap(
      await this.client.from('child_profiles').select('family_id').eq('id', input.childId).single(),
      'That child profile could not be found.') as Row).family_id;

    const { reviewStory } = await import('../stories/safetyReview');
    const review = reviewStory(input.title, input.pages.map((p, i) => ({ position: i, heading: p.heading, body: p.body })));

    const storyRow: Row = {
      family_id: familyId, child_id: input.childId, title: input.title, scenario_key: input.scenarioKey,
      // Saving always produces a draft; approval is a separate, explicit action.
      status: 'draft', source: input.source, format: input.format, person: input.person,
      reading_level: input.readingLevel, target_page_count: input.pages.length,
      inputs: input.inputs ?? {}, review_flags: review.flags,
      requires_safety_review: review.requiresSafetyReview,
      generation_model: input.generation?.model ?? null,
      generation_prompt_version: input.generation?.promptVersion ?? null,
      generated_at: input.generation?.generatedAt ?? null,
    };

    const saved = this.unwrap(
      input.id
        ? await this.client.from('stories').update(storyRow).eq('id', input.id).select().single()
        : await this.client.from('stories').insert(storyRow).select().single(),
      'That story could not be saved.') as Row;

    const keepIds = input.pages.map((p) => p.id).filter(Boolean) as string[];
    let del = this.client.from('story_pages').update({ deleted_at: new Date().toISOString() }).eq('story_id', saved.id);
    if (keepIds.length) del = del.not('id', 'in', `(${keepIds.join(',')})`);
    await del;

    for (const [index, page] of input.pages.entries()) {
      const pageRow: Row = {
        story_id: saved.id, family_id: familyId, position: index, section_key: page.sectionKey,
        heading: page.heading ?? null, body: page.body, certainty: page.certainty,
        pictogram_key: page.pictogramKey ?? null, image_media_id: page.imageMediaId ?? null,
        audio_media_id: page.audioMediaId ?? null, alt_text: page.altText ?? null,
        review_flags: review.flags.filter((f) => f.pagePosition === index), deleted_at: null,
      };
      const { error } = page.id
        ? await this.client.from('story_pages').update(pageRow).eq('id', page.id)
        : await this.client.from('story_pages').insert(pageRow);
      if (error) throw translate(error, 'A page could not be saved.');
    }

    return this.getStory(saved.id);
  }

  async approveStory(storyId: string, acknowledgeFlags: boolean): Promise<Story> {
    await this.rpc('approve_story', { p_story: storyId, p_acknowledge_flags: acknowledgeFlags }, 'That story could not be approved.');
    return this.getStory(storyId);
  }

  async assignStory(storyId: string, childId: string): Promise<void> {
    await this.rpc('assign_story', { p_story: storyId, p_child: childId }, 'That story could not be given to your child.');
  }

  async withdrawStory(storyId: string, childId: string): Promise<void> {
    await this.rpc('withdraw_story', { p_story: storyId, p_child: childId }, 'That story could not be withdrawn.');
  }

  async archiveStory(storyId: string, archived: boolean): Promise<void> {
    const { error } = await this.client.from('stories').update({
      archived_at: archived ? new Date().toISOString() : null,
      status: archived ? 'archived' : 'draft',
    }).eq('id', storyId);
    if (error) throw translate(error, 'That story could not be archived.');
  }

  async deleteStory(storyId: string): Promise<void> {
    const { error } = await this.client.from('stories').update({ deleted_at: new Date().toISOString() }).eq('id', storyId);
    if (error) throw translate(error, 'That story could not be deleted.');
  }

  async duplicateStory(storyId: string): Promise<Story> {
    const story = await this.getStory(storyId);
    return this.saveStoryDraft({
      childId: story.childId, title: `${story.title} (copy)`, scenarioKey: story.scenarioKey,
      source: story.source, format: story.format, person: story.person, readingLevel: story.readingLevel,
      inputs: story.inputs,
      pages: story.pages.map((p) => ({
        sectionKey: p.sectionKey, heading: p.heading, body: p.body, certainty: p.certainty,
        pictogramKey: p.pictogramKey, imageMediaId: p.imageMediaId, audioMediaId: p.audioMediaId, altText: p.altText,
      })),
    });
  }

  async generateStory(childId: string, input: Record<string, unknown>) {
    const { data, error } = await this.client.functions.invoke('generate-story', {
      body: { childId, input },
    });
    if (error) {
      // The function returns a typed error body; surface its message rather
      // than the transport's.
      const context = (error as { context?: { error?: { code?: string; message?: string } } }).context;
      const code = context?.error?.code ?? 'GENERATION_FAILED';
      throw new KindlyError(code, context?.error?.message
        ?? 'The draft could not be written. You can still write the story yourself.');
    }
    return data as import('./types').GeneratedStory;
  }

  async listStoryVersions(storyId: string): Promise<StoryVersion[]> {
    const rows = (this.unwrap(
      await this.client.from('story_versions').select('*').eq('story_id', storyId).order('version', { ascending: false }),
      'Version history could not be loaded.') ?? []) as Row[];
    return rows.map((v) => ({
      id: v.id, storyId: v.story_id, familyId: v.family_id, version: v.version, changeNote: v.change_note ?? null,
      createdByName: v.created_by_name ?? null, createdAt: v.created_at, snapshot: v.snapshot,
    }));
  }

  async listStoryFeedback(familyId: string): Promise<StoryFeedback[]> {
    const rows = (this.unwrap(
      await this.client.from('story_feedback').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(50),
      'Messages could not be loaded.') ?? []) as Row[];
    return rows.map((f) => ({
      id: f.id, storyId: f.story_id, childId: f.child_id, pagePosition: f.page_position ?? null,
      kind: f.kind, createdAt: f.created_at, seenAt: f.seen_at ?? null,
    }));
  }

  async markStoryFeedbackSeen(feedbackId: string): Promise<void> {
    await this.client.from('story_feedback').update({ seen_at: new Date().toISOString() }).eq('id', feedbackId);
  }

  // -- notifications --------------------------------------------------------

  async listNotifications(familyId: string): Promise<AppNotification[]> {
    const rows = (this.unwrap(
      await this.client.from('notifications').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
      'Notifications could not be loaded.') ?? []) as Row[];
    return rows.map(toNotification);
  }

  async markNotificationsRead(ids?: string[]): Promise<void> {
    await this.rpc('mark_notifications_read', { p_ids: ids ?? null }, 'Notifications could not be updated.');
  }

  // -- media ----------------------------------------------------------------

  async listMedia(familyId: string): Promise<MediaAsset[]> {
    const rows = (this.unwrap(
      await this.client.from('media_assets').select('*').eq('family_id', familyId).is('deleted_at', null).order('created_at', { ascending: false }),
      'Pictures could not be loaded.') ?? []) as Row[];
    return rows.map(toMedia);
  }

  async uploadMedia(input: { familyId: string; childId?: string | null; kind: MediaAsset['kind']; file: File; altText: string; caption?: string | null }): Promise<MediaAsset> {
    const user = await this.getCurrentUser();
    if (!user) throw new KindlyError('NOT_AUTHENTICATED', 'Please sign in to continue.');
    if (!input.altText.trim()) throw new KindlyError('ALT_TEXT_REQUIRED', 'Please describe this picture in words so it can be read aloud.');

    const ext = input.file.name.split('.').pop() ?? 'bin';
    const path = `${input.familyId}/${input.childId ?? 'shared'}/${crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await this.client.storage.from('kindly-media')
      .upload(path, input.file, { contentType: input.file.type, upsert: false });
    if (uploadError) throw translate(uploadError, 'That picture could not be uploaded.');

    const row = this.unwrap(
      await this.client.from('media_assets').insert({
        family_id: input.familyId, child_id: input.childId ?? null, kind: input.kind,
        storage_path: path, mime_type: input.file.type, byte_size: input.file.size,
        alt_text: input.altText, caption: input.caption ?? null, uploaded_by: user.id,
      }).select().single(),
      'That picture could not be saved.') as Row;
    return toMedia(row);
  }

  async getSignedMediaUrl(mediaId: string): Promise<string> {
    const row = this.unwrap(
      await this.client.from('media_assets').select('storage_path').eq('id', mediaId).single(),
      'That picture could not be found.') as Row;
    // Private bucket: always a short-lived signed URL, never a public link.
    const { data, error } = await this.client.storage.from('kindly-media').createSignedUrl(row.storage_path, 300);
    if (error) throw translate(error, 'That picture could not be opened.');
    return data.signedUrl;
  }

  async deleteMedia(mediaId: string): Promise<void> {
    const row = this.unwrap(
      await this.client.from('media_assets').select('storage_path').eq('id', mediaId).single(),
      'That picture could not be found.') as Row;
    await this.client.storage.from('kindly-media').remove([row.storage_path]);
    await this.client.from('media_assets').update({ deleted_at: new Date().toISOString() }).eq('id', mediaId);
  }

  // -- data rights ----------------------------------------------------------

  async exportFamilyData(familyId: string): Promise<unknown> {
    return this.rpc('export_family_data', { p_family: familyId }, 'Your export could not be prepared.');
  }

  async requestDeletion(scope: 'account' | 'child' | 'family', opts?: { familyId?: string; childId?: string }): Promise<string> {
    const id = await this.rpc<string>('request_deletion', {
      p_scope: scope, p_family: opts?.familyId ?? null, p_child: opts?.childId ?? null,
    }, 'That deletion could not be started.');
    if (scope === 'account') await this.signOut();
    return id;
  }
}
