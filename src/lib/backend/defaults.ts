import type { ChildPreferences, EscalationRule, Permissions, RequestType, FamilyRole } from '../types';

/**
 * Values that must agree between the SQL layer and the in-memory layer.
 *
 * Each constant here mirrors a DEFAULT, a seeded row or a CHECK constraint in
 * supabase/migrations. When one side changes the other has to change with it,
 * otherwise a test that passes against MemoryBackend would prove nothing about
 * the real thing.
 */

/**
 * The built-in request vocabulary (family_id IS NULL rows in request_types).
 *
 * `bathroom` ships as urgent on purpose: KINDLY does not assume a bathroom
 * request can safely wait. Families change it per child through
 * child_preferences.bathroomUrgency.
 */
export const BUILTIN_REQUEST_TYPES: readonly RequestType[] = Object.freeze([
  { slug: 'help',      childFacingLabel: 'Help',            childFacingDetail: 'Something is tricky',    urgency: 'urgent',   pictogramKey: 'i-help',     pictogramMediaId: null, colorKey: 'coral',  sortOrder: 10 },
  { slug: 'pain',      childFacingLabel: 'It hurts',        childFacingDetail: 'I have pain',            urgency: 'urgent',   pictogramKey: 'i-hurt',     pictogramMediaId: null, colorKey: 'coral',  sortOrder: 20 },
  { slug: 'breathing', childFacingLabel: 'Hard to breathe', childFacingDetail: 'Breathing is difficult', urgency: 'urgent',   pictogramKey: 'i-breath',   pictogramMediaId: null, colorKey: 'coral',  sortOrder: 30 },
  { slug: 'unsafe',    childFacingLabel: 'I feel unsafe',   childFacingDetail: 'Something is scary',     urgency: 'urgent',   pictogramKey: 'i-shield',   pictogramMediaId: null, colorKey: 'coral',  sortOrder: 40 },
  { slug: 'bathroom',  childFacingLabel: 'Bathroom',        childFacingDetail: 'I need to go',           urgency: 'urgent',   pictogramKey: 'i-bathroom', pictogramMediaId: null, colorKey: 'yellow', sortOrder: 50 },
  { slug: 'drink',     childFacingLabel: 'Drink',           childFacingDetail: 'I am thirsty',           urgency: 'can_wait', pictogramKey: 'i-droplet',  pictogramMediaId: null, colorKey: 'blue',   sortOrder: 60 },
  { slug: 'break',     childFacingLabel: 'Break',           childFacingDetail: 'I need quiet',           urgency: 'can_wait', pictogramKey: 'i-pause',    pictogramMediaId: null, colorKey: 'purple', sortOrder: 70 },
  { slug: 'other',     childFacingLabel: 'Something else',  childFacingDetail: 'I will show you',        urgency: 'can_wait', pictogramKey: 'i-more',     pictogramMediaId: null, colorKey: 'blue',   sortOrder: 80 },
  { slug: 'feeling',   childFacingLabel: 'How I feel',      childFacingDetail: 'I want to share this',   urgency: 'can_wait', pictogramKey: 'i-heart',    pictogramMediaId: null, colorKey: 'purple', sortOrder: 90 },
]);

/** Mirrors the column defaults on public.child_preferences. */
export function defaultPreferences(childId: string, familyId: string): ChildPreferences {
  return {
    childId,
    familyId,
    textScale: 1,
    highContrast: false,
    lowStimulation: false,
    symbolSystem: 'kindly_default',
    pairTextWithSymbols: true,
    soundEnabled: true,
    vibrationEnabled: true,
    animationEnabled: true,
    countdownsVisible: true,
    readAloudEnabled: false,
    readAloudRate: 1,
    processingTimeSeconds: 5,
    transitionWarnings: true,
    escalationDelaySeconds: 120,
    unavailableDelaySeconds: 300,
    bathroomUrgency: 'urgent',
    allowCustomMessage: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    quietHoursAllowUrgent: true,
  };
}

/** Mirrors kindly.default_permissions(). */
export function defaultPermissions(role: FamilyRole): Permissions {
  switch (role) {
    case 'owner':
      return {
        can_answer_requests: true, can_edit_routines: true, can_edit_stories: true,
        can_approve_stories: true, can_manage_children: true, can_manage_caregivers: true,
        can_manage_safety: true, can_export_data: true,
      };
    case 'caregiver':
      return {
        can_answer_requests: true, can_edit_routines: true, can_edit_stories: true,
        can_approve_stories: true, can_manage_children: false, can_manage_caregivers: false,
        can_manage_safety: false, can_export_data: false,
      };
    case 'trusted':
      return {
        can_answer_requests: true, can_edit_routines: false, can_edit_stories: false,
        can_approve_stories: false, can_manage_children: false, can_manage_caregivers: false,
        can_manage_safety: false, can_export_data: false,
      };
    case 'view_only':
      return {
        can_answer_requests: false, can_edit_routines: false, can_edit_stories: false,
        can_approve_stories: false, can_manage_children: false, can_manage_caregivers: false,
        can_manage_safety: false, can_export_data: false,
      };
  }
}

/**
 * The escalation ladder a new child starts with.
 *
 * Urgent requests move on faster than ones that can wait, and the last step is
 * always show_offline_help: if no adult answers through the app, the child is
 * given a real-world route rather than being left on a spinner.
 */
export function defaultEscalationRules(childId: string): Omit<EscalationRule, 'id'>[] {
  return [
    { childId, appliesToUrgency: 'urgent',   stepOrder: 1, action: 'notify_assigned',        trustedCaregiverId: null, afterSeconds: 0,   isActive: true },
    { childId, appliesToUrgency: 'urgent',   stepOrder: 2, action: 'notify_all_caregivers',  trustedCaregiverId: null, afterSeconds: 60,  isActive: true },
    { childId, appliesToUrgency: 'urgent',   stepOrder: 3, action: 'notify_trusted',         trustedCaregiverId: null, afterSeconds: 120, isActive: true },
    { childId, appliesToUrgency: 'urgent',   stepOrder: 4, action: 'show_offline_help',      trustedCaregiverId: null, afterSeconds: 300, isActive: true },
    { childId, appliesToUrgency: 'can_wait', stepOrder: 1, action: 'notify_assigned',        trustedCaregiverId: null, afterSeconds: 0,   isActive: true },
    { childId, appliesToUrgency: 'can_wait', stepOrder: 2, action: 'notify_all_caregivers',  trustedCaregiverId: null, afterSeconds: 300, isActive: true },
    { childId, appliesToUrgency: 'can_wait', stepOrder: 3, action: 'show_offline_help',      trustedCaregiverId: null, afterSeconds: 900, isActive: true },
  ];
}

/** The note shown wherever KINDLY explains what it is not. */
export const EMERGENCY_SERVICES_NOTE =
  'KINDLY is not an emergency service. In an emergency, call your local emergency number.';
