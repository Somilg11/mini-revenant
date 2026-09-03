import type { ActionKind } from './policy.ts';

/**
 * Execution rules (§8.6, §9).
 *
 * PURE. The parts of the executor and the simulated gateway that carry
 * correctness risk — what to do with each error class, how long to back off,
 * which fault a draw lands on, which route accepts which instrument — live
 * here, free of the database, the clock and the network, so they can be
 * tested exhaustively.
 */

export type ErrorClass = 'RETRYABLE' | 'TERMINAL' | 'NEEDS_HUMAN';

/** At most two retries after the first attempt, then escalate (§8.6). */
export const MAX_RETRIES = 2;
export const MAX_ATTEMPTS = MAX_RETRIES + 1;

export const BACKOFF_BASE_MS = 200;
export const BACKOFF_CAP_MS = 2_000;

/**
 * Capped exponential backoff with jitter. `jitter` is a uniform draw in
 * [0, 1) passed in, never taken here — the schedule is a pure function of the
 * attempt number and the draw.
 */
export function backoffMs(attempt: number, jitter: number): number {
  const exponential = BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(BACKOFF_CAP_MS, exponential);
  // Half fixed, half jittered: never collapses to zero, never doubles the cap.
  return Math.round(capped * (0.5 + 0.5 * jitter));
}

/**
 * Reads the **class** off an error, never its message. An error that carries
 * no class is `NEEDS_HUMAN`: in a money system "I don't know" means "ask a
 * person", never "try it again".
 */
export function classify(err: unknown): ErrorClass {
  if (err !== null && typeof err === 'object') {
    const cls = (err as { errorClass?: unknown }).errorClass;
    if (cls === 'RETRYABLE' || cls === 'TERMINAL' || cls === 'NEEDS_HUMAN') return cls;
  }
  return 'NEEDS_HUMAN';
}

export type Step = 'retry' | 'fail' | 'escalate';

/**
 * What the executor does after attempt number `attempt` failed with `cls`.
 * RETRYABLE retries until the budget is spent, then escalates rather than
 * loops; TERMINAL fails at once; anything else goes to a person.
 */
export function nextStep(cls: ErrorClass, attempt: number): Step {
  if (cls === 'TERMINAL') return 'fail';
  if (cls === 'RETRYABLE' && attempt < MAX_ATTEMPTS) return 'retry';
  return 'escalate';
}

// ── Simulated gateway rules (§8.6) ───────────────────────────────────────────

export type Fault = 'none' | 'retryable' | 'timeout' | 'terminal';

/** 5% RETRYABLE (429/503), 2% timeout with unknown outcome, 1% TERMINAL. */
export const FAULT_RATES = { retryable: 0.05, timeout: 0.02, terminal: 0.01 } as const;

/** Maps one uniform draw in [0, 1) onto the fault table. */
export function drawFault(u: number): Fault {
  if (u < FAULT_RATES.retryable) return 'retryable';
  if (u < FAULT_RATES.retryable + FAULT_RATES.timeout) return 'timeout';
  if (u < FAULT_RATES.retryable + FAULT_RATES.timeout + FAULT_RATES.terminal) return 'terminal';
  return 'none';
}

export type Route = 'primary' | 'secondary';

export function routeFor(kind: ActionKind): Route {
  return kind === 'route_alternate_gateway' ? 'secondary' : 'primary';
}

/**
 * `secondary` refuses INR-only instruments — UPI, netbanking, RuPay — so
 * `alternate_gateway` is unavailable on most domestic traffic and the strategy
 * engine has to earn its choice rather than defaulting to it.
 */
export function routeAccepts(
  route: Route,
  instrument: { method: string; cardNetwork: string | null },
): boolean {
  if (route === 'primary') return true;
  if (instrument.method === 'upi' || instrument.method === 'netbanking') return false;
  if (instrument.method === 'card' && instrument.cardNetwork?.toLowerCase() === 'rupay') return false;
  return true;
}

export type CounterfactualColumn =
  | 'recoverable_by_retry'
  | 'recoverable_by_link'
  | 'recoverable_by_alternate'
  | 'recoverable_by_gateway';

/** The ground-truth label the gateway consults for each intervention (§8.3). */
export function counterfactualFor(kind: ActionKind): CounterfactualColumn | null {
  switch (kind) {
    case 'retry_payment':
      return 'recoverable_by_retry';
    case 'create_payment_link':
      return 'recoverable_by_link';
    case 'notify_customer':
      return 'recoverable_by_alternate';
    case 'route_alternate_gateway':
      return 'recoverable_by_gateway';
    case 'escalate':
      return null;
  }
}

/**
 * Simulated minutes between the action and the gateway's verdict. Direct
 * attribution (P14) is "captured within 30 simulated minutes with our
 * reference", so every kind settles inside that window; the customer-driven
 * kinds take longer because a person has to open a link.
 */
export function settleDelayMinutes(kind: ActionKind, u: number): number {
  const [min, max] =
    kind === 'create_payment_link' || kind === 'notify_customer' ? [5, 25] : [1, 5];
  return min + Math.floor(u * (max - min + 1));
}
