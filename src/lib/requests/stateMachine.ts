/**
 * The KINDLY request state machine.
 *
 * This table is the mirror of kindly.allowed_transition() in
 * supabase/migrations/20260101001000_functions_requests.sql. The database is
 * authoritative; this copy exists so the UI can disable impossible actions
 * before a round trip. A unit test asserts the two stay identical.
 */

export const REQUEST_STATUSES = [
  'reviewing',
  'sending',
  'retrying',
  'failed',
  'delivered',
  'waiting',
  'escalated',
  'unavailable',
  'acknowledged',
  'resolved',
  'cancelled',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = Object.freeze({
  reviewing: ['sending', 'cancelled'],
  sending: ['delivered', 'failed', 'cancelled', 'unavailable'],
  retrying: ['delivered', 'failed', 'cancelled', 'unavailable'],
  failed: ['retrying', 'cancelled', 'resolved'],
  delivered: ['acknowledged', 'waiting', 'escalated', 'cancelled', 'resolved'],
  waiting: ['escalated', 'unavailable', 'acknowledged', 'cancelled', 'resolved'],
  escalated: ['acknowledged', 'unavailable', 'waiting', 'cancelled', 'resolved'],
  unavailable: ['retrying', 'acknowledged', 'cancelled', 'resolved'],
  acknowledged: ['acknowledged', 'escalated', 'resolved', 'cancelled'],
  resolved: [],
  cancelled: [],
});

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses where the request still needs someone's attention. */
export const OPEN_STATUSES: readonly RequestStatus[] = [
  'reviewing', 'sending', 'retrying', 'failed', 'delivered',
  'waiting', 'escalated', 'unavailable', 'acknowledged',
];

/** Statuses that have left the child's device and are visible to caregivers. */
export const LIVE_STATUSES: readonly RequestStatus[] = [
  'sending', 'retrying', 'failed', 'delivered',
  'waiting', 'escalated', 'unavailable', 'acknowledged',
];

export const CLOSED_STATUSES: readonly RequestStatus[] = ['resolved', 'cancelled'];

export function isOpen(status: RequestStatus): boolean { return OPEN_STATUSES.includes(status); }
export function isLive(status: RequestStatus): boolean { return LIVE_STATUSES.includes(status); }
export function isClosed(status: RequestStatus): boolean { return CLOSED_STATUSES.includes(status); }

/**
 * Status presentation.
 *
 * `tone` drives colour, `icon` drives a shape and `text` is always rendered as
 * words. Nothing here is communicated by colour alone: every pill shows an icon
 * and a text label together.
 */
export type StatusTone = 'neutral' | 'sending' | 'delivered' | 'waiting' | 'failed' | 'ack' | 'done';

export interface StatusMeta {
  text: string;
  icon: string;
  tone: StatusTone;
  /** Read by assistive technology in the live region when the status changes. */
  announcement: string;
}

export const STATUS_META: Readonly<Record<RequestStatus, StatusMeta>> = Object.freeze({
  reviewing:    { text: 'Not sent yet',            icon: 'i-help',     tone: 'neutral',   announcement: 'Not sent yet.' },
  sending:      { text: 'Sending',                 icon: 'i-loader',   tone: 'sending',   announcement: 'Sending your request.' },
  retrying:     { text: 'Trying again',            icon: 'i-refresh',  tone: 'sending',   announcement: 'Trying to send again.' },
  delivered:    { text: 'Delivered',               icon: 'i-check',    tone: 'delivered', announcement: 'Your request arrived. Nobody has answered yet.' },
  waiting:      { text: 'No answer yet',           icon: 'i-clock-3',  tone: 'waiting',   announcement: 'No answer yet.' },
  escalated:    { text: 'Asked another caregiver', icon: 'i-users',    tone: 'waiting',   announcement: 'Another trusted caregiver has been asked.' },
  unavailable:  { text: 'No one available',        icon: 'i-alert',    tone: 'failed',    announcement: 'No one has answered. Please find a grown-up near you.' },
  failed:       { text: 'Not delivered',           icon: 'i-alert',    tone: 'failed',    announcement: 'Your request was not delivered.' },
  acknowledged: { text: 'Answered',                icon: 'i-check',    tone: 'ack',       announcement: 'Someone answered your request.' },
  resolved:     { text: 'Finished',                icon: 'i-check',    tone: 'done',      announcement: 'This request is finished.' },
  cancelled:    { text: 'Cancelled',               icon: 'i-x-circle', tone: 'done',      announcement: 'This request was cancelled.' },
});

/** The five lifecycle stages shown to caregivers. */
export const LIFECYCLE_STAGES = ['Review', 'Sending', 'Delivered', 'Acknowledged', 'Resolved'] as const;

const LIFECYCLE_INDEX: Record<RequestStatus, number> = {
  reviewing: 0, sending: 1, retrying: 1, failed: 1,
  delivered: 2, waiting: 2, escalated: 2, unavailable: 2,
  acknowledged: 3, resolved: 4, cancelled: 4,
};

export type LifecycleCellState = 'done' | 'now' | 'stopped' | 'todo';

export function lifecycleCells(status: RequestStatus): { label: string; state: LifecycleCellState }[] {
  const now = LIFECYCLE_INDEX[status];
  const stopped = status === 'failed' || status === 'unavailable' || status === 'cancelled';
  return LIFECYCLE_STAGES.map((label, i) => ({
    label,
    state: i < now ? 'done' : i === now ? (stopped ? 'stopped' : 'now') : 'todo',
  }));
}

/**
 * Response kinds a caregiver may give.
 *
 * `delay` is deliberately absent from the urgent list. An urgent request must
 * always receive an immediate action; "not right now" is not an option KINDLY
 * will render, and the database rejects it as well.
 */
export const RESPONSE_KINDS = ['seen', 'coming_now', 'delay', 'other_caregiver', 'safe_adult', 'safe_place'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

export const URGENT_ALLOWED_RESPONSES: readonly ResponseKind[] = [
  'seen', 'coming_now', 'other_caregiver', 'safe_adult', 'safe_place',
];

export const CAN_WAIT_ALLOWED_RESPONSES: readonly ResponseKind[] = [
  'seen', 'coming_now', 'delay', 'other_caregiver', 'safe_place',
];

export type Urgency = 'urgent' | 'can_wait';

export function allowedResponses(urgency: Urgency): readonly ResponseKind[] {
  return urgency === 'urgent' ? URGENT_ALLOWED_RESPONSES : CAN_WAIT_ALLOWED_RESPONSES;
}

export function isResponseAllowed(urgency: Urgency, kind: ResponseKind): boolean {
  return allowedResponses(urgency).includes(kind);
}
