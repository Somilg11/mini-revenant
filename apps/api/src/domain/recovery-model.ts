import { failureFamily, isRouteFailure } from './failure-codes.ts';

/**
 * Recovery probability — features, encoding and the measured baseline (§7.5).
 *
 * PURE. No database, no clock, no network (§5).
 *
 * **One encoding pipeline, used by both training and serving.** Skew between
 * those two paths is silent: the model keeps its training metrics and its live
 * predictions are quietly wrong, with nothing in the system to notice. So the
 * feature vector is built here, once, and `ml/train.ts` and the case scorer
 * both call it.
 */

export const STRATEGIES = [
  'retry',
  'payment_link',
  'alternate_method',
  'alternate_gateway',
  'do_nothing',
] as const;

export type Strategy = (typeof STRATEGIES)[number];

/** Strategies that can actually recover money. `do_nothing` never does. */
export type ActingStrategy = Exclude<Strategy, 'do_nothing'>;

export interface Features {
  /** ISO-8601 UTC (invariant 7). Hour-of-day is derived in IST. */
  failedAt: string;
  amountPaise: number;
  method: string;
  bank: string | null;
  failureCode: string;
  /** Position in the customer's CURRENT failure run, not a lifetime count. */
  attemptIndex: number;
  customerPriorAttempts: number;
  customerPriorSuccessRate: number;
  merchantPriorSuccessRate: number;
  /** Negative is an explicit "no history" indicator, not a missing value. */
  secondsSinceLastAttempt: number;
  /** From incidents the DETECTOR opened, never from the answer key. */
  incidentActive: boolean;
  /** Whether a second processor can carry this instrument at all (§8.6). */
  secondaryRouteAvailable: boolean;
}

// ── The measured baseline (§7.5) ─────────────────────────────────────────────

export interface StrategyOdds {
  retry: number;
  payment_link: number;
  alternate_method: number;
  alternate_gateway: number;
}

/**
 * Per-code recovery odds, from §7.5.
 *
 * The `alternate_gateway` column is the argument of §1.1 expressed as a number:
 * meaningfully above the floor for `CROSS_BORDER` codes and near it everywhere
 * else. When the *route* failed rather than the card, sending the same card
 * down a different route is the only intervention that changes anything —
 * retrying the same route re-runs the same challenge and fails identically.
 */
const ODDS: Readonly<Record<string, StrategyOdds>> = {
  // TRANSIENT — the same payment later usually works.
  GATEWAY_ERROR: { retry: 0.72, payment_link: 0.6, alternate_method: 0.63, alternate_gateway: 0.4 },
  BANK_DOWN: { retry: 0.72, payment_link: 0.6, alternate_method: 0.63, alternate_gateway: 0.35 },
  PAYMENT_TIMEOUT: { retry: 0.72, payment_link: 0.6, alternate_method: 0.63, alternate_gateway: 0.35 },
  NETWORK_ERROR: { retry: 0.72, payment_link: 0.6, alternate_method: 0.63, alternate_gateway: 0.35 },

  // CUSTOMER — something about this customer or instrument is wrong.
  INSUFFICIENT_FUNDS: { retry: 0.18, payment_link: 0.46, alternate_method: 0.32, alternate_gateway: 0.08 },
  CARD_EXPIRED: { retry: 0.04, payment_link: 0.38, alternate_method: 0.55, alternate_gateway: 0.05 },
  CARD_DECLINED: { retry: 0.22, payment_link: 0.44, alternate_method: 0.48, alternate_gateway: 0.12 },
  INCORRECT_OTP: { retry: 0.22, payment_link: 0.44, alternate_method: 0.48, alternate_gateway: 0.1 },
  PAYMENT_LIMIT_EXCEEDED: { retry: 0.22, payment_link: 0.44, alternate_method: 0.48, alternate_gateway: 0.08 },

  // TERMINAL — recovers under nothing.
  FRAUD_SUSPECTED: { retry: 0.01, payment_link: 0.02, alternate_method: 0.02, alternate_gateway: 0.01 },
  INVALID_ACCOUNT: { retry: 0.01, payment_link: 0.02, alternate_method: 0.02, alternate_gateway: 0.01 },

  // ABANDONMENT — the most recoverable of all; nothing was ever wrong.
  CHECKOUT_ABANDONED: { retry: 0.3, payment_link: 0.62, alternate_method: 0.45, alternate_gateway: 0.12 },

  // CROSS_BORDER — the route is the problem, not the card.
  THREEDS_FAILED: { retry: 0.09, payment_link: 0.28, alternate_method: 0.34, alternate_gateway: 0.62 },
  THREEDS_NOT_SUPPORTED: { retry: 0.09, payment_link: 0.28, alternate_method: 0.34, alternate_gateway: 0.6 },
  INTERNATIONAL_CARD_BLOCKED: { retry: 0.06, payment_link: 0.24, alternate_method: 0.3, alternate_gateway: 0.58 },
  ISSUER_DECLINED_CROSS_BORDER: { retry: 0.06, payment_link: 0.24, alternate_method: 0.3, alternate_gateway: 0.57 },
  CURRENCY_NOT_SUPPORTED: { retry: 0.02, payment_link: 0.2, alternate_method: 0.26, alternate_gateway: 0.55 },
};

/** Unknown means ask a human, so its odds sit near the floor everywhere. */
const UNKNOWN_ODDS: StrategyOdds = {
  retry: 0.05,
  payment_link: 0.1,
  alternate_method: 0.1,
  alternate_gateway: 0.05,
};

/** A customer who has just failed twice is telling us something. */
const REPEAT_ATTEMPT_MULTIPLIER = 0.62;
/** During a live incident the cause is temporary and external to the customer. */
const INCIDENT_RETRY_MULTIPLIER = 1.25;
export const PROBABILITY_FLOOR = 0.01;
export const PROBABILITY_CEILING = 0.95;

function clamp(p: number): number {
  return Math.min(PROBABILITY_CEILING, Math.max(PROBABILITY_FLOOR, p));
}

/**
 * Per-strategy odds for one failure, with §7.5's adjustments applied.
 *
 * `alternate_gateway` is forced to the floor when no second route can carry the
 * instrument (§8.6: the secondary processor refuses UPI, netbanking and RuPay).
 * Offering it as a live option on a domestic UPI failure would be offering
 * something that cannot happen.
 */
export function baselineOdds(f: Features): StrategyOdds {
  const base = ODDS[f.failureCode?.toUpperCase() ?? ''] ?? UNKNOWN_ODDS;

  // Each attempt beyond the first compounds the discount.
  const repeat = REPEAT_ATTEMPT_MULTIPLIER ** Math.max(0, f.attemptIndex - 1);

  const odds: StrategyOdds = {
    retry: base.retry * repeat,
    payment_link: base.payment_link * repeat,
    alternate_method: base.alternate_method * repeat,
    alternate_gateway: f.secondaryRouteAvailable ? base.alternate_gateway * repeat : 0,
  };

  // The lift applies to retrying, not to every intervention: it is the *cause*
  // that is temporary, so waiting and trying the same route again is what
  // becomes more likely to work.
  if (f.incidentActive) odds.retry *= INCIDENT_RETRY_MULTIPLIER;

  return {
    retry: clamp(odds.retry),
    payment_link: clamp(odds.payment_link),
    alternate_method: clamp(odds.alternate_method),
    alternate_gateway: f.secondaryRouteAvailable ? clamp(odds.alternate_gateway) : PROBABILITY_FLOOR,
  };
}

/**
 * The case-level probability: the best any single intervention could achieve.
 *
 * This matches the ground-truth definition of `recoverable` — the disjunction
 * of the four counterfactuals (§8.3) — so the baseline and the trained model
 * are predicting the same thing and their calibration curves are comparable.
 */
export function baselineProbability(f: Features): number {
  const o = baselineOdds(f);
  return clamp(Math.max(o.retry, o.payment_link, o.alternate_method, o.alternate_gateway));
}

// ── Encoding (§7.5) ──────────────────────────────────────────────────────────

const METHODS = ['upi', 'card', 'netbanking', 'wallet'] as const;
const FAMILIES = ['TRANSIENT', 'CUSTOMER', 'TERMINAL', 'ABANDONMENT', 'CROSS_BORDER'] as const;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Names in the same order `encode` emits them, for the model card. */
export const FEATURE_NAMES: readonly string[] = [
  ...METHODS.map((m) => `method=${m}`),
  ...FAMILIES.map((f) => `family=${f}`),
  'log1p(amount_paise)',
  'log1p(seconds_since_last_attempt)',
  'no_prior_attempt',
  'attempt_index',
  'customer_prior_attempts',
  'customer_prior_success_rate',
  'merchant_prior_success_rate',
  'incident_active',
  'secondary_route_available',
  'hour_sin',
  'hour_cos',
];

/**
 * Feature vector. **The only encoding in the system** — training and serving
 * both call this, because two implementations of "the same" encoding diverge
 * silently and the model keeps reporting its training metrics while its live
 * predictions drift away from them.
 */
export function encode(f: Features): number[] {
  const family = failureFamily(f.failureCode);
  const method = f.method?.toLowerCase() ?? '';

  const oneHotMethod = METHODS.map((m) => (m === method ? 1 : 0));
  const oneHotFamily = FAMILIES.map((x) => (x === family ? 1 : 0));

  // A negative value means "no previous attempt", which is a different thing
  // from "zero seconds ago". It gets its own indicator rather than being
  // squashed into the same number.
  const hasPrior = f.secondsSinceLastAttempt >= 0;
  const gap = hasPrior ? Math.log1p(f.secondsSinceLastAttempt) : 0;

  // Hour of day in **IST**, as sin/cos so 23:00 and 00:00 are adjacent rather
  // than maximally far apart.
  const istHour = new Date(Date.parse(f.failedAt) + IST_OFFSET_MS).getUTCHours();
  const angle = (2 * Math.PI * istHour) / 24;

  return [
    ...oneHotMethod,
    ...oneHotFamily,
    Math.log1p(Math.max(0, f.amountPaise)),
    gap,
    hasPrior ? 0 : 1,
    f.attemptIndex,
    f.customerPriorAttempts,
    f.customerPriorSuccessRate,
    f.merchantPriorSuccessRate,
    f.incidentActive ? 1 : 0,
    f.secondaryRouteAvailable ? 1 : 0,
    Math.sin(angle),
    Math.cos(angle),
  ];
}

// ── Serving ──────────────────────────────────────────────────────────────────

export type ProbabilitySource = 'model' | 'baseline';

export interface ActiveModel {
  /** One weight per `FEATURE_NAMES` entry, plus an intercept. */
  coefficients: number[];
  intercept: number;
  /** Standardisation from the training split — never recomputed at serve time. */
  means: number[];
  stdDevs: number[];
  /** Ten equal-width buckets mapping predicted → observed. */
  calibration: number[];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Scores a failure, falling back to the measured baseline when no model is
 * active.
 *
 * **The fallback is not optional and not a constant** (§7.5). A payment that
 * fails while the model is down is exactly the payment worth acting on, so the
 * system keeps deciding — and every prediction carries the source that produced
 * it, which the UI shows.
 */
export function predict(
  f: Features,
  model: ActiveModel | null,
): { probability: number; source: ProbabilitySource } {
  if (!model) return { probability: baselineProbability(f), source: 'baseline' };

  const x = encode(f);
  if (
    model.coefficients.length !== x.length ||
    model.means.length !== x.length ||
    model.stdDevs.length !== x.length
  ) {
    // The stored model was trained against a different feature vector. Scoring
    // it anyway would produce a confident number from mismatched columns.
    return { probability: baselineProbability(f), source: 'baseline' };
  }

  let z = model.intercept;
  for (let i = 0; i < x.length; i += 1) {
    const sd = model.stdDevs[i]! === 0 ? 1 : model.stdDevs[i]!;
    z += model.coefficients[i]! * ((x[i]! - model.means[i]!) / sd);
  }

  return { probability: clamp(applyCalibration(sigmoid(z), model.calibration)), source: 'model' };
}

/** Maps a raw score through the calibration curve fitted at training time. */
export function applyCalibration(p: number, calibration: readonly number[]): number {
  if (calibration.length === 0) return p;
  const i = Math.min(calibration.length - 1, Math.max(0, Math.floor(p * calibration.length)));
  const mapped = calibration[i];
  return mapped === undefined || Number.isNaN(mapped) ? p : mapped;
}

/** Whether a second processor could carry this instrument at all (§8.6). */
export function secondaryRouteSupports(method: string, network: string | null): boolean {
  if (method !== 'card') return false;
  return network !== 'rupay';
}

export { isRouteFailure };
