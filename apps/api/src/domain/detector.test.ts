import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DETECTOR_CONFIG as CFG,
  evaluate,
  isResolved,
  requiredBuckets,
  type Bucket,
} from './detector.ts';

const T0 = Date.parse('2026-07-25T00:00:00.000Z');
const at = (i: number) => new Date(T0 + i * 5 * 60_000).toISOString();

/** Builds a series where every bucket has `attempts` and the given failure rate. */
function series(specs: { n: number; attempts: number; rate: number }[]): Bucket[] {
  const out: Bucket[] = [];
  for (const s of specs) {
    for (let i = 0; i < s.n; i += 1) {
      out.push({
        start: at(out.length),
        attempts: s.attempts,
        failures: Math.round(s.attempts * s.rate),
      });
    }
  }
  return out;
}

/** A healthy 24h baseline, a 30-minute gap, then an evaluation window. */
function withWindow(baselineRate: number, evalRate: number, opts: { attempts?: number; baselineAttempts?: number } = {}) {
  const a = opts.attempts ?? 60;
  const ba = opts.baselineAttempts ?? 60;
  return series([
    { n: CFG.baselineBuckets, attempts: ba, rate: baselineRate },
    { n: CFG.baselineGapBuckets, attempts: ba, rate: baselineRate },
    { n: CFG.evaluationBuckets, attempts: a, rate: evalRate },
  ]);
}

describe('history requirements', () => {
  test('needs a full baseline, gap and window before judging anything', () => {
    expect(requiredBuckets(CFG)).toBe(288 + 6 + 3);
  });

  test('too little history is "not evaluated", which is not the same as "fine"', () => {
    const v = evaluate(series([{ n: 50, attempts: 60, rate: 0.5 }]), CFG);
    // A detector that says "no anomaly" when it has not looked is worse than
    // one that says so.
    expect(v.evaluated).toBe(false);
    expect(v.anomalous).toBe(false);
    expect(v.reasons).toContain('insufficient history');
  });
});

describe('a real degradation fires', () => {
  const v = evaluate(withWindow(0.07, 0.55), CFG);

  test('it is anomalous', () => {
    expect(v.evaluated).toBe(true);
    expect(v.anomalous).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test('every gate passed, and each carries its numbers', () => {
    expect(v.gates).toHaveLength(5);
    expect(v.gates.every((g) => g.passed)).toBe(true);
    expect(v.gates.map((g) => g.gate).sort()).toEqual([
      'absolute_lift',
      'relative_lift',
      'sustained',
      'volume',
      'z_score',
    ]);
    for (const g of v.gates) expect(g.detail.length).toBeGreaterThan(0);
  });

  test('the reported rates match the inputs', () => {
    expect(v.baselineRate).toBeCloseTo(0.07, 2);
    expect(v.currentRate).toBeCloseTo(0.55, 2);
    expect(v.absoluteLift).toBeCloseTo(0.48, 2);
    expect(v.relativeLift).toBeGreaterThan(7);
    expect(v.zScore).toBeGreaterThan(CFG.minZScore);
  });
});

describe('each gate can refuse on its own', () => {
  test('volume: a thin slice does not fire, however bad it looks', () => {
    // Eight attempts producing six failures is not evidence; it is a Tuesday
    // morning. This gate is why the noise windows of §8.4 stay quiet.
    const v = evaluate(withWindow(0.07, 0.75, { attempts: 4 }), CFG);
    expect(v.anomalous).toBe(false);
    expect(v.gates.find((g) => g.gate === 'volume')!.passed).toBe(false);
  });

  test('volume: a thin baseline does not fire either', () => {
    const v = evaluate(withWindow(0.07, 0.6, { baselineAttempts: 0 }), CFG);
    expect(v.anomalous).toBe(false);
    expect(v.gates.find((g) => g.gate === 'volume')!.passed).toBe(false);
  });

  test('absolute lift: a small rise on a small base is not worth waking anyone', () => {
    // 2% → 6% triples the rate but moves four points. Relative lift alone
    // would fire; the absolute gate is what stops it.
    const v = evaluate(withWindow(0.02, 0.06), CFG);
    expect(v.gates.find((g) => g.gate === 'relative_lift')!.passed).toBe(true);
    expect(v.gates.find((g) => g.gate === 'absolute_lift')!.passed).toBe(false);
    expect(v.anomalous).toBe(false);
  });

  test('relative lift: a big jump on an already-bad slice is not news', () => {
    // 40% → 50% moves ten points but is only 1.25×. Absolute lift alone would
    // fire; the relative gate is what stops it.
    const v = evaluate(withWindow(0.4, 0.5), CFG);
    expect(v.gates.find((g) => g.gate === 'absolute_lift')!.passed).toBe(true);
    expect(v.gates.find((g) => g.gate === 'relative_lift')!.passed).toBe(false);
    expect(v.anomalous).toBe(false);
  });

  test('sustained: a single bad bucket among three is a blip, not an incident', () => {
    const s = series([
      { n: CFG.baselineBuckets, attempts: 60, rate: 0.07 },
      { n: CFG.baselineGapBuckets, attempts: 60, rate: 0.07 },
      { n: 1, attempts: 60, rate: 0.9 },
      { n: 2, attempts: 60, rate: 0.07 },
    ]);
    const v = evaluate(s, CFG);
    expect(v.gates.find((g) => g.gate === 'sustained')!.passed).toBe(false);
    expect(v.anomalous).toBe(false);
  });

  test('a failing gate is reported with its numbers, and the others are still evaluated', () => {
    // Never short-circuit: a user needs the full picture, not the first
    // objection.
    const v = evaluate(withWindow(0.07, 0.09), CFG);
    expect(v.anomalous).toBe(false);
    expect(v.gates).toHaveLength(5);
    expect(v.reasons.length).toBeGreaterThan(0);
  });
});

describe('the baseline gap keeps a degradation out of its own baseline', () => {
  test('the gap buckets are excluded from both windows', () => {
    // The gap carries the degradation; the baseline before it is clean. If the
    // gap leaked into the baseline, the comparison would be against a
    // contaminated figure and the incident would partly hide itself.
    const s = series([
      { n: CFG.baselineBuckets, attempts: 60, rate: 0.07 },
      { n: CFG.baselineGapBuckets, attempts: 60, rate: 0.6 },
      { n: CFG.evaluationBuckets, attempts: 60, rate: 0.6 },
    ]);
    const v = evaluate(s, CFG);
    expect(v.baselineRate).toBeCloseTo(0.07, 2);
    expect(v.anomalous).toBe(true);
  });
});

describe('a zero baseline does not produce an infinite score', () => {
  test('one failure in a previously perfect slice is not automatically an incident', () => {
    const s = series([
      { n: CFG.baselineBuckets, attempts: 60, rate: 0 },
      { n: CFG.baselineGapBuckets, attempts: 60, rate: 0 },
      { n: CFG.evaluationBuckets, attempts: 60, rate: 0.02 },
    ]);
    const v = evaluate(s, CFG);
    expect(Number.isFinite(v.zScore)).toBe(true);
    // It moves 2 points, which is under the absolute gate.
    expect(v.anomalous).toBe(false);
  });
});

describe('resolution', () => {
  test('three clean buckets close it', () => {
    const s = series([{ n: 5, attempts: 60, rate: 0.07 }]);
    expect(isResolved(s, 0.07, CFG)).toBe(true);
  });

  test('still-elevated buckets keep it open', () => {
    const s = series([{ n: 5, attempts: 60, rate: 0.5 }]);
    expect(isResolved(s, 0.07, CFG)).toBe(false);
  });

  test('one bad bucket among the last three keeps it open', () => {
    const s = [
      ...series([{ n: 2, attempts: 60, rate: 0.07 }]),
      ...series([{ n: 1, attempts: 60, rate: 0.6 }]),
    ];
    expect(isResolved(s, 0.07, CFG)).toBe(false);
  });

  test('silence is not recovery', () => {
    // A slice that stopped receiving traffic has not got better; it has gone
    // quiet, and closing the incident would be a false claim.
    const s: Bucket[] = [0, 1, 2].map((i) => ({ start: at(i), attempts: 0, failures: 0 }));
    expect(isResolved(s, 0.07, CFG)).toBe(false);
  });

  test('it resolves against the baseline it opened with, not the current one', () => {
    // The incident has already dragged the recent average up; comparing to
    // that would let a still-broken slice look recovered.
    const s = series([{ n: 3, attempts: 60, rate: 0.3 }]);
    expect(isResolved(s, 0.07, CFG)).toBe(false);
    expect(isResolved(s, 0.3, CFG)).toBe(true);
  });
});

describe('§8.2 — the centrepiece: visible per-dimension, invisible on the aggregate', () => {
  /**
   * The demo's entire argument, as arithmetic.
   *
   * International is 18% of volume, so an eight-hour collapse to a 64% failure
   * rate moves the *overall* rate about seven points — under the eight-point
   * gate, a wobble any merchant would put down to noise. The same collapse on
   * the `is_international` series is unmistakable.
   *
   * **The traffic volume here is load-bearing**, not incidental. At 55 attempts
   * per bucket the aggregate's z-score is 3.3 and it stays quiet; at 1,000 the
   * same seven-point lift scores z = 15 and fires. The contrast the demo rests
   * on is a property of this dataset's size as much as of the detector, so the
   * numbers are pinned to what the seeded dataset actually carries.
   */
  const PER_BUCKET = 55;
  const INTL_SHARE = 0.18;
  const DOM_RATE = 0.07;
  const INTL_BASE = 0.19;
  const INTL_PEAK = 0.64;

  const intlPerBucket = Math.round(PER_BUCKET * INTL_SHARE);
  const domPerBucket = PER_BUCKET - intlPerBucket;

  function build() {
    const total = CFG.baselineBuckets + CFG.baselineGapBuckets + CFG.evaluationBuckets;
    const all: Bucket[] = [];
    const intl: Bucket[] = [];
    for (let i = 0; i < total; i += 1) {
      const r = i >= CFG.baselineBuckets + CFG.baselineGapBuckets ? INTL_PEAK : INTL_BASE;
      const intlFailures = Math.round(intlPerBucket * r);
      all.push({
        start: at(i),
        attempts: PER_BUCKET,
        failures: Math.round(domPerBucket * DOM_RATE) + intlFailures,
      });
      intl.push({ start: at(i), attempts: intlPerBucket, failures: intlFailures });
    }
    return { all, intl };
  }

  const { all, intl } = build();

  test('the international series fires every gate', () => {
    const v = evaluate(intl, CFG);
    expect(v.anomalous).toBe(true);
    expect(v.gates.every((g) => g.passed)).toBe(true);
    expect(v.currentRate).toBeGreaterThan(0.5);
  });

  test('the aggregate moves only a few points and fires nothing', () => {
    const v = evaluate(all, CFG);
    expect(v.anomalous).toBe(false);
    // The wobble the founder would dismiss — real, but under the gate.
    expect(v.absoluteLift).toBeGreaterThan(0.04);
    expect(v.absoluteLift).toBeLessThan(CFG.minAbsoluteLift);
  });

  test('so the contrast is real: one series detects it, the other cannot', () => {
    // A detector watching only the aggregate would miss this entirely, which is
    // exactly the claim §1.1 makes about every merchant dashboard.
    expect(evaluate(intl, CFG).anomalous).toBe(true);
    expect(evaluate(all, CFG).anomalous).toBe(false);
  });
});
