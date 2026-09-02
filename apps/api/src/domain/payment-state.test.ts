import { describe, expect, test } from 'bun:test';
import {
  ABANDONMENT_IDLE_MINUTES,
  EVENT_KINDS,
  STATES,
  incrementsAttemptIndex,
  isAbandoned,
  isTerminal,
  transition,
  type EventKind,
  type State,
} from './payment-state.ts';

const T0 = '2026-07-25T10:00:00.000Z';
const T1 = '2026-07-25T10:05:00.000Z';
const EARLIER = '2026-07-25T09:55:00.000Z';

/** Applies an event forward in time — the ordinary case. */
function apply(current: State, event: EventKind) {
  return transition(current, event, T1, T0);
}

/**
 * The complete expected table. Every one of the 6 × 6 = 36 pairs is asserted,
 * so adding a state or an event without deciding what it does fails the build
 * rather than defaulting silently.
 */
const EXPECTED: Record<State, Partial<Record<EventKind, State>>> = {
  CREATED: { 'payment.attempted': 'ATTEMPTED' },
  ATTEMPTED: {
    'payment.authorized': 'AUTHORIZED',
    'payment.captured': 'CAPTURED',
    'payment.failed': 'FAILED',
  },
  AUTHORIZED: { 'payment.captured': 'CAPTURED', 'payment.failed': 'FAILED' },
  FAILED: { 'payment.attempted': 'ATTEMPTED' },
  CAPTURED: { 'refund.processed': 'REFUNDED' },
  REFUNDED: {},
};

describe('transition — exhaustive over every state × event pair', () => {
  for (const state of STATES) {
    for (const event of EVENT_KINDS) {
      const expected = EXPECTED[state][event];

      if (expected !== undefined) {
        test(`${state} + ${event} → ${expected}`, () => {
          expect(apply(state, event)).toEqual({ ok: true, next: expected, stale: false });
        });
      } else if (isTerminal(state)) {
        test(`${state} + ${event} → TERMINAL_PROTECTED`, () => {
          expect(apply(state, event)).toEqual({ ok: false, error: 'TERMINAL_PROTECTED' });
        });
      } else {
        test(`${state} + ${event} → INVALID_TRANSITION`, () => {
          expect(apply(state, event)).toEqual({ ok: false, error: 'INVALID_TRANSITION' });
        });
      }
    }
  }

  test('covers all 36 pairs', () => {
    expect(STATES.length * EVENT_KINDS.length).toBe(36);
  });
});

describe('rule 2 — terminal protection (the double-charge guard)', () => {
  test('a CAPTURED payment is never re-attempted', () => {
    expect(transition('CAPTURED', 'payment.attempted', T1, T0)).toEqual({
      ok: false,
      error: 'TERMINAL_PROTECTED',
    });
  });

  test('a CAPTURED payment cannot fail', () => {
    expect(transition('CAPTURED', 'payment.failed', T1, T0)).toEqual({
      ok: false,
      error: 'TERMINAL_PROTECTED',
    });
  });

  test('refund.processed is the only move off CAPTURED', () => {
    const moves = EVENT_KINDS.filter((e) => {
      const r = transition('CAPTURED', e, T1, T0);
      return r.ok && !r.stale;
    });
    expect(moves).toEqual(['refund.processed']);
  });

  test('REFUNDED is fully terminal — nothing moves it, not even another refund', () => {
    for (const event of EVENT_KINDS) {
      expect(transition('REFUNDED', event, T1, T0)).toEqual({
        ok: false,
        error: 'TERMINAL_PROTECTED',
      });
    }
  });
});

describe('rule 1 — staleness', () => {
  test('an out-of-order event is recorded and does not move state', () => {
    expect(transition('ATTEMPTED', 'payment.failed', EARLIER, T0)).toEqual({
      ok: true,
      next: 'ATTEMPTED',
      stale: true,
    });
  });

  test('an equal timestamp is not stale — same-instant events still apply', () => {
    expect(transition('ATTEMPTED', 'payment.failed', T0, T0)).toEqual({
      ok: true,
      next: 'FAILED',
      stale: false,
    });
  });

  test('staleness is checked BEFORE terminal protection (§7.1 rule order)', () => {
    // A late event for an already-captured payment is ordinary traffic, not an
    // attempt to touch a terminal payment. Reporting it as TERMINAL_PROTECTED
    // would make normal reordering look like a bug.
    expect(transition('CAPTURED', 'payment.failed', EARLIER, T0)).toEqual({
      ok: true,
      next: 'CAPTURED',
      stale: true,
    });
  });

  test('a stale event never moves state, for every state and event', () => {
    for (const state of STATES) {
      for (const event of EVENT_KINDS) {
        expect(transition(state, event, EARLIER, T0)).toEqual({
          ok: true,
          next: state,
          stale: true,
        });
      }
    }
  });
});

describe('rule 3 — a FAILED payment may re-enter ATTEMPTED', () => {
  test('that is what a recovery retry is', () => {
    expect(transition('FAILED', 'payment.attempted', T1, T0)).toEqual({
      ok: true,
      next: 'ATTEMPTED',
      stale: false,
    });
  });

  test('and it increments attempt_index', () => {
    expect(incrementsAttemptIndex('FAILED', 'ATTEMPTED')).toBe(true);
  });

  test('a first attempt does not', () => {
    expect(incrementsAttemptIndex('CREATED', 'ATTEMPTED')).toBe(false);
  });
});

describe('§8.6 — the gateway emits attempted then captured on recovery', () => {
  test('ATTEMPTED → CAPTURED is legal, or no recovery could ever complete', () => {
    expect(transition('ATTEMPTED', 'payment.captured', T1, T0)).toEqual({
      ok: true,
      next: 'CAPTURED',
      stale: false,
    });
  });

  test('the full recovery path: FAILED → ATTEMPTED → CAPTURED', () => {
    const retry = transition('FAILED', 'payment.attempted', T1, T0);
    expect(retry).toMatchObject({ ok: true, next: 'ATTEMPTED' });
    const captured = transition('ATTEMPTED', 'payment.captured', '2026-07-25T10:10:00.000Z', T1);
    expect(captured).toMatchObject({ ok: true, next: 'CAPTURED' });
  });
});

describe('unknown input', () => {
  test('an unrecognised state is UNKNOWN_STATE, not a crash', () => {
    expect(transition('PENDING' as State, 'payment.failed', T1, T0)).toEqual({
      ok: false,
      error: 'UNKNOWN_STATE',
    });
  });

  test('an unrecognised event is UNKNOWN_STATE', () => {
    expect(transition('ATTEMPTED', 'payment.disputed' as EventKind, T1, T0)).toEqual({
      ok: false,
      error: 'UNKNOWN_STATE',
    });
  });

  test('an unparseable timestamp refuses rather than guessing the order', () => {
    expect(transition('ATTEMPTED', 'payment.failed', 'not-a-date', T0)).toEqual({
      ok: false,
      error: 'INVALID_TRANSITION',
    });
    expect(transition('ATTEMPTED', 'payment.failed', T1, 'not-a-date')).toEqual({
      ok: false,
      error: 'INVALID_TRANSITION',
    });
  });
});

describe('isTerminal', () => {
  test('exactly CAPTURED and REFUNDED', () => {
    expect(STATES.filter(isTerminal)).toEqual(['CAPTURED', 'REFUNDED']);
  });
});

describe('abandonment', () => {
  const idleMs = ABANDONMENT_IDLE_MINUTES * 60_000;
  const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

  test('ATTEMPTED and idle for 30 simulated minutes is abandoned', () => {
    expect(isAbandoned('ATTEMPTED', T0, at(idleMs))).toBe(true);
  });

  test('one minute short is not', () => {
    expect(isAbandoned('ATTEMPTED', T0, at(idleMs - 60_000))).toBe(false);
  });

  test('only ATTEMPTED payments can be abandoned', () => {
    for (const state of STATES.filter((s) => s !== 'ATTEMPTED')) {
      expect(isAbandoned(state, T0, at(idleMs * 10))).toBe(false);
    }
  });

  test('a bad timestamp does not report abandonment', () => {
    expect(isAbandoned('ATTEMPTED', 'nope', at(idleMs))).toBe(false);
  });
});
