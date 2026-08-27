import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAN_WAIT_ALLOWED_RESPONSES, LIFECYCLE_STAGES, REQUEST_STATUSES, STATUS_META, TRANSITIONS,
  URGENT_ALLOWED_RESPONSES, allowedResponses, canTransition, isClosed, isLive, isOpen,
  isResponseAllowed, lifecycleCells, type RequestStatus,
} from './stateMachine';

// Resolved from the project root: vitest runs with cwd at the package root.
const MIGRATION = join(process.cwd(), 'supabase', 'migrations', '20260101001000_functions_requests.sql');

/**
 * The database is authoritative for the state machine. This test parses
 * kindly.allowed_transition() out of the migration and asserts the TypeScript
 * copy is identical, so the two can never drift apart unnoticed.
 */
function transitionsFromSql(): Record<string, string[]> {
  const sql = readFileSync(MIGRATION, 'utf8');
  const body = sql.slice(sql.indexOf('create or replace function kindly.allowed_transition'));
  const caseBlock = body.slice(body.indexOf('select case p_from'), body.indexOf('else false'));
  const out: Record<string, string[]> = {};
  const line = /when '(\w+)'\s*then p_to in \(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = line.exec(caseBlock)) !== null) {
    out[match[1]!] = match[2]!.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  }
  return out;
}

describe('the state machine matches the database', () => {
  const fromSql = transitionsFromSql();

  it('parsed something', () => {
    expect(Object.keys(fromSql).length).toBeGreaterThan(5);
  });

  it.each(Object.keys(fromSql))('%s has the same allowed targets in SQL and TypeScript', (status) => {
    expect([...TRANSITIONS[status as RequestStatus]].sort()).toEqual([...fromSql[status]!].sort());
  });

  it('treats resolved and cancelled as terminal in both', () => {
    expect(TRANSITIONS.resolved).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
    expect(fromSql.resolved).toBeUndefined();
    expect(fromSql.cancelled).toBeUndefined();
  });
});

describe('transitions', () => {
  it('allows the happy path', () => {
    expect(canTransition('reviewing', 'sending')).toBe(true);
    expect(canTransition('sending', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'acknowledged')).toBe(true);
    expect(canTransition('acknowledged', 'resolved')).toBe(true);
  });

  it('never lets a request jump straight to delivered', () => {
    expect(canTransition('reviewing', 'delivered')).toBe(false);
  });

  it('never lets a request be acknowledged before it is delivered', () => {
    expect(canTransition('reviewing', 'acknowledged')).toBe(false);
    expect(canTransition('sending', 'acknowledged')).toBe(false);
    expect(canTransition('failed', 'acknowledged')).toBe(false);
  });

  it('never reopens a finished request', () => {
    for (const status of REQUEST_STATUSES) {
      expect(canTransition('resolved', status)).toBe(false);
      expect(canTransition('cancelled', status)).toBe(false);
    }
  });

  it('lets a child change their mind from every live state', () => {
    for (const status of ['reviewing', 'sending', 'retrying', 'delivered', 'waiting', 'escalated', 'acknowledged'] as const) {
      expect(canTransition(status, 'cancelled')).toBe(true);
    }
  });

  it('always offers a way out of a failure', () => {
    expect(canTransition('failed', 'retrying')).toBe(true);
    expect(canTransition('unavailable', 'retrying')).toBe(true);
  });
});

describe('status classification', () => {
  it('classifies every status exactly once as open-or-closed', () => {
    for (const status of REQUEST_STATUSES) {
      expect(isOpen(status)).toBe(!isClosed(status));
    }
  });

  it('does not count reviewing as live, because it has not left the device', () => {
    expect(isOpen('reviewing')).toBe(true);
    expect(isLive('reviewing')).toBe(false);
  });
});

describe('status presentation', () => {
  it('gives every status words, an icon and an announcement', () => {
    for (const status of REQUEST_STATUSES) {
      const meta = STATUS_META[status];
      expect(meta.text.length).toBeGreaterThan(0);
      expect(meta.icon.startsWith('i-')).toBe(true);
      expect(meta.announcement.length).toBeGreaterThan(0);
    }
  });

  it('never says "seen" or "delivered" for a status that is neither', () => {
    expect(STATUS_META.sending.text.toLowerCase()).not.toContain('delivered');
    expect(STATUS_META.failed.text.toLowerCase()).not.toContain('delivered yet');
    expect(STATUS_META.delivered.announcement.toLowerCase()).toContain('nobody has answered');
  });
});

describe('lifecycle display', () => {
  it('has five stages', () => {
    expect(LIFECYCLE_STAGES).toHaveLength(5);
  });

  it('marks the stopping point when a request fails', () => {
    const cells = lifecycleCells('failed');
    expect(cells[1]!.state).toBe('stopped');
    expect(cells[2]!.state).toBe('todo');
  });

  it('marks progress on the happy path', () => {
    const cells = lifecycleCells('acknowledged');
    expect(cells.slice(0, 3).every((c) => c.state === 'done')).toBe(true);
    expect(cells[3]!.state).toBe('now');
  });
});

describe('urgent request safety', () => {
  it('never offers a delay for an urgent request', () => {
    expect(URGENT_ALLOWED_RESPONSES).not.toContain('delay');
    expect(isResponseAllowed('urgent', 'delay')).toBe(false);
    expect(allowedResponses('urgent')).not.toContain('delay');
  });

  it('always offers at least one immediate action for an urgent request', () => {
    const immediate = ['coming_now', 'other_caregiver', 'safe_adult', 'safe_place'] as const;
    expect(immediate.some((kind) => URGENT_ALLOWED_RESPONSES.includes(kind))).toBe(true);
    for (const kind of immediate) expect(isResponseAllowed('urgent', kind)).toBe(true);
  });

  it('still allows a delay when the request can wait', () => {
    expect(CAN_WAIT_ALLOWED_RESPONSES).toContain('delay');
    expect(isResponseAllowed('can_wait', 'delay')).toBe(true);
  });
});
