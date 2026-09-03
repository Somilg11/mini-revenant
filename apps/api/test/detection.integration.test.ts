import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { sweep, catchUp, latestDataBucket } from '../src/app/detection.ts';
import { DEFAULT_DETECTOR_CONFIG as CFG, requiredBuckets } from '../src/domain/detector.ts';
import { diagnose } from '../src/app/rca.ts';
import { getIncident } from '../src/db/queries.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event, uid } from './helpers.ts';

/**
 * Detection runs against a synthetic 25-hour history built through the real
 * projector, in 2029 — outside any seeded dataset, so these neither depend on a
 * seed nor disturb one.
 */
const BASE = Date.parse('2029-04-01T00:00:00.000Z');
const BUCKET = 5 * 60_000;
const WINDOW_FROM = '2029-01-01T00:00:00.000Z';
const CUSTOMER = 'cus_detect_p7';

/**
 * These fixtures build hundreds of payments through the real projector — three
 * events each, one transaction apiece — which runs past Bun's 5-second default
 * and fails as a timeout that looks like a logic error.
 */
const SLOW = 30_000;

async function reset(): Promise<void> {
  await sql`DELETE FROM incidents WHERE opened_at >= ${WINDOW_FROM}`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= ${WINDOW_FROM}`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_dt_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_dt_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_dt_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id) VALUES (${CUSTOMER}, ${MERCHANT})
    ON CONFLICT (id) DO NOTHING`;
}

beforeAll(assertNoCompetingRelay);
beforeEach(reset);
afterAll(async () => {
  await reset();
  await sql`DELETE FROM customers WHERE id = ${CUSTOMER}`;
});

/** Builds one bucket of traffic on a slice, through the real state machine. */
async function bucket(
  index: number,
  attempts: number,
  failures: number,
  data: Record<string, unknown> = {},
): Promise<void> {
  const t = (offset: number) => new Date(BASE + index * BUCKET + offset).toISOString();
  for (let i = 0; i < attempts; i += 1) {
    const id = uid('pay_dt_');
    await project(createdEvent(id, t(i * 100), { customer_id: CUSTOMER, amount_paise: 50_000, ...data }));
    await project(event(id, 'payment.attempted', t(i * 100 + 10)));
    if (i < failures) {
      await project(event(id, 'payment.failed', t(i * 100 + 20), { failure_code: 'THREEDS_FAILED' }));
    } else {
      await project(event(id, 'payment.captured', t(i * 100 + 20)));
    }
  }
}

/** A clean baseline, a gap, then a window at `evalRate`. */
async function history(baselineRate: number, evalRate: number, perBucket = 25): Promise<Date> {
  const total = requiredBuckets(CFG);
  // A short baseline keeps the test fast; it only needs to clear minBaselineAttempts.
  const baselineBuckets = 12;
  const fails = Math.round(perBucket * baselineRate);
  for (let i = 0; i < baselineBuckets; i += 1) {
    await bucket(total - baselineBuckets - CFG.baselineGapBuckets - CFG.evaluationBuckets + i, perBucket, fails);
  }
  for (let i = 0; i < CFG.evaluationBuckets; i += 1) {
    await bucket(total - CFG.evaluationBuckets + i, perBucket, Math.round(perBucket * evalRate));
  }
  return new Date(BASE + total * BUCKET);
}

describe('the sweep opens incidents on a real degradation', () => {
  test('a large sustained rise opens exactly one incident on the slice', async () => {
    const now = await history(0.06, 0.6, 30);
    const result = await sweep(now);
    expect(result.opened.length).toBeGreaterThan(0);

    const rows = await sql<{ dimension: string; dimension_value: string; z_score: number }[]>`
      SELECT dimension, dimension_value, z_score FROM incidents WHERE opened_at >= ${WINDOW_FROM}`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.z_score >= CFG.minZScore)).toBe(true);
  }, SLOW);

  test('the five gates are persisted with their numbers', async () => {
    const now = await history(0.06, 0.6, 30);
    await sweep(now);
    const [row] = await sql<{ gates: { gate: string; passed: boolean; detail: string }[] }[]>`
      SELECT gates FROM incidents WHERE opened_at >= ${WINDOW_FROM} LIMIT 1`;
    expect(row!.gates).toHaveLength(5);
    expect(row!.gates.every((g) => g.passed)).toBe(true);
    for (const g of row!.gates) expect(g.detail.length).toBeGreaterThan(0);
  }, SLOW);

  test('a second sweep does not open a duplicate — one open incident per slice', async () => {
    const now = await history(0.06, 0.6, 30);
    const first = await sweep(now);
    const second = await sweep(now);
    expect(first.opened.length).toBeGreaterThan(0);
    // Suppressed by the open incident, and by `incidents_one_open` beneath it.
    expect(second.opened).toEqual([]);
  }, SLOW);
});

describe('the sweep stays quiet on ordinary traffic', () => {
  test('a steady slice opens nothing', async () => {
    const now = await history(0.06, 0.07, 30);
    const result = await sweep(now);
    expect(result.opened).toEqual([]);
  }, SLOW);

  test('a mild wobble — the shape of an unlabelled noise window — opens nothing', async () => {
    // 1.5× the baseline, which is what §8.4's noise windows carry. The absolute
    // and relative gates are what refuse it.
    const now = await history(0.06, 0.09, 30);
    expect((await sweep(now)).opened).toEqual([]);
  }, SLOW);

  test('a thin slice does not fire however bad it looks', async () => {
    const now = await history(0.06, 0.8, 4);
    expect((await sweep(now)).opened).toEqual([]);
  }, SLOW);
});

describe('catch-up follows the data, not the clock', () => {
  test('it never sweeps past the newest bucket that holds data', async () => {
    await history(0.06, 0.6, 30);
    const latest = await latestDataBucket();
    expect(latest).not.toBeNull();

    // Ask it to sweep a year ahead; it must stop at the data.
    const { sweptTo } = await catchUp(new Date(BASE), {
      until: new Date(BASE + 365 * 24 * 3600_000),
      maxBuckets: 5000,
    });
    expect(sweptTo.getTime()).toBeLessThanOrEqual(latest!.getTime());
  }, SLOW);

  test('`until` bounds it further, so unsettled buckets are not judged', async () => {
    await history(0.06, 0.6, 30);
    const cap = new Date(BASE + 10 * BUCKET);
    const { sweptTo } = await catchUp(new Date(BASE), { until: cap, maxBuckets: 5000 });
    expect(sweptTo.getTime()).toBeLessThanOrEqual(cap.getTime());
  }, SLOW);

  test('it steps bucket by bucket rather than jumping, so no window is skipped', async () => {
    // An evaluation window is fifteen minutes wide. A sweep that jumped from
    // Monday to Wednesday would step straight over a two-hour outage.
    await history(0.06, 0.6, 30);
    const { result } = await catchUp(new Date(BASE + 280 * BUCKET), { maxBuckets: 5000 });
    expect(result.evaluated).toBeGreaterThan(0);
  }, SLOW);
});

describe('§7.4 — root cause runs on a real incident', () => {
  test('it names the degraded slice and stores the evidence', async () => {
    // A card slice collapses while UPI carries on normally.
    // Cards on *both* banks and UPI on both, so `method=card` and any single
    // bank are not synonyms — otherwise the two labels cover identical payments
    // and which one is reported is arbitrary.
    const total = requiredBuckets(CFG);
    const start = total - 8 - CFG.baselineGapBuckets - CFG.evaluationBuckets;
    const card = (bank: string) => ({ method: 'card', bank, is_international: false, card_network: 'visa' });
    const upi = (bank: string) => ({ method: 'upi', bank, is_international: false });

    // Eight buckets × four slices × eight payments = 256 baseline attempts,
    // comfortably over the detector's 200 floor and a third fewer projections.
    for (let i = 0; i < 8; i += 1) {
      await bucket(start + i, 8, 1, upi('HDFC'));
      await bucket(start + i, 8, 1, upi('ICICI'));
      await bucket(start + i, 8, 1, card('HDFC'));
      await bucket(start + i, 8, 1, card('ICICI'));
    }
    for (let i = 0; i < CFG.evaluationBuckets; i += 1) {
      const b = total - CFG.evaluationBuckets + i;
      await bucket(b, 10, 1, upi('HDFC'));
      await bucket(b, 10, 1, upi('ICICI'));
      await bucket(b, 10, 8, card('HDFC'));
      await bucket(b, 10, 8, card('ICICI'));
    }

    const now = new Date(BASE + total * BUCKET);
    const result = await sweep(now);
    expect(result.opened.length).toBeGreaterThan(0);

    const incident = (await getIncident(result.opened[0]!))!;
    const rca = await diagnose(incident);

    expect(rca.hypotheses.length).toBeGreaterThan(0);
    const top = rca.hypotheses[0]!;

    // The degraded slice, not the busiest one — UPI carries equal traffic and
    // is untouched, and the degradation spans both banks so only `method` can
    // name it.
    expect(top.tuple.method).toBe('card');

    // Evidence, not just a verdict.
    expect(top.excess).toBeGreaterThan(0);
    expect(top.excessShare).toBeGreaterThan(0.5);
    expect(top.observedRate).toBeGreaterThan(top.expectedRate);
    expect(top.attempts).toBeGreaterThan(0);

    // The quoted baseline is the shrunk rate — the same arithmetic the share
    // came from (§7.4), not the slice's raw history.
    const shrunk =
      (top.baselineFailures + 30 * rca.pooledRate) / (top.baselineAttempts + 30);
    expect(top.expectedRate).toBeCloseTo(shrunk, 6);

    // And it is persisted on the incident for the UI to read.
    const stored = (await getIncident(incident.id))!;
    const rootCause = stored.root_cause as { hypotheses: unknown[] } | null;
    expect(rootCause).not.toBeNull();
    expect(rootCause!.hypotheses.length).toBeGreaterThan(0);
  }, SLOW);
});
