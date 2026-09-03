import { describe, expect, test } from 'bun:test';
import {
  FEATURE_NAMES,
  PROBABILITY_CEILING,
  PROBABILITY_FLOOR,
  baselineOdds,
  baselineProbability,
  encode,
  predict,
  secondaryRouteSupports,
  type Features,
} from './recovery-model.ts';

const base: Features = {
  failedAt: '2026-07-28T14:30:00.000Z',
  amountPaise: 250_000,
  method: 'card',
  bank: null,
  failureCode: 'CARD_DECLINED',
  attemptIndex: 1,
  customerPriorAttempts: 3,
  customerPriorSuccessRate: 0.8,
  merchantPriorSuccessRate: 0.92,
  secondsSinceLastAttempt: 600,
  incidentActive: false,
  secondaryRouteAvailable: true,
};

const f = (over: Partial<Features> = {}): Features => ({ ...base, ...over });

describe('§7.5 — the measured baseline table', () => {
  test('a transient failure is most recoverable by simply retrying', () => {
    const o = baselineOdds(f({ failureCode: 'GATEWAY_ERROR' }));
    expect(o.retry).toBeCloseTo(0.72, 2);
    expect(o.retry).toBeGreaterThan(o.payment_link);
  });

  test('an expired card will not become unexpired, so retrying is near zero', () => {
    const o = baselineOdds(f({ failureCode: 'CARD_EXPIRED' }));
    expect(o.retry).toBeCloseTo(0.04, 2);
    // Asking for a different instrument is the thing that works.
    expect(o.alternate_method).toBeGreaterThan(o.retry * 10);
  });

  test('fraud recovers under nothing', () => {
    const o = baselineOdds(f({ failureCode: 'FRAUD_SUSPECTED' }));
    for (const v of [o.retry, o.payment_link, o.alternate_method]) expect(v).toBeLessThan(0.05);
    expect(baselineProbability(f({ failureCode: 'FRAUD_SUSPECTED' }))).toBeLessThan(0.05);
  });

  test('an abandoned checkout is the most recoverable of all — nothing was wrong', () => {
    const o = baselineOdds(f({ failureCode: 'CHECKOUT_ABANDONED' }));
    expect(o.payment_link).toBeCloseTo(0.62, 2);
  });

  test('an unknown code sits near the floor — unknown means ask a human', () => {
    expect(baselineProbability(f({ failureCode: 'SOMETHING_NEW' }))).toBeLessThan(0.15);
  });
});

describe('§1.1 — the cross-border asymmetry, as a number', () => {
  const threeds = f({ failureCode: 'THREEDS_FAILED', method: 'card' });

  test('a second processor is the only intervention above the floor', () => {
    const o = baselineOdds(threeds);
    // Same route, same challenge, same failure.
    expect(o.retry).toBeCloseTo(0.09, 2);
    expect(o.alternate_gateway).toBeCloseTo(0.62, 2);
    expect(o.alternate_gateway).toBeGreaterThan(o.retry * 6);
    expect(o.alternate_gateway).toBeGreaterThan(o.payment_link);
    expect(o.alternate_gateway).toBeGreaterThan(o.alternate_method);
  });

  test('and on a domestic insufficient-funds it is the worst option', () => {
    // Or the engine is just a second retry bot (§7.6).
    const o = baselineOdds(f({ failureCode: 'INSUFFICIENT_FUNDS', method: 'card' }));
    expect(o.alternate_gateway).toBeLessThan(o.retry);
    expect(o.alternate_gateway).toBeLessThan(o.payment_link);
  });

  test('the route is unavailable on INR-only instruments, so it is not offered', () => {
    // §8.6: the secondary processor refuses UPI, netbanking and RuPay. Offering
    // it there would be offering something that cannot happen.
    const upi = baselineOdds(
      f({ failureCode: 'PAYMENT_TIMEOUT', method: 'upi', secondaryRouteAvailable: false }),
    );
    expect(upi.alternate_gateway).toBe(PROBABILITY_FLOOR);
  });

  test('secondaryRouteSupports encodes exactly that rule', () => {
    expect(secondaryRouteSupports('card', 'visa')).toBe(true);
    expect(secondaryRouteSupports('card', 'mastercard')).toBe(true);
    expect(secondaryRouteSupports('card', 'rupay')).toBe(false);
    expect(secondaryRouteSupports('upi', null)).toBe(false);
    expect(secondaryRouteSupports('netbanking', null)).toBe(false);
  });
});

describe('§7.5 — the adjustments', () => {
  test('each additional attempt discounts by 0.62', () => {
    const one = baselineOdds(f({ failureCode: 'GATEWAY_ERROR', attemptIndex: 1 })).retry;
    const two = baselineOdds(f({ failureCode: 'GATEWAY_ERROR', attemptIndex: 2 })).retry;
    const three = baselineOdds(f({ failureCode: 'GATEWAY_ERROR', attemptIndex: 3 })).retry;
    expect(two).toBeCloseTo(one * 0.62, 3);
    expect(three).toBeCloseTo(one * 0.62 * 0.62, 3);
  });

  test('a live incident lifts retry by 1.25, and only retry', () => {
    // The cause is temporary and external to the customer, so waiting and
    // trying the same route again is what becomes more likely to work.
    const quiet = baselineOdds(f({ failureCode: 'BANK_DOWN', incidentActive: false }));
    const during = baselineOdds(f({ failureCode: 'BANK_DOWN', incidentActive: true }));
    expect(during.retry).toBeCloseTo(Math.min(0.95, quiet.retry * 1.25), 3);
    expect(during.payment_link).toBeCloseTo(quiet.payment_link, 6);
    expect(during.alternate_method).toBeCloseTo(quiet.alternate_method, 6);
  });

  test('everything is clamped to [0.01, 0.95]', () => {
    const many = baselineOdds(f({ failureCode: 'FRAUD_SUSPECTED', attemptIndex: 12 }));
    for (const v of Object.values(many)) {
      expect(v).toBeGreaterThanOrEqual(PROBABILITY_FLOOR);
      expect(v).toBeLessThanOrEqual(PROBABILITY_CEILING);
    }
    const lifted = baselineOdds(f({ failureCode: 'GATEWAY_ERROR', incidentActive: true }));
    expect(lifted.retry).toBeLessThanOrEqual(PROBABILITY_CEILING);
  });

  test('the case probability is the best any single intervention could achieve', () => {
    // Matching the ground-truth definition of `recoverable` — the disjunction
    // of the four counterfactuals — so baseline and model predict the same
    // thing and their calibration curves are comparable.
    const feat = f({ failureCode: 'THREEDS_FAILED' });
    const o = baselineOdds(feat);
    expect(baselineProbability(feat)).toBeCloseTo(
      Math.max(o.retry, o.payment_link, o.alternate_method, o.alternate_gateway),
      6,
    );
  });
});

describe('encoding — one pipeline for training and serving', () => {
  test('the vector length matches the declared feature names', () => {
    expect(encode(base)).toHaveLength(FEATURE_NAMES.length);
  });

  test('method and family are one-hot', () => {
    const v = encode(f({ method: 'card', failureCode: 'THREEDS_FAILED' }));
    expect(v.slice(0, 4)).toEqual([0, 1, 0, 0]); // upi, card, netbanking, wallet
    expect(v.slice(4, 9)).toEqual([0, 0, 0, 0, 1]); // …CROSS_BORDER last
  });

  test('"no previous attempt" is an indicator, not a zero gap', () => {
    // A negative value means the payment has no history. Squashing it into
    // "zero seconds ago" teaches the model the opposite of the truth.
    const withPrior = encode(f({ secondsSinceLastAttempt: 0 }));
    const without = encode(f({ secondsSinceLastAttempt: -1 }));
    const idx = FEATURE_NAMES.indexOf('no_prior_attempt');
    expect(withPrior[idx]).toBe(0);
    expect(without[idx]).toBe(1);
  });

  test('hour of day is cyclic in IST, so 23:00 and 00:00 are adjacent', () => {
    const sin = FEATURE_NAMES.indexOf('hour_sin');
    const cos = FEATURE_NAMES.indexOf('hour_cos');
    // 18:30 UTC is midnight IST.
    const midnightIst = encode(f({ failedAt: '2026-07-28T18:30:00.000Z' }));
    const elevenPmIst = encode(f({ failedAt: '2026-07-28T17:30:00.000Z' }));
    const distance = Math.hypot(
      midnightIst[sin]! - elevenPmIst[sin]!,
      midnightIst[cos]! - elevenPmIst[cos]!,
    );
    expect(distance).toBeLessThan(0.3);
  });

  test('amount is log1p, so the tail does not dominate every other feature', () => {
    const idx = FEATURE_NAMES.indexOf('log1p(amount_paise)');
    expect(encode(f({ amountPaise: 250_000 }))[idx]).toBeCloseTo(Math.log1p(250_000), 6);
  });

  test('encoding is deterministic', () => {
    expect(encode(base)).toEqual(encode(base));
  });
});

describe('serving', () => {
  test('with no active model it scores from the baseline and says so', () => {
    // The fallback is not optional: a payment that fails while the model is
    // down is exactly the payment worth acting on (§7.5).
    const r = predict(base, null);
    expect(r.source).toBe('baseline');
    expect(r.probability).toBeCloseTo(baselineProbability(base), 6);
  });

  test('a model with the wrong feature count falls back rather than guessing', () => {
    const r = predict(base, {
      coefficients: [0.1, 0.2],
      intercept: 0,
      means: [0, 0],
      stdDevs: [1, 1],
      calibration: [],
    });
    // Scoring mismatched columns would produce a confident, meaningless number.
    expect(r.source).toBe('baseline');
  });

  test('a well-formed model is used, and its output is clamped', () => {
    const n = FEATURE_NAMES.length;
    const r = predict(base, {
      coefficients: new Array(n).fill(0),
      intercept: 40, // saturates the sigmoid
      means: new Array(n).fill(0),
      stdDevs: new Array(n).fill(1),
      calibration: [],
    });
    expect(r.source).toBe('model');
    expect(r.probability).toBeLessThanOrEqual(PROBABILITY_CEILING);
    expect(r.probability).toBeGreaterThanOrEqual(PROBABILITY_FLOOR);
  });
});
