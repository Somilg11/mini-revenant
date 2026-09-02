/**
 * Payment state machine (§7.1).
 *
 * PURE. No database, no clock, no network (§5).
 *
 *   CREATED → ATTEMPTED → FAILED
 *                       → AUTHORIZED → CAPTURED → REFUNDED
 *
 * This module carries the invariant that stops the system charging somebody
 * twice, so it is deliberately free of infrastructure and covered exhaustively
 * by unit tests.
 */

export const STATES = [
  'CREATED',
  'ATTEMPTED',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
] as const;

export type State = (typeof STATES)[number];

export const EVENT_KINDS = [
  'payment.created',
  'payment.attempted',
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.processed',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type TransitionResult =
  | { ok: true; next: State; stale: false }
  | { ok: true; next: State; stale: true } // out-of-order: record it, do not move
  | { ok: false; error: 'INVALID_TRANSITION' | 'UNKNOWN_STATE' | 'TERMINAL_PROTECTED' };

/**
 * Terminal states. Nothing may move a `REFUNDED` payment, and only
 * `refund.processed` may move a `CAPTURED` one.
 */
const TERMINAL_STATES = new Set<State>(['CAPTURED', 'REFUNDED']);

/**
 * The transition table.
 *
 * Two entries are worth reading twice:
 *
 *  - `ATTEMPTED + payment.captured → CAPTURED`. The simulated gateway emits
 *    `payment.attempted` then `payment.captured` when a recovery succeeds
 *    (§8.6). Without this edge a recovered payment could never reach CAPTURED,
 *    and `revenue_recovered` would be structurally zero.
 *  - `FAILED + payment.attempted → ATTEMPTED`. This *is* a recovery retry
 *    (rule 3), and it increments `attempt_index`.
 */
const TABLE: Partial<Record<State, Partial<Record<EventKind, State>>>> = {
  CREATED: {
    'payment.attempted': 'ATTEMPTED',
  },
  ATTEMPTED: {
    'payment.authorized': 'AUTHORIZED',
    'payment.captured': 'CAPTURED',
    'payment.failed': 'FAILED',
  },
  AUTHORIZED: {
    'payment.captured': 'CAPTURED',
    'payment.failed': 'FAILED',
  },
  FAILED: {
    'payment.attempted': 'ATTEMPTED',
  },
  CAPTURED: {
    'refund.processed': 'REFUNDED',
  },
  // REFUNDED is absent: fully terminal.
};

function isState(v: unknown): v is State {
  return typeof v === 'string' && (STATES as readonly string[]).includes(v);
}

function isEventKind(v: unknown): v is EventKind {
  return typeof v === 'string' && (EVENT_KINDS as readonly string[]).includes(v);
}

/**
 * Apply an event to a state.
 *
 * Rules are evaluated in the order §7.1 gives them, and the order matters: the
 * staleness check comes **before** terminal protection, so a late-arriving event
 * for an already-captured payment is recorded as stale rather than reported as
 * an attempt to touch a terminal payment. The first is normal traffic; the
 * second is a bug worth seeing.
 *
 * @param occurredAt   ISO-8601 timestamp of the event, UTC (invariant 7)
 * @param lastEventAt  ISO-8601 timestamp of the newest event already applied
 */
export function transition(
  current: State,
  event: EventKind,
  occurredAt: string,
  lastEventAt: string,
): TransitionResult {
  if (!isState(current) || !isEventKind(event)) {
    return { ok: false, error: 'UNKNOWN_STATE' };
  }

  const occurred = Date.parse(occurredAt);
  const last = Date.parse(lastEventAt);
  if (Number.isNaN(occurred) || Number.isNaN(last)) {
    // Ordering cannot be established, so staleness cannot be decided, so the
    // transition cannot be applied safely. Refuse rather than guess.
    return { ok: false, error: 'INVALID_TRANSITION' };
  }

  // Rule 1 — out-of-order events are normal, not errors. Record, do not move.
  // Equal timestamps are not stale: same-instant events still apply in order.
  if (occurred < last) {
    return { ok: true, next: current, stale: true };
  }

  // Rule 2 — terminal protection. The single rule that stops the system
  // retrying a payment that already succeeded.
  if (TERMINAL_STATES.has(current)) {
    const allowed = TABLE[current]?.[event];
    if (allowed === undefined) return { ok: false, error: 'TERMINAL_PROTECTED' };
    return { ok: true, next: allowed, stale: false };
  }

  // Rules 3 and 4 — the table, then refuse.
  const next = TABLE[current]?.[event];
  if (next === undefined) return { ok: false, error: 'INVALID_TRANSITION' };
  return { ok: true, next, stale: false };
}

/**
 * Whether a transition starts a new attempt, and so increments `attempt_index`.
 *
 * `attempt_index` is the position in the customer's **current failure run**
 * (§7.5), not a lifetime count — a success resets it. Exposed separately so
 * `TransitionResult` keeps the shape §7.1 pins.
 */
export function incrementsAttemptIndex(from: State, to: State): boolean {
  return from === 'FAILED' && to === 'ATTEMPTED';
}

/** Terminal for the recovery pipeline: no action may ever be taken on these. */
export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * A payment left in `ATTEMPTED` with no failure event and no activity for 30
 * simulated minutes is abandoned (§7.1). It stays `ATTEMPTED` — no gateway ever
 * reported a failure — and is flagged instead.
 */
export const ABANDONMENT_IDLE_MINUTES = 30;

export function isAbandoned(
  state: State,
  lastEventAt: string,
  now: string,
  idleMinutes: number = ABANDONMENT_IDLE_MINUTES,
): boolean {
  if (state !== 'ATTEMPTED') return false;
  const last = Date.parse(lastEventAt);
  const at = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(at)) return false;
  return at - last >= idleMinutes * 60_000;
}
