import { describe, expect, test } from 'bun:test';
import { DEFAULT_PARAMS, generate, type Dataset } from './generator.ts';
import { failureFamily } from '../domain/failure-codes.ts';
import { amountBand } from '../domain/money.ts';

const MERCHANTS = ['mch_a', 'mch_b', 'mch_c', 'mch_d', 'mch_e'];
const params = { ...DEFAULT_PARAMS, merchants: MERCHANTS };

/** Generated once: 75,000 payments takes ~180 ms, and every test reads the same run. */
const data: Dataset = generate(params);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istHour = (iso: string) => new Date(Date.parse(iso) + IST_OFFSET_MS).getUTCHours();

describe('§8.1 — determinism', () => {
  test('same seed ⇒ same checksum', () => {
    expect(generate(params).checksum).toBe(generate(params).checksum);
  });

  test('same seed ⇒ identical payments, not merely the same digest', () => {
    const a = generate(params).payments;
    const b = generate(params).payments;
    expect(a.length).toBe(b.length);
    expect(a[0]).toEqual(b[0]!);
    expect(a[a.length - 1]).toEqual(b[b.length - 1]!);
  });

  test('a different seed ⇒ a different checksum', () => {
    expect(generate({ ...params, seed: 43 }).checksum).not.toBe(data.checksum);
  });

  test('the window is fixed, never `now`', () => {
    expect(params.endsAt).toBe('2026-08-01T00:00:00Z');
    const last = Date.parse(data.payments[data.payments.length - 1]!.createdAt);
    expect(last).toBeLessThan(Date.parse(params.endsAt));
  });
});

describe('§1.1 / §14 — the cross-border wedge exists before any detection runs', () => {
  test('international failure rate is materially above domestic', () => {
    // The gap IS the product. If this ever stops holding, every downstream
    // claim in §1.1 is measuring something that is not in the data.
    expect(data.stats.internationalFailureRate).toBeGreaterThan(0.16);
    expect(data.stats.internationalFailureRate).toBeLessThan(0.23);
    expect(data.stats.domesticFailureRate).toBeGreaterThan(0.05);
    expect(data.stats.domesticFailureRate).toBeLessThan(0.09);
    expect(
      data.stats.internationalFailureRate - data.stats.domesticFailureRate,
    ).toBeGreaterThan(0.08);
  });

  test('international traffic is ~18% of volume, and card-only', () => {
    const share = data.stats.international / data.stats.total;
    expect(share).toBeGreaterThan(0.16);
    expect(share).toBeLessThan(0.2);
    expect(data.payments.filter((p) => p.isInternational && p.method !== 'card')).toEqual([]);
  });

  test('domestic payments never draw a CROSS_BORDER code', () => {
    // Folding these families together is the most expensive mistake in this
    // dataset (§7.2); leaking the codes onto domestic traffic would do it
    // implicitly.
    const leaked = data.payments.filter(
      (p) => !p.isInternational && failureFamily(p.failureCode) === 'CROSS_BORDER',
    );
    expect(leaked).toEqual([]);
  });

  test('international failures skew to the CROSS_BORDER family', () => {
    const intlFailed = data.payments.filter((p) => p.isInternational && p.failureCode);
    const crossBorder = intlFailed.filter(
      (p) => failureFamily(p.failureCode) === 'CROSS_BORDER',
    );
    expect(crossBorder.length / intlFailed.length).toBeGreaterThan(0.7);
  });
});

describe('§8.1 — distributions', () => {
  test('method mix follows Indian commerce, not a card-heavy market', () => {
    const n = data.stats.total;
    expect((data.stats.byMethod.upi ?? 0) / n).toBeCloseTo(0.45, 1);
    expect((data.stats.byMethod.card ?? 0) / n).toBeGreaterThan(0.3);
    expect((data.stats.byMethod.netbanking ?? 0) / n).toBeCloseTo(0.1, 1);
  });

  test('amounts are log-normal — a long thin tail, not a symmetric spread', () => {
    const sorted = data.payments.map((p) => p.amountPaise).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
    // Median near ₹1,200–1,600 (international pulls it up a little).
    expect(median).toBeGreaterThan(100_00);
    expect(median).toBeLessThan(2_500_00);
    // A symmetric distribution would leave no tail for HIGH_VALUE_FAILURES.
    expect(p99 / median).toBeGreaterThan(8);
  });

  test('every amount lands in exactly one band', () => {
    for (const p of data.payments.slice(0, 500)) {
      expect(amountBand(p.amountPaise)).toBeTruthy();
    }
  });

  test('traffic has a daily rhythm — 04:00 IST is far quieter than 19:00 IST', () => {
    const byHour = new Array(24).fill(0) as number[];
    for (const p of data.payments) byHour[istHour(p.createdAt)]! += 1;
    // A detector tuned on flat traffic calls every evening an anomaly.
    expect(byHour[4]!).toBeLessThan(byHour[19]! * 0.35);
  });

  test('failure codes are tied to the method', () => {
    // A code on the wrong method teaches the model a relationship that does
    // not exist. UPI has no card expiry.
    const upiCodes = new Set(
      data.payments.filter((p) => p.method === 'upi' && p.failureCode).map((p) => p.failureCode),
    );
    expect(upiCodes.has('CARD_EXPIRED')).toBe(false);
    expect(upiCodes.has('CARD_DECLINED')).toBe(false);
  });
});

describe('§8.2 — injected incidents are the answer key', () => {
  test('six incidents, including the cross-border centrepiece', () => {
    expect(data.incidents.map((i) => i.kind).sort()).toEqual([
      'ABANDONMENT_SPIKE',
      'BANK_OUTAGE',
      'CUSTOMER_COHORT',
      'HIGH_VALUE_FAILURES',
      'INTERNATIONAL_3DS_BLOCK',
      'METHOD_DEGRADATION',
    ]);
  });

  test('every labelled incident affects at least 20 payments', () => {
    // A ground-truth row asserting an invisible incident scores every detector
    // as a miss, so this is a defect in the dataset, not in the detector.
    for (const inc of data.incidents) {
      expect(inc.affectedPayments).toBeGreaterThanOrEqual(20);
    }
    expect(data.defects).toEqual([]);
  });

  test('incidents start in daytime IST traffic (10:00–21:00)', () => {
    for (const inc of data.incidents) {
      const h = istHour(inc.startedAt);
      expect(h).toBeGreaterThanOrEqual(10);
      expect(h).toBeLessThanOrEqual(21);
    }
  });

  test('incidents are infrastructure-wide, not scoped to one merchant', () => {
    // Scoping one to a single tenant divides the affected traffic by the
    // merchant count and produces "incidents" of four payments (§8.2).
    for (const inc of data.incidents) {
      expect(Object.keys(inc.dimensions)).not.toContain('merchant_id');
    }
  });

  test('the centrepiece is hard: it barely moves the overall failure rate', () => {
    const inc = data.incidents.find((i) => i.kind === 'INTERNATIONAL_3DS_BLOCK')!;
    const start = Date.parse(inc.startedAt);
    const end = Date.parse(inc.endedAt);
    const inWindow = data.payments.filter((p) => {
      const t = Date.parse(p.createdAt);
      return t >= start && t < end;
    });
    const bad = inWindow.filter((p) => p.outcome !== 'captured').length;
    const overall = bad / inWindow.length;
    // Visible per-dimension, a wobble on the aggregate — that contrast is the
    // whole demo (§8.2).
    expect(overall - data.stats.overallFailureRate).toBeLessThan(0.12);

    const intl = inWindow.filter((p) => p.isInternational);
    const intlBad = intl.filter((p) => p.outcome !== 'captured').length;
    expect(intlBad / intl.length).toBeGreaterThan(0.4);
  });
});

describe('§8.4 — unlabelled noise is the precision test', () => {
  test('two noise windows exist and carry no ground-truth label', () => {
    expect(data.noiseWindows).toHaveLength(2);
    const labelled = new Set(data.incidents.map((i) => i.startedAt));
    for (const w of data.noiseWindows) expect(labelled.has(w.startedAt)).toBe(false);
  });

  test('noise is mild — well under the detector gates it must not trip', () => {
    // §7.3 requires +8 points absolute AND 1.8× relative. Noise is 1.5×, so a
    // detector that fires on it is wrong rather than unlucky.
    for (const w of data.noiseWindows) {
      const start = Date.parse(w.startedAt);
      const end = Date.parse(w.endedAt);
      const inWindow = data.payments.filter((p) => {
        const t = Date.parse(p.createdAt);
        return t >= start && t < end;
      });
      const rate = inWindow.filter((p) => p.outcome !== 'captured').length / inWindow.length;
      expect(rate - data.stats.overallFailureRate).toBeLessThan(0.08);
    }
  });
});

describe('§8.3 — counterfactual labels', () => {
  test('every unsuccessful payment is labelled, and no successful one is', () => {
    const unsuccessful = data.payments.filter((p) => p.outcome !== 'captured');
    expect(data.labels).toHaveLength(unsuccessful.length);
    const captured = new Set(
      data.payments.filter((p) => p.outcome === 'captured').map((p) => p.id),
    );
    expect(data.labels.filter((l) => captured.has(l.paymentId))).toEqual([]);
  });

  test('recoverable is the disjunction of the four interventions', () => {
    for (const l of data.labels.slice(0, 1000)) {
      expect(l.recoverable).toBe(
        l.recoverableByRetry || l.recoverableByLink || l.recoverableByAlternate || l.recoverableByGateway,
      );
    }
  });

  test('the split is chronological by position, never random', () => {
    // A random split lets the model learn a customer's later behaviour and be
    // tested on their earlier behaviour: every metric improves, and the model
    // collapses in production (§7.5).
    const order = ['train', 'val', 'test'];
    let seen = 0;
    for (const l of data.labels) {
      const i = order.indexOf(l.split);
      expect(i).toBeGreaterThanOrEqual(seen);
      seen = Math.max(seen, i);
    }
    const counts = { train: 0, val: 0, test: 0 };
    for (const l of data.labels) counts[l.split] += 1;
    expect(counts.train / data.labels.length).toBeCloseTo(0.7, 1);
    expect(counts.test / data.labels.length).toBeCloseTo(0.15, 1);
  });

  test('§8.6 — the secondary route refuses INR-only instruments', () => {
    // UPI, netbanking and RuPay are not routable to the second processor, so
    // `alternate_gateway` is simply unavailable there and the strategy engine
    // has to earn that choice rather than defaulting to it.
    const byId = new Map(data.payments.map((p) => [p.id, p]));
    for (const l of data.labels) {
      if (!l.recoverableByGateway) continue;
      const p = byId.get(l.paymentId)!;
      expect(p.method).toBe('card');
      expect(p.cardNetwork).not.toBe('rupay');
    }
  });

  test('cross-border failures are the ones the second processor recovers', () => {
    const byId = new Map(data.payments.map((p) => [p.id, p]));
    const gatewayRecoverable = data.labels.filter((l) => l.recoverableByGateway);
    const crossBorder = gatewayRecoverable.filter(
      (l) => failureFamily(byId.get(l.paymentId)!.failureCode) === 'CROSS_BORDER',
    );
    // The asymmetry of §1.1, expressed as a number.
    expect(crossBorder.length / gatewayRecoverable.length).toBeGreaterThan(0.6);
  });
});

describe('§7.1 — abandoned payments carry no failure event', () => {
  test('they stop after payment.attempted and have no code', () => {
    const abandoned = data.payments.filter((p) => p.outcome === 'abandoned');
    expect(abandoned.length).toBeGreaterThan(0);
    for (const p of abandoned.slice(0, 200)) {
      expect(p.failureCode).toBeNull();
      expect(p.events.map((e) => e.kind)).toEqual(['payment.created', 'payment.attempted']);
    }
  });

  test('captured payments authorise before they capture', () => {
    const captured = data.payments.find((p) => p.outcome === 'captured')!;
    expect(captured.events.map((e) => e.kind)).toEqual([
      'payment.created',
      'payment.attempted',
      'payment.authorized',
      'payment.captured',
    ]);
  });
});
