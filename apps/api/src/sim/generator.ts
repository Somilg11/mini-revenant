import { createHash } from 'node:crypto';
import { Rng } from '../lib/rng.ts';
import { amountBand, type AmountBand } from '../domain/money.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import type { PaymentMethod } from '../app/events.ts';

/**
 * Deterministic dataset generator (§8).
 *
 * PURE with respect to the world: no database, no clock, no network. Everything
 * comes from the seed, so the same seed produces the same checksum on any
 * machine (§8.1) and "we detected 5 of 5 incidents" is a claim somebody else
 * can reproduce rather than a screenshot.
 *
 * The distributions are not decoration. Each one exists because getting it
 * wrong would invalidate a later phase:
 *
 *  - **Method mix follows Indian commerce.** A card-heavy dataset tunes
 *    everything for a market this product does not serve.
 *  - **Amounts are log-normal.** A symmetric distribution leaves no tail for
 *    the high-value incident to live in.
 *  - **Traffic has a daily rhythm.** A detector tuned on flat traffic calls
 *    every evening an anomaly.
 *  - **Failure codes are tied to the method.** A code on the wrong method
 *    teaches the model a relationship that does not exist.
 *  - **International failure rate is 19% against 7% domestic.** That gap *is*
 *    the product (§1.1), and it must exist in the data before any detection
 *    runs.
 */

export const GENERATOR_VERSION = 'gen-1.0.0';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export interface GeneratorParams {
  seed: number;
  payments: number;
  merchants: readonly string[];
  days: number;
  /** Exclusive end of the window. Fixed, never `now`, so runs are comparable. */
  endsAt: string;
  /** Domestic draw rate. See the note on `INTERNATIONAL_FAILURE_RATE`. */
  baselineFailureRate: number;
  /** International draw rate — §1.1's wedge, and the reason it is a parameter. */
  internationalFailureRate: number;
}

export const DEFAULT_PARAMS: Omit<GeneratorParams, 'merchants'> = {
  seed: 42,
  payments: 75000,
  days: 7,
  endsAt: '2026-08-01T00:00:00Z',
  baselineFailureRate: 0.051,
  internationalFailureRate: 0.138,
};

// ── Distributions (§8.1) ─────────────────────────────────────────────────────

const METHOD_MIX: readonly (readonly [PaymentMethod, number])[] = [
  ['upi', 0.548],
  ['card', 0.249],
  ['netbanking', 0.122],
  ['wallet', 0.081],
];

const BANKS = ['HDFC', 'ICICI', 'SBI', 'AXIS', 'KOTAK'] as const;

/** Card-only, and the countries an Indian SaaS actually sells into. */
const CARD_COUNTRIES = ['US', 'GB', 'DE', 'AE', 'SG', 'AU'] as const;
const INTERNATIONAL_NETWORKS = ['visa', 'mastercard', 'amex'] as const;
const DOMESTIC_NETWORKS = ['visa', 'mastercard', 'rupay'] as const;

const INTERNATIONAL_SHARE = 0.18;
/**
 * The rates in `DEFAULT_PARAMS` are **draw** rates, not observed rates.
 * Customer failure-runs, incident windows and noise all push the observed rate
 * above the draw rate, so they are calibrated so the dataset lands on §8.1's
 * stated ~19% international against ~7% domestic once everything is applied.
 * Calibrated against the generated output, not guessed — the gap is the
 * product (§1.1), so the tests assert it.
 */
const THREEDS_SHARE = 0.7;

/** Median ₹1,200 domestic; international ~2.4× because they are subscriptions. */
const DOMESTIC_MEDIAN_RUPEES = 1200;
const INTERNATIONAL_AMOUNT_MULTIPLIER = 2.4;
const AMOUNT_SIGMA = 1.1;

const CUSTOMERS_PER_MERCHANT = 400;
/**
 * A fifth of customers generate most of the traffic (§8.1). `pickCustomerIndex`
 * implements the skew by choosing a bucket first, then a member of it, so the
 * heavy share is the only constant needed.
 */
const HEAVY_CUSTOMER_SHARE = 0.2;

/** Failing once raises the odds of failing again; a success resets the run. */
const FAILURE_RUN_MULTIPLIER = 2.1;
const ABANDONMENT_SHARE_OF_UNSUCCESSFUL = 0.35;

/**
 * Hour-of-day traffic weights in **IST**: near-dead at 04:00, peak around 19:00.
 * Index is the IST hour.
 */
const HOUR_WEIGHTS = [
  0.35, 0.22, 0.14, 0.09, 0.07, 0.10, 0.22, 0.40, 0.62, 0.80, 0.95, 1.05,
  1.12, 1.05, 0.98, 1.00, 1.10, 1.28, 1.52, 1.70, 1.58, 1.24, 0.86, 0.55,
] as const;

const WEEKEND_DAMPING = 0.78;

/** Failure codes by method — domestic only. Cross-border codes never appear here. */
const DOMESTIC_CODES: Record<PaymentMethod, readonly (readonly [string, number])[]> = {
  upi: [
    ['PAYMENT_TIMEOUT', 0.30],
    ['INSUFFICIENT_FUNDS', 0.26],
    ['BANK_DOWN', 0.18],
    ['INCORRECT_OTP', 0.14],
    ['NETWORK_ERROR', 0.12],
  ],
  card: [
    ['CARD_DECLINED', 0.30],
    ['INSUFFICIENT_FUNDS', 0.22],
    ['CARD_EXPIRED', 0.16],
    ['INCORRECT_OTP', 0.14],
    ['GATEWAY_ERROR', 0.11],
    ['FRAUD_SUSPECTED', 0.07],
  ],
  netbanking: [
    ['BANK_DOWN', 0.34],
    ['GATEWAY_ERROR', 0.26],
    ['PAYMENT_TIMEOUT', 0.24],
    ['INVALID_ACCOUNT', 0.16],
  ],
  wallet: [
    ['INSUFFICIENT_FUNDS', 0.36],
    ['PAYMENT_LIMIT_EXCEEDED', 0.28],
    ['NETWORK_ERROR', 0.20],
    ['GATEWAY_ERROR', 0.16],
  ],
};

/** Cross-border failures skew hard to the CROSS_BORDER family (§7.2). */
const INTERNATIONAL_CODES: readonly (readonly [string, number])[] = [
  ['THREEDS_FAILED', 0.28],
  ['INTERNATIONAL_CARD_BLOCKED', 0.20],
  ['ISSUER_DECLINED_CROSS_BORDER', 0.18],
  ['THREEDS_NOT_SUPPORTED', 0.12],
  ['CURRENCY_NOT_SUPPORTED', 0.07],
  ['CARD_DECLINED', 0.08],
  ['FRAUD_SUSPECTED', 0.04],
  ['GATEWAY_ERROR', 0.03],
];

// ── Counterfactual probabilities (§7.5, §8.3) ────────────────────────────────

interface RecoveryOdds {
  retry: number;
  link: number;
  alternate: number;
  gateway: number;
}

/**
 * The table from §7.5, keyed by code.
 *
 * The `gateway` column is the argument of §1.1 expressed as a number:
 * 0.55–0.62 for cross-border codes and near the floor for everything else.
 * Routing the same card through a second processor is the only intervention
 * whose probability sits meaningfully above zero when the *route* is what
 * failed rather than the card.
 */
const RECOVERY_ODDS: Record<string, RecoveryOdds> = {
  // TRANSIENT — the same payment later usually works.
  GATEWAY_ERROR: { retry: 0.72, link: 0.6, alternate: 0.63, gateway: 0.4 },
  BANK_DOWN: { retry: 0.72, link: 0.6, alternate: 0.63, gateway: 0.35 },
  PAYMENT_TIMEOUT: { retry: 0.72, link: 0.6, alternate: 0.63, gateway: 0.35 },
  NETWORK_ERROR: { retry: 0.72, link: 0.6, alternate: 0.63, gateway: 0.35 },

  // CUSTOMER.
  INSUFFICIENT_FUNDS: { retry: 0.18, link: 0.46, alternate: 0.32, gateway: 0.08 },
  CARD_EXPIRED: { retry: 0.04, link: 0.38, alternate: 0.55, gateway: 0.05 },
  CARD_DECLINED: { retry: 0.22, link: 0.44, alternate: 0.48, gateway: 0.12 },
  INCORRECT_OTP: { retry: 0.22, link: 0.44, alternate: 0.48, gateway: 0.1 },
  PAYMENT_LIMIT_EXCEEDED: { retry: 0.22, link: 0.44, alternate: 0.48, gateway: 0.08 },

  // TERMINAL — recovers under nothing.
  FRAUD_SUSPECTED: { retry: 0.01, link: 0.02, alternate: 0.02, gateway: 0.01 },
  INVALID_ACCOUNT: { retry: 0.01, link: 0.02, alternate: 0.02, gateway: 0.01 },

  // ABANDONMENT — most recoverable; nothing was ever wrong.
  CHECKOUT_ABANDONED: { retry: 0.3, link: 0.62, alternate: 0.45, gateway: 0.12 },

  // CROSS_BORDER — same route, same challenge, same failure.
  THREEDS_FAILED: { retry: 0.09, link: 0.28, alternate: 0.34, gateway: 0.62 },
  THREEDS_NOT_SUPPORTED: { retry: 0.09, link: 0.28, alternate: 0.34, gateway: 0.6 },
  INTERNATIONAL_CARD_BLOCKED: { retry: 0.06, link: 0.24, alternate: 0.3, gateway: 0.58 },
  ISSUER_DECLINED_CROSS_BORDER: { retry: 0.06, link: 0.24, alternate: 0.3, gateway: 0.57 },
  CURRENCY_NOT_SUPPORTED: { retry: 0.02, link: 0.2, alternate: 0.26, gateway: 0.55 },
};

const UNKNOWN_ODDS: RecoveryOdds = { retry: 0.05, link: 0.1, alternate: 0.1, gateway: 0.05 };

/**
 * The secondary processor refuses INR-only instruments (§8.6), so
 * `alternate_gateway` is simply unavailable on most domestic traffic — the
 * strategy engine has to earn that choice rather than defaulting to it.
 */
function secondaryRouteSupports(method: PaymentMethod, network: string | null): boolean {
  if (method !== 'card') return false;
  return network !== 'rupay';
}

// ── Injected incidents (§8.2) ────────────────────────────────────────────────

export type IncidentKind =
  | 'BANK_OUTAGE'
  | 'METHOD_DEGRADATION'
  | 'HIGH_VALUE_FAILURES'
  | 'CUSTOMER_COHORT'
  | 'ABANDONMENT_SPIKE'
  | 'INTERNATIONAL_3DS_BLOCK';

interface IncidentSpec {
  kind: IncidentKind;
  durationHours: number;
  peakRate: number;
  /** The tuple that actually degraded — the answer key for RCA. */
  dimensions: Record<string, string>;
  matches: (p: DraftPayment) => boolean;
  /** Overrides the code drawn for a payment caught by this incident. */
  code?: string;
}

interface DraftPayment {
  id: string;
  merchantId: string;
  customerId: string;
  customerIndex: number;
  amountPaise: number;
  method: PaymentMethod;
  bank: string | null;
  cardCountry: string | null;
  cardNetwork: string | null;
  isInternational: boolean;
  threedsRequired: boolean;
  createdAt: number;
  band: AmountBand;
}

export interface GeneratedEvent {
  eventId: string;
  paymentId: string;
  kind: 'payment.created' | 'payment.attempted' | 'payment.authorized' | 'payment.captured' | 'payment.failed';
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface GeneratedPayment {
  id: string;
  merchantId: string;
  customerId: string;
  amountPaise: number;
  method: PaymentMethod;
  bank: string | null;
  currency: string;
  cardCountry: string | null;
  cardNetwork: string | null;
  isInternational: boolean;
  threedsRequired: boolean;
  gateway: string;
  createdAt: string;
  outcome: 'captured' | 'failed' | 'abandoned';
  failureCode: string | null;
  events: GeneratedEvent[];
}

export interface GroundTruthIncident {
  id: string;
  kind: IncidentKind;
  startedAt: string;
  endedAt: string;
  dimensions: Record<string, string>;
  affectedPayments: number;
  revenueAtRiskPaise: number;
}

export interface GeneratedLabel {
  paymentId: string;
  recoverableByRetry: boolean;
  recoverableByLink: boolean;
  recoverableByAlternate: boolean;
  recoverableByGateway: boolean;
  recoverable: boolean;
  split: 'train' | 'val' | 'test';
}

export interface GeneratedCustomer {
  id: string;
  merchantId: string;
  lifetimeValuePaise: number;
  optedOut: boolean;
}

export interface DatasetDefect {
  kind: string;
  detail: string;
}

export interface Dataset {
  params: GeneratorParams;
  generatorVersion: string;
  checksum: string;
  customers: GeneratedCustomer[];
  payments: GeneratedPayment[];
  incidents: GroundTruthIncident[];
  /** Deliberately unlabelled — a detector that fires on these is wrong (§8.4). */
  noiseWindows: { startedAt: string; endedAt: string }[];
  labels: GeneratedLabel[];
  defects: DatasetDefect[];
  stats: DatasetStats;
}

export interface DatasetStats {
  total: number;
  captured: number;
  failed: number;
  abandoned: number;
  international: number;
  internationalFailureRate: number;
  domesticFailureRate: number;
  overallFailureRate: number;
  byMethod: Record<string, number>;
  byFamily: Record<string, number>;
}

export function generate(params: GeneratorParams): Dataset {
  const rng = new Rng(params.seed);
  const endsAt = Date.parse(params.endsAt);
  const startsAt = endsAt - params.days * 24 * 60 * 60 * 1000;

  // ── Customers ──────────────────────────────────────────────────────────────
  const customers: GeneratedCustomer[] = [];
  const heavy: boolean[] = [];
  for (const merchantId of params.merchants) {
    for (let i = 0; i < CUSTOMERS_PER_MERCHANT; i += 1) {
      customers.push({
        id: `cus_${merchantId.replace(/^mch_/, '')}_${String(i).padStart(4, '0')}`,
        merchantId,
        lifetimeValuePaise: Math.round(rng.logNormal(180000, 1.2)),
        // A small share have opted out. Policy rule 3 must have something to
        // refuse, or the rule is untested.
        optedOut: rng.bool(0.03),
      });
      heavy.push(rng.next() < HEAVY_CUSTOMER_SHARE);
    }
  }

  // ── Timestamps, following the daily rhythm ────────────────────────────────
  const hourWeights: number[] = [];
  for (let h = 0; h < params.days * 24; h += 1) {
    const utcMs = startsAt + h * 3600_000;
    const ist = new Date(utcMs + IST_OFFSET_MS);
    const istHour = ist.getUTCHours();
    const istDay = ist.getUTCDay();
    const weekend = istDay === 0 || istDay === 6;
    hourWeights.push(HOUR_WEIGHTS[istHour]! * (weekend ? WEEKEND_DAMPING : 1));
  }

  const drafts: DraftPayment[] = [];
  for (let i = 0; i < params.payments; i += 1) {
    const hour = pickWeightedIndex(rng, hourWeights);
    const createdAt = startsAt + hour * 3600_000 + rng.int(0, 3599) * 1000;

    const customerIndex = pickCustomerIndex(rng, customers.length, heavy);
    const customer = customers[customerIndex]!;

    const isInternational = rng.bool(INTERNATIONAL_SHARE);
    const method: PaymentMethod = isInternational ? 'card' : rng.weighted(METHOD_MIX);

    const medianRupees = isInternational
      ? DOMESTIC_MEDIAN_RUPEES * INTERNATIONAL_AMOUNT_MULTIPLIER
      : DOMESTIC_MEDIAN_RUPEES;
    const amountPaise = Math.max(100, Math.round(rng.logNormal(medianRupees, AMOUNT_SIGMA) * 100));

    const cardNetwork =
      method === 'card'
        ? isInternational
          ? rng.pick(INTERNATIONAL_NETWORKS)
          : rng.pick(DOMESTIC_NETWORKS)
        : null;

    drafts.push({
      id: `pay_${params.seed}_${String(i).padStart(5, '0')}`,
      merchantId: customer.merchantId,
      customerId: customer.id,
      customerIndex,
      amountPaise,
      method,
      bank: isInternational ? null : rng.pick(BANKS),
      cardCountry: isInternational ? rng.pick(CARD_COUNTRIES) : method === 'card' ? 'IN' : null,
      cardNetwork,
      isInternational,
      threedsRequired: isInternational ? rng.bool(THREEDS_SHARE) : false,
      createdAt,
      band: amountBand(amountPaise),
    });
  }

  drafts.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  // ── Injected incidents, placed in daytime IST traffic ─────────────────────
  const cohortCustomers = new Set<number>();
  for (let i = 0; i < customers.length; i += 1) {
    if (i % 10 === 0) cohortCustomers.add(i);
  }
  const outageBank = BANKS[0];

  const specs: IncidentSpec[] = [
    {
      kind: 'BANK_OUTAGE',
      durationHours: 2,
      peakRate: 0.52,
      dimensions: { bank: outageBank },
      matches: (p) => p.bank === outageBank,
    },
    {
      kind: 'METHOD_DEGRADATION',
      durationHours: 3,
      peakRate: 0.35,
      dimensions: { method: 'upi' },
      matches: (p) => p.method === 'upi',
    },
    {
      kind: 'HIGH_VALUE_FAILURES',
      durationHours: 12,
      peakRate: 0.35,
      dimensions: { amount_band: '10k-50k' },
      matches: (p) => p.band === '10k-50k',
    },
    {
      kind: 'CUSTOMER_COHORT',
      durationHours: 5,
      peakRate: 0.6,
      dimensions: { customer_cohort: 'cohort_a' },
      matches: (p) => cohortCustomers.has(p.customerIndex),
    },
    {
      kind: 'ABANDONMENT_SPIKE',
      durationHours: 3,
      peakRate: 0.3,
      dimensions: { method: 'card', outcome: 'abandoned' },
      matches: (p) => p.method === 'card' && !p.isInternational,
      code: 'CHECKOUT_ABANDONED',
    },
    {
      // The centrepiece, and deliberately the hardest to detect: international
      // traffic is 18% of volume, so an 8-hour collapse to 64% moves the
      // *overall* failure rate about four points — a wobble any merchant would
      // put down to noise. Only a per-dimension detector sees it (§8.2).
      kind: 'INTERNATIONAL_3DS_BLOCK',
      durationHours: 8,
      peakRate: 0.64,
      dimensions: {
        is_international: 'true',
        method: 'card',
        failure_code: 'THREEDS_FAILED',
      },
      matches: (p) => p.isInternational && p.method === 'card' && p.threedsRequired,
      code: 'THREEDS_FAILED',
    },
  ];

  const windows = specs.map((spec, i) => {
    const start = daytimeStart(rng, startsAt, endsAt, params.days, i, spec.durationHours);
    return { spec, start, end: start + spec.durationHours * 3600_000 };
  });

  // Two unlabelled windows with mild fluctuation. A detector that fires on
  // these is wrong, and without them "we detected all 5" means nothing (§8.4).
  const noiseWindows = [0, 1].map((i) => {
    const start = daytimeStart(rng, startsAt, endsAt, params.days, 10 + i, 2);
    return { start, end: start + 2 * 3600_000 };
  });

  // ── Outcomes ──────────────────────────────────────────────────────────────
  const failureRun = new Map<number, number>();
  const payments: GeneratedPayment[] = [];
  const incidentCounts = new Map<IncidentKind, { n: number; revenue: number }>();

  for (const d of drafts) {
    let pFail = d.isInternational ? params.internationalFailureRate : params.baselineFailureRate;

    // A customer who just failed is more likely to fail again.
    const run = failureRun.get(d.customerIndex) ?? 0;
    if (run > 0) pFail *= FAILURE_RUN_MULTIPLIER ** Math.min(run, 2);

    // Mild, unlabelled fluctuation — well under the detector's gates.
    for (const w of noiseWindows) {
      if (d.createdAt >= w.start && d.createdAt < w.end) pFail *= 1.5;
    }

    let forcedCode: string | null = null;
    let caughtBy: IncidentSpec | null = null;
    for (const w of windows) {
      if (d.createdAt >= w.start && d.createdAt < w.end && w.spec.matches(d)) {
        pFail = Math.max(pFail, w.spec.peakRate);
        forcedCode = w.spec.code ?? null;
        caughtBy = w.spec;
      }
    }

    pFail = Math.min(0.97, pFail);
    const failed = rng.bool(pFail);

    let outcome: GeneratedPayment['outcome'];
    let failureCode: string | null = null;

    if (!failed) {
      outcome = 'captured';
      failureRun.set(d.customerIndex, 0);
    } else {
      failureRun.set(d.customerIndex, run + 1);
      const abandoned =
        forcedCode === 'CHECKOUT_ABANDONED' || rng.bool(ABANDONMENT_SHARE_OF_UNSUCCESSFUL * 0.5);
      if (abandoned) {
        outcome = 'abandoned';
        // No gateway ever reported a failure, so the payment carries no code
        // on the row (§7.1). The recovery model treats it as CHECKOUT_ABANDONED.
        failureCode = null;
      } else {
        outcome = 'failed';
        failureCode =
          forcedCode && forcedCode !== 'CHECKOUT_ABANDONED'
            ? forcedCode
            : d.isInternational
              ? rng.weighted(INTERNATIONAL_CODES)
              : rng.weighted(DOMESTIC_CODES[d.method]);
      }

    }

    if (caughtBy) {
      // "Affected" means the payment was in the degraded slice during the
      // window, not that it failed. The detector sees attempts *and* failures
      // in that slice, so slice volume is what decides whether the incident is
      // detectable at all — which is exactly what the <20 defect check guards.
      const acc = incidentCounts.get(caughtBy.kind) ?? { n: 0, revenue: 0 };
      acc.n += 1;
      if (outcome !== 'captured') acc.revenue += d.amountPaise;
      incidentCounts.set(caughtBy.kind, acc);
    }

    payments.push(toPayment(d, outcome, failureCode));
  }

  // ── Ground truth ──────────────────────────────────────────────────────────
  const incidents: GroundTruthIncident[] = windows.map((w) => {
    const acc = incidentCounts.get(w.spec.kind) ?? { n: 0, revenue: 0 };
    return {
      id: `gti_${w.spec.kind.toLowerCase()}`,
      kind: w.spec.kind,
      startedAt: new Date(w.start).toISOString(),
      endedAt: new Date(w.end).toISOString(),
      dimensions: w.spec.dimensions,
      affectedPayments: acc.n,
      revenueAtRiskPaise: acc.revenue,
    };
  });

  // Refuse to generate silently (§8.2): a labelled incident nobody could
  // detect scores every detector as a miss, which is a defect in the dataset
  // rather than in the detector.
  const defects: DatasetDefect[] = [];
  for (const inc of incidents) {
    if (inc.affectedPayments < 20) {
      defects.push({
        kind: 'INCIDENT_TOO_SMALL',
        detail: `${inc.kind} affected ${inc.affectedPayments} payments (< 20) — it cannot be detected, and labelling it scores every detector as a miss`,
      });
    }
  }

  // ── Counterfactual labels, decided here and only here (§8.3) ──────────────
  const unsuccessful = payments.filter((p) => p.outcome !== 'captured');
  const labels: GeneratedLabel[] = unsuccessful.map((p, i) => {
    const code = p.failureCode ?? (p.outcome === 'abandoned' ? 'CHECKOUT_ABANDONED' : 'UNKNOWN');
    const odds = RECOVERY_ODDS[code] ?? UNKNOWN_ODDS;

    const byRetry = rng.bool(odds.retry);
    const byLink = rng.bool(odds.link);
    const byAlternate = rng.bool(odds.alternate);
    const routeAvailable = secondaryRouteSupports(p.method, p.cardNetwork);
    const byGateway = routeAvailable && rng.bool(odds.gateway);

    return {
      paymentId: p.id,
      recoverableByRetry: byRetry,
      recoverableByLink: byLink,
      recoverableByAlternate: byAlternate,
      recoverableByGateway: byGateway,
      recoverable: byRetry || byLink || byAlternate || byGateway,
      // Chronological by position, never random: a random split lets the model
      // learn a customer's later behaviour and be tested on their earlier
      // behaviour, so every metric improves and the model collapses (§7.5).
      split: i < unsuccessful.length * 0.7 ? 'train' : i < unsuccessful.length * 0.85 ? 'val' : 'test',
    };
  });

  return {
    params,
    generatorVersion: GENERATOR_VERSION,
    checksum: checksumOf(payments),
    customers,
    payments,
    incidents,
    noiseWindows: noiseWindows.map((w) => ({
      startedAt: new Date(w.start).toISOString(),
      endedAt: new Date(w.end).toISOString(),
    })),
    labels,
    defects,
    stats: statsOf(payments),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickWeightedIndex(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng.next() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

function pickCustomerIndex(rng: Rng, count: number, heavy: readonly boolean[]): number {
  // Two draws rather than a weighted table over 2,000 entries: pick a bucket,
  // then a member. Same distribution, constant cost.
  const wantHeavy = rng.bool(0.72);
  for (let tries = 0; tries < 8; tries += 1) {
    const i = rng.int(0, count - 1);
    if (heavy[i] === wantHeavy) return i;
  }
  return rng.int(0, count - 1);
}

/**
 * An incident placed at 04:00 affects almost nothing, and a ground-truth row
 * asserting an invisible incident scores every detector as a miss. Starts land
 * between 10:00 and 18:00 IST (§8.2).
 */
function daytimeStart(
  rng: Rng,
  startsAt: number,
  endsAt: number,
  days: number,
  index: number,
  durationHours: number,
): number {
  const day = index % days;
  const dayStartUtc = startsAt + day * 24 * 3600_000;
  const istHour = rng.int(10, 18);
  const candidate = dayStartUtc + (istHour * 3600_000 - IST_OFFSET_MS);
  const latest = endsAt - durationHours * 3600_000;
  return Math.min(Math.max(candidate, startsAt), latest);
}

function toPayment(
  d: DraftPayment,
  outcome: GeneratedPayment['outcome'],
  failureCode: string | null,
): GeneratedPayment {
  const createdAt = new Date(d.createdAt).toISOString();
  const attemptedAt = new Date(d.createdAt + 12_000).toISOString();
  const settledAt = new Date(d.createdAt + 34_000).toISOString();

  const base = {
    merchant_id: d.merchantId,
    customer_id: d.customerId,
    amount_paise: d.amountPaise,
    method: d.method,
    bank: d.bank,
    currency: 'INR',
    card_country: d.cardCountry,
    card_network: d.cardNetwork,
    is_international: d.isInternational,
    threeds_required: d.threedsRequired,
    gateway: 'primary',
  };

  const events: GeneratedEvent[] = [
    { eventId: `evt_${d.id}_0`, paymentId: d.id, kind: 'payment.created', occurredAt: createdAt, data: base },
    { eventId: `evt_${d.id}_1`, paymentId: d.id, kind: 'payment.attempted', occurredAt: attemptedAt, data: {} },
  ];

  if (outcome === 'captured') {
    events.push(
      { eventId: `evt_${d.id}_2`, paymentId: d.id, kind: 'payment.authorized', occurredAt: settledAt, data: {} },
      { eventId: `evt_${d.id}_3`, paymentId: d.id, kind: 'payment.captured', occurredAt: settledAt, data: {} },
    );
  } else if (outcome === 'failed') {
    events.push({
      eventId: `evt_${d.id}_2`,
      paymentId: d.id,
      kind: 'payment.failed',
      occurredAt: settledAt,
      data: { failure_code: failureCode },
    });
  }
  // 'abandoned' emits nothing further: no gateway ever reported a failure, so
  // the payment sits in ATTEMPTED until the abandonment sweep flags it (§7.1).

  return {
    id: d.id,
    merchantId: d.merchantId,
    customerId: d.customerId,
    amountPaise: d.amountPaise,
    method: d.method,
    bank: d.bank,
    currency: 'INR',
    cardCountry: d.cardCountry,
    cardNetwork: d.cardNetwork,
    isInternational: d.isInternational,
    threedsRequired: d.threedsRequired,
    gateway: 'primary',
    createdAt,
    outcome,
    failureCode,
    events,
  };
}

/**
 * SHA-256 over each payment's identifying facts, in order. Same seed ⇒ same
 * checksum on any machine, which is what makes the dataset a shared reference
 * rather than one person's local run.
 */
function checksumOf(payments: readonly GeneratedPayment[]): string {
  const h = createHash('sha256');
  for (const p of payments) {
    h.update(
      [
        p.id,
        p.merchantId,
        p.customerId,
        p.amountPaise,
        p.method,
        p.bank ?? '',
        p.cardCountry ?? '',
        p.cardNetwork ?? '',
        p.isInternational ? 1 : 0,
        p.threedsRequired ? 1 : 0,
        p.createdAt,
        p.outcome,
        p.failureCode ?? '',
      ].join('|'),
    );
    h.update('\n');
  }
  return h.digest('hex');
}

function statsOf(payments: readonly GeneratedPayment[]): DatasetStats {
  const byMethod: Record<string, number> = {};
  const byFamily: Record<string, number> = {};
  let captured = 0;
  let failed = 0;
  let abandoned = 0;
  let intl = 0;
  let intlBad = 0;
  let domBad = 0;

  for (const p of payments) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + 1;
    if (p.outcome === 'captured') captured += 1;
    else if (p.outcome === 'failed') failed += 1;
    else abandoned += 1;

    const bad = p.outcome !== 'captured';
    if (p.isInternational) {
      intl += 1;
      if (bad) intlBad += 1;
    } else if (bad) {
      domBad += 1;
    }

    if (bad) {
      const code = p.failureCode ?? (p.outcome === 'abandoned' ? 'CHECKOUT_ABANDONED' : null);
      const fam = failureFamily(code);
      byFamily[fam] = (byFamily[fam] ?? 0) + 1;
    }
  }

  const total = payments.length;
  const domestic = total - intl;
  return {
    total,
    captured,
    failed,
    abandoned,
    international: intl,
    internationalFailureRate: intl === 0 ? 0 : intlBad / intl,
    domesticFailureRate: domestic === 0 ? 0 : domBad / domestic,
    overallFailureRate: total === 0 ? 0 : (failed + abandoned) / total,
    byMethod,
    byFamily,
  };
}
