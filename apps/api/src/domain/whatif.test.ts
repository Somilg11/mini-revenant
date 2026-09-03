import { describe, expect, test } from 'bun:test';
import { compare, runAgent, runBaseline, type WhatIfRow } from './whatif.ts';
import { baselineProbability } from './recovery-model.ts';

type Override = Omit<Partial<WhatIfRow>, 'labels' | 'features'> & {
  labels?: Partial<WhatIfRow['labels']>;
  features?: Partial<WhatIfRow['features']>;
};

const row = (i: number, over: Override = {}): WhatIfRow => {
  const createdAt = new Date(Date.parse('2026-07-31T10:00:00Z') + i * 60_000).toISOString();
  const features: WhatIfRow['features'] = {
    failedAt: createdAt, amountPaise: 480_000, method: 'card', bank: null, failureCode: 'THREEDS_FAILED', attemptIndex: 1,
    customerPriorAttempts: 3, customerPriorSuccessRate: 0.7, merchantPriorSuccessRate: 0.9, secondsSinceLastAttempt: 3600,
    incidentActive: false, secondaryRouteAvailable: true, ...(over.features ?? {}),
  };
  return {
    id: `pay_${i}`, merchantId: 'mch_a', createdAt, isInternational: true, amountPaise: features.amountPaise, attemptIndex: features.attemptIndex,
    failureCode: features.failureCode, failureFamily: 'CROSS_BORDER', optedOut: false, lifetimeValuePaise: 1_000_000, features,
    labels: { retry: false, link: false, alternate: false, gateway: true, ...(over.labels ?? {}) },
    merchant: { isPaused: false, dailyActionBudgetPaise: 5_000_000, dailyActionBudgetCount: 200 },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'labels' && k !== 'features')),
  } as WhatIfRow;
};

const score = (f: WhatIfRow['features']) => ({ probability: baselineProbability(f), source: 'baseline' as const });
const totals = { international: { payments: 100, captured: 80 }, domestic: { payments: 100, captured: 93 } };

describe('both arms see the same rows', () => {
  test('counts match by construction, and a divergence is an error not a table', () => {
    const rows = [row(1), row(2), row(3, { isInternational: false, failureFamily: 'CUSTOMER', features: { failureCode: 'INSUFFICIENT_FUNDS' }, failureCode: 'INSUFFICIENT_FUNDS' })];
    const c = compare(rows, score, totals);
    expect(c.baseline.failed).toBe(3);
    expect(c.agent.failed).toBe(3);
    expect(c.rows).toBe(3);
    expect(c.baseline.international.failed + c.baseline.domestic.failed).toBe(3);
  });
});

describe('BASELINE — one blind retry on everything', () => {
  test('attempts every row, pays for every attempt, recovers only what recoverable_by_retry says', () => {
    const rows = [row(1, { labels: { retry: true } }), row(2), row(3, { labels: { retry: true } })];
    const b = runBaseline(rows);
    expect(b.attempted).toBe(3);
    expect(b.recovered).toBe(2);
    expect(b.costPaise).toBe(600);
    expect(b.revenueRecoveredPaise).toBe(960_000);
    expect(b.recoveryRate).toBeCloseTo(2 / 3, 6);
  });
});

describe('AGENT — the full loop against the labels', () => {
  test('a cross-border failure goes through the second route and is resolved by recoverable_by_gateway', () => {
    const a = runAgent([row(1, { labels: { gateway: true, retry: false } })], score);
    expect(a.attempted).toBe(1);
    expect(a.byStrategy.alternate_gateway.attempted).toBe(1);
    expect(a.recovered).toBe(1);
    expect(a.byStrategy.alternate_gateway.revenuePaise).toBe(480_000);
    // The baseline would have retried into the same 3DS wall and lost.
    expect(runBaseline([row(1, { labels: { gateway: true, retry: false } })]).recovered).toBe(0);
  });
  test('the agent declines: do_nothing on a fraud family, DENY on an opted-out customer', () => {
    const fraud = row(1, { failureFamily: 'TERMINAL', failureCode: 'FRAUD_SUSPECTED', features: { failureCode: 'FRAUD_SUSPECTED' }, labels: { retry: true } });
    const opted = row(2, { optedOut: true, labels: { gateway: true } });
    const a = runAgent([fraud, opted], score);
    expect(a.attempted).toBe(0);
    expect(a.declined.doNothing + a.declined.denied).toBe(2);
    expect(a.failed).toBe(2);
    // The baseline still retried both — and paid for it.
    expect(runBaseline([fraud, opted]).attempted).toBe(2);
  });
  test('budgets bite in the simulation exactly as they do live: the blast radius defers the merchant\'s excess', () => {
    // ₹2L/hour cap; forty ₹48,000 payments in one hour would be ₹19.2L.
    const rows = Array.from({ length: 40 }, (_, i) => row(i, { amountPaise: 4_800_000 as never, features: { amountPaise: 4_800_000 }, labels: { gateway: true } }));
    const a = runAgent(rows, score);
    expect(a.attempted).toBeLessThan(40);
    expect(a.declined.deferred).toBeGreaterThan(0);
    expect(a.attempted + a.declined.deferred + a.declined.denied + a.declined.doNothing).toBe(40);
    // Large amounts need a signature; the simulation counts them rather than pretending.
    expect(a.requiredApproval).toBe(a.attempted);
  });
});

describe('the closing numbers', () => {
  test('incremental revenue, interventions avoided and acceptance after recovery per segment', () => {
    const rows = [
      row(1, { labels: { gateway: true, retry: false } }),
      row(2, { labels: { gateway: true, retry: false } }),
      row(3, { labels: { gateway: false, retry: true } }),
      row(4, { isInternational: false, failureFamily: 'TERMINAL', failureCode: 'FRAUD_SUSPECTED', features: { failureCode: 'FRAUD_SUSPECTED' }, labels: { retry: true } }),
    ];
    const c = compare(rows, score, totals);
    expect(c.baseline.recovered).toBe(2);
    expect(c.agent.recovered).toBe(2);
    expect(c.interventionsAvoided).toBe(1);
    expect(c.acceptance.international.before).toBeCloseTo(0.8, 6);
    expect(c.acceptance.international.baseline).toBeCloseTo(0.81, 6);
    expect(c.acceptance.international.agent).toBeCloseTo(0.82, 6);
    expect(c.acceptance.domestic.agent).toBeCloseTo(0.93, 6);
    expect(c.incrementalRevenuePaise).toBe(c.agent.revenueRecoveredPaise - c.baseline.revenueRecoveredPaise);
  });
});
