import { describe, expect, test } from 'bun:test';
import { choose, customerMultiplier, type StrategyInput } from './strategy.ts';
import { baselineOdds, type Features } from './recovery-model.ts';
import { failureFamily } from './failure-codes.ts';

/** Builds an input straight from the baseline table for a code. */
function input(
  code: string,
  over: Partial<StrategyInput> & { amountPaise?: number; attemptIndex?: number; incidentActive?: boolean } = {},
): StrategyInput {
  const method = over.secondaryRouteAvailable === false ? 'upi' : 'card';
  const f: Features = {
    failedAt: '2026-07-28T14:30:00.000Z',
    amountPaise: over.amountPaise ?? 480_000,
    method,
    bank: method === 'upi' ? 'HDFC' : null,
    failureCode: code,
    attemptIndex: over.attemptIndex ?? 1,
    customerPriorAttempts: 3,
    customerPriorSuccessRate: 0.8,
    merchantPriorSuccessRate: 0.92,
    secondsSinceLastAttempt: 600,
    incidentActive: over.incidentActive ?? false,
    secondaryRouteAvailable: over.secondaryRouteAvailable ?? true,
  };
  return {
    amountPaise: f.amountPaise,
    odds: baselineOdds(f),
    customerLifetimeValuePaise: 250_000,
    customerOptedOut: false,
    secondaryRouteAvailable: f.secondaryRouteAvailable,
    failureFamily: failureFamily(code),
    failureCode: code,
    attemptIndex: f.attemptIndex,
    incidentActive: f.incidentActive,
    ...over,
  };
}

const ev = (d: ReturnType<typeof choose>, s: string) =>
  d.options.find((o) => o.strategy === s)!.expectedValuePaise;

describe('§7.6 — the two assertions that separate this from a second retry bot', () => {
  test('alternate_gateway wins on a CROSS_BORDER code', () => {
    const d = choose(input('THREEDS_FAILED'));
    expect(d.chosen.strategy).toBe('alternate_gateway');
    // The most expensive option, and still the winner — because it is the only
    // one whose probability is not near the floor and the only one that asks
    // the customer for nothing.
    expect(ev(d, 'alternate_gateway')).toBeGreaterThan(ev(d, 'retry') * 3);
    expect(d.options.find((o) => o.strategy === 'alternate_gateway')!.costPaise).toBe(900);
  });

  test('and loses to a plain retry on a domestic INSUFFICIENT_FUNDS', () => {
    const d = choose(input('INSUFFICIENT_FUNDS'));
    expect(d.chosen.strategy).not.toBe('alternate_gateway');
    expect(ev(d, 'retry')).toBeGreaterThan(ev(d, 'alternate_gateway'));
  });
});

describe('§7.6 — the expected-strategy matrix, reproduced by the economics', () => {
  test('temporary bank degradation, incident active → retry', () => {
    const d = choose(input('BANK_DOWN', { incidentActive: true }));
    expect(d.chosen.strategy).toBe('retry');
  });

  test('customer-specific failure → alternate_method', () => {
    expect(choose(input('CARD_EXPIRED')).chosen.strategy).toBe('alternate_method');
  });

  test('checkout abandonment → payment_link', () => {
    expect(choose(input('CHECKOUT_ABANDONED')).chosen.strategy).toBe('payment_link');
  });

  test('multiple prior failures → do_nothing, the odds having collapsed', () => {
    // 0.62 per additional attempt: by the fourth, even a transient failure is
    // not worth ₹2.
    const d = choose(input('GATEWAY_ERROR', { attemptIndex: 6, amountPaise: 2_000 }));
    expect(d.chosen.strategy).toBe('do_nothing');
  });

  test('low-value payment where cost exceeds EV → do_nothing', () => {
    // ₹3 at a 22% chance is 66 paise of expectation against a ₹2 retry.
    const d = choose(input('CARD_DECLINED', { amountPaise: 300 }));
    expect(d.chosen.strategy).toBe('do_nothing');
    for (const o of d.options) {
      if (o.strategy !== 'do_nothing') expect(o.expectedValuePaise).toBeLessThanOrEqual(0);
    }
  });

  test('customer opted out → do_nothing, unconditionally', () => {
    const d = choose(input('GATEWAY_ERROR', { customerOptedOut: true }));
    expect(d.chosen.strategy).toBe('do_nothing');
    for (const o of d.options) {
      if (o.strategy !== 'do_nothing') expect(o.available).toBe(false);
    }
  });

  test('TERMINAL family → do_nothing', () => {
    expect(choose(input('FRAUD_SUSPECTED')).chosen.strategy).toBe('do_nothing');
    expect(choose(input('INVALID_ACCOUNT')).chosen.strategy).toBe('do_nothing');
  });

  test('cross-border with no second route → the customer has to be asked', () => {
    // §8.6: the secondary processor refuses the currency, so the route fix is
    // off the table. Here the spec disagrees with itself: §7.6's matrix says
    // `payment_link` "in the customer's currency", but §7.5's own odds give
    // CURRENCY_NOT_SUPPORTED alternate_method 0.26 against payment_link 0.20,
    // and the matrix's answer assumes a multi-currency presentment capability
    // the odds table never prices. The engine follows the numbers, as §7.6
    // says it must ("the matrix is the sanity check, not a second decision
    // path"), and this test records the disagreement rather than papering over
    // it. Either way the decisive property holds: the route is gone, so the
    // chosen action asks the customer for something.
    const d = choose(input('CURRENCY_NOT_SUPPORTED', { secondaryRouteAvailable: false }));
    expect(d.options.find((o) => o.strategy === 'alternate_gateway')!.available).toBe(false);
    expect(['payment_link', 'alternate_method']).toContain(d.chosen.strategy);
    expect(d.chosen.strategy).toBe('alternate_method'); // what §7.5's odds produce
  });
});

describe('do_nothing is on every ballot', () => {
  test('all five options are returned, always, with the losers visible', () => {
    const d = choose(input('THREEDS_FAILED'));
    expect(d.options.map((o) => o.strategy).sort()).toEqual([
      'alternate_gateway',
      'alternate_method',
      'do_nothing',
      'payment_link',
      'retry',
    ]);
    expect(d.options.find((o) => o.strategy === 'do_nothing')!.expectedValuePaise).toBe(0);
  });

  test('a break-even option does not beat doing nothing', () => {
    // Strictly greater than zero: being wrong about a coin toss costs money.
    const d = choose({
      ...input('CARD_DECLINED', { amountPaise: 1_000 }),
      odds: { retry: 0.2, payment_link: 0.01, alternate_method: 0.01, alternate_gateway: 0.01 },
    });
    // retry: 0.2 × 1000 × 1.05 = 210 gross − 200 cost = 10 → wins narrowly.
    expect(d.chosen.strategy).toBe('retry');
    const tie = choose({
      ...input('CARD_DECLINED', { amountPaise: 1_000 }),
      odds: { retry: 0.19, payment_link: 0.01, alternate_method: 0.01, alternate_gateway: 0.01 },
    });
    // 0.19 × 1000 × 1.05 = 199.5 → 200 gross − 200 = 0 → not strictly better.
    expect(tie.chosen.strategy).toBe('do_nothing');
  });
});

describe('integer paise throughout (invariant 5)', () => {
  test('every money field is a whole number', () => {
    const d = choose(input('THREEDS_FAILED', { amountPaise: 123_457 }));
    for (const o of d.options) {
      expect(Number.isInteger(o.grossValuePaise)).toBe(true);
      expect(Number.isInteger(o.costPaise)).toBe(true);
      expect(Number.isInteger(o.frictionPaise)).toBe(true);
      expect(Number.isInteger(o.expectedValuePaise)).toBe(true);
      expect(o.expectedValuePaise).toBe(o.grossValuePaise - o.costPaise - o.frictionPaise);
    }
  });

  test('friction is a percentage of the amount, cost is fixed', () => {
    const d = choose(input('CHECKOUT_ABANDONED', { amountPaise: 100_000 }));
    const link = d.options.find((o) => o.strategy === 'payment_link')!;
    expect(link.costPaise).toBe(500);
    expect(link.frictionPaise).toBe(500); // 0.5% of ₹1,000
    const alt = d.options.find((o) => o.strategy === 'alternate_method')!;
    expect(alt.frictionPaise).toBe(300); // 0.3%
  });
});

describe('customer multiplier', () => {
  test('1.0 + min(0.5, ltv / ₹50,000), capping at 1.5×', () => {
    expect(customerMultiplier(0)).toBe(1);
    expect(customerMultiplier(2_500_000)).toBe(1.5);
    expect(customerMultiplier(5_000_000)).toBe(1.5);
    expect(customerMultiplier(50_000_000)).toBe(1.5); // a whale does not justify any expense
    expect(customerMultiplier(1_000_000)).toBeCloseTo(1.2, 6);
  });

  test('a valuable customer tips a marginal case into acting', () => {
    const cheap = choose(input('CARD_DECLINED', { amountPaise: 1_000, customerLifetimeValuePaise: 0 }));
    const valued = choose(input('CARD_DECLINED', { amountPaise: 1_000, customerLifetimeValuePaise: 5_000_000 }));
    expect(ev(valued, 'retry')).toBeGreaterThan(ev(cheap, 'retry'));
  });
});

describe('the active scorer reaches the EVs', () => {
  test('a case probability rescales the odds so the best option agrees with it', () => {
    const plain = choose(input('THREEDS_FAILED'));
    const scaled = choose(input('THREEDS_FAILED', { caseProbability: 0.31 }));
    const best = scaled.options.filter((o) => o.available && o.strategy !== 'do_nothing')
      .reduce((m, o) => Math.max(m, o.probability), 0);
    expect(best).toBeCloseTo(0.31, 6);
    // The ordering is preserved — it is the level that moves, not the shape.
    expect(scaled.chosen.strategy).toBe(plain.chosen.strategy);
    expect(ev(scaled, 'alternate_gateway')).toBeLessThan(ev(plain, 'alternate_gateway'));
  });
});
