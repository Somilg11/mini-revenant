/**
 * Failure codes → families (§7.2).
 *
 * PURE. No database, no clock, no network (§5).
 *
 * The family is what generalises: a model that has only ever seen
 * `CARD_EXPIRED` can still say something useful about `CARD_DECLINED`.
 */

export const FAILURE_FAMILIES = [
  'TRANSIENT',
  'CUSTOMER',
  'TERMINAL',
  'ABANDONMENT',
  'CROSS_BORDER',
  'UNKNOWN',
] as const;

export type FailureFamily = (typeof FAILURE_FAMILIES)[number];

/**
 * `CROSS_BORDER` is its own family, **not** a subset of `CUSTOMER`.
 *
 * Its recovery profile is completely different: nothing about the customer or
 * their balance is wrong, so a plain retry through the same route fails
 * identically every time, while the same payment on a *different* route often
 * succeeds. Folding these codes into `CUSTOMER` teaches the model that an
 * international 3DS failure behaves like an insufficient-funds decline — the
 * single most expensive mistake available in this dataset, and the one that
 * would erase the entire cross-border argument of §1.1.
 */
const CODE_TO_FAMILY: Readonly<Record<string, FailureFamily>> = {
  // TRANSIENT — the same payment later usually works.
  GATEWAY_ERROR: 'TRANSIENT',
  BANK_DOWN: 'TRANSIENT',
  PAYMENT_TIMEOUT: 'TRANSIENT',
  NETWORK_ERROR: 'TRANSIENT',

  // CUSTOMER — something about this customer or instrument is wrong.
  INSUFFICIENT_FUNDS: 'CUSTOMER',
  CARD_EXPIRED: 'CUSTOMER',
  CARD_DECLINED: 'CUSTOMER',
  INCORRECT_OTP: 'CUSTOMER',
  PAYMENT_LIMIT_EXCEEDED: 'CUSTOMER',

  // TERMINAL — recovers under nothing. Policy rule 4 denies every action.
  FRAUD_SUSPECTED: 'TERMINAL',
  INVALID_ACCOUNT: 'TERMINAL',

  // ABANDONMENT — nothing was ever wrong; the customer simply left.
  CHECKOUT_ABANDONED: 'ABANDONMENT',

  // CROSS_BORDER — the route is the problem, not the card (§1.1).
  THREEDS_FAILED: 'CROSS_BORDER',
  THREEDS_NOT_SUPPORTED: 'CROSS_BORDER',
  INTERNATIONAL_CARD_BLOCKED: 'CROSS_BORDER',
  ISSUER_DECLINED_CROSS_BORDER: 'CROSS_BORDER',
  CURRENCY_NOT_SUPPORTED: 'CROSS_BORDER',
};

/** Every code the generator may emit, grouped. Useful for exhaustive tests. */
export const KNOWN_FAILURE_CODES = Object.keys(CODE_TO_FAMILY) as readonly string[];

/**
 * Classify a failure code.
 *
 * Anything unrecognised — including `null`, for a payment that has not failed —
 * is `UNKNOWN`, and **unknown means ask a human, never retry**. In a money
 * system an unclassified failure is not a reason to try the same thing again.
 */
export function failureFamily(code: string | null | undefined): FailureFamily {
  if (!code) return 'UNKNOWN';
  return CODE_TO_FAMILY[code.toUpperCase()] ?? 'UNKNOWN';
}

/**
 * Families on which no money action may ever be taken.
 *
 * `TERMINAL` recovers under nothing (policy rule 4). `UNKNOWN` is excluded on
 * the principle above: we do not act on a failure we cannot name.
 */
export function isUnactionable(family: FailureFamily): boolean {
  return family === 'TERMINAL' || family === 'UNKNOWN';
}

/**
 * Whether a second processor is even a candidate.
 *
 * True only for `CROSS_BORDER`, which is the asymmetry §1.1 turns into a
 * number: `alternate_gateway` is the one intervention whose probability sits
 * meaningfully above the floor for these codes, and the only one that asks the
 * customer for nothing.
 */
export function isRouteFailure(family: FailureFamily): boolean {
  return family === 'CROSS_BORDER';
}
