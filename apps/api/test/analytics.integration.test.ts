import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { sweepAbandoned } from '../src/app/abandonment.ts';
import { measureDrift, bucketOf } from '../src/app/analytics.ts';
import {
  acceptanceRows,
  attributionRow,
  breakdown,
  recoverableRevenue,
  summaryRow,
  timeseries,
  type Window,
} from '../src/db/queries.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event, uid } from './helpers.ts';

/**
 * Analytics runs against a window far outside the seeded dataset, so these
 * tests neither depend on a seed having been run nor disturb one that has.
 */
const BASE = Date.parse('2027-03-01T10:00:00.000Z');
const T = (mins: number) => new Date(BASE + mins * 60_000).toISOString();
const WINDOW: Window = { from: '2027-03-01T00:00:00.000Z', to: '2027-04-01T00:00:00.000Z' };
const CUSTOMER = 'cus_analytics_p5';

async function reset(): Promise<void> {
  // Bounded to this file's own window: deleting everything after it wipes
  // rollups belonging to other test files while leaving their payments, which
  // shows up as drift in a test that did nothing wrong.
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= ${WINDOW.from} AND bucket_start < ${WINDOW.to}`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_an_%'`;
  await sql`DELETE FROM payment_events           WHERE payment_id LIKE 'pay_an_%'`;
  await sql`DELETE FROM payments                 WHERE id         LIKE 'pay_an_%'`;
  await sql`DELETE FROM payments                 WHERE id         LIKE 'pay_t_%'`;
  await sql`DELETE FROM processed_events         WHERE event_id   LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

beforeAll(assertNoCompetingRelay);
beforeEach(reset);
afterAll(async () => {
  await reset();
  await sql`DELETE FROM customers WHERE id = ${CUSTOMER}`;
});

const intl = (over: Record<string, unknown> = {}) => ({
  customer_id: CUSTOMER,
  is_international: true,
  card_country: 'US',
  card_network: 'visa',
  threeds_required: true,
  method: 'card',
  ...over,
});

/** created → attempted → outcome, projected through the real state machine. */
async function makePayment(
  outcome: 'captured' | 'failed' | 'open',
  amountPaise: number,
  data: Record<string, unknown> = {},
): Promise<string> {
  const id = uid('pay_an_');
  await project(createdEvent(id, T(0), { amount_paise: amountPaise, ...data }));
  await project(event(id, 'payment.attempted', T(1)));
  if (outcome === 'captured') {
    await project(event(id, 'payment.authorized', T(2)));
    await project(event(id, 'payment.captured', T(2)));
  } else if (outcome === 'failed') {
    await project(event(id, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
  }
  return id;
}

describe('rollups are maintained incrementally and agree with a recomputation', () => {
  test('drift is zero after ordinary traffic', async () => {
    await makePayment('captured', 100_00, intl());
    await makePayment('failed', 250_00, intl());
    await makePayment('captured', 4_000_00, { is_international: false, method: 'upi', bank: 'HDFC' });

    const drift = await measureDrift({ from: WINDOW.from, to: WINDOW.to });
    expect(drift.rows).toBe(0);
    expect(drift.attempts).toBe(0);
    expect(drift.successes).toBe(0);
    expect(drift.failures).toBe(0);
    expect(drift.grossAmountPaise).toBe(0);
  });

  test('drift stays zero across a recovery: FAILED → ATTEMPTED → CAPTURED', async () => {
    // The decrement path is the one that silently rots: a payment that leaves
    // FAILED must stop being counted as a failure, or the two revenue columns
    // stop being mutually exclusive.
    const id = uid('pay_an_');
    await project(createdEvent(id, T(0), { amount_paise: 900_00, ...intl() }));
    await project(event(id, 'payment.attempted', T(1)));
    await project(event(id, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
    await project(event(id, 'payment.attempted', T(40), { gateway: 'secondary' }));
    await project(event(id, 'payment.captured', T(41)));

    expect((await measureDrift({ from: WINDOW.from, to: WINDOW.to })).rows).toBe(0);

    const [row] = await sql<{ successes: number; failures: number }[]>`
      SELECT successes, failures FROM metrics_rollup
      WHERE dimension = 'all' AND bucket_start = ${bucketOf(T(0))} AND merchant_id = ${MERCHANT}`;
    expect(row?.successes).toBe(1);
    expect(row?.failures).toBe(0);
  });

  test('drift stays zero after the abandonment sweep', async () => {
    await makePayment('open', 700_00, intl());
    const n = await sweepAbandoned(new Date(BASE + 120 * 60_000));
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await measureDrift({ from: WINDOW.from, to: WINDOW.to })).rows).toBe(0);
  });

  test('a hand-corrupted rollup is reported, not repaired', async () => {
    await makePayment('captured', 100_00, intl());
    await sql`
      UPDATE metrics_rollup SET attempts = attempts + 7
      WHERE dimension = 'all' AND bucket_start = ${bucketOf(T(0))} AND merchant_id = ${MERCHANT}`;

    const drift = await measureDrift({ from: WINDOW.from, to: WINDOW.to });
    expect(drift.rows).toBeGreaterThan(0);
    expect(drift.attempts).toBe(7);

    // Measuring drift must not fix it — a rollup that repairs itself hides the
    // bug that caused it (§10).
    expect((await measureDrift({ from: WINDOW.from, to: WINDOW.to })).attempts).toBe(7);
  });
});

describe('§10 — metric definitions', () => {
  test('the two revenue columns are mutually exclusive by construction', async () => {
    await makePayment('failed', 500_00, intl());
    const recovered = uid('pay_an_');
    await project(createdEvent(recovered, T(0), { amount_paise: 300_00, ...intl() }));
    await project(event(recovered, 'payment.attempted', T(1)));
    await project(event(recovered, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
    await project(event(recovered, 'payment.attempted', T(40)));
    await project(event(recovered, 'payment.captured', T(41)));
    // An ordinary sale that never failed.
    await makePayment('captured', 999_00, intl());

    const row = await summaryRow(WINDOW);
    // At risk: only the still-failed one. Recovered: only the one that was
    // FAILED earlier. The ordinary sale is in neither.
    expect(row.revenue_at_risk_paise).toBe(500_00);
    expect(row.revenue_recovered_paise).toBe(300_00);
  });

  test('a captured payment that never failed is not counted as recovered', async () => {
    await makePayment('captured', 1_234_00, intl());
    const row = await summaryRow(WINDOW);
    // Counting ordinary sales inflates the number that matters most (§10).
    expect(row.revenue_recovered_paise).toBe(0);
  });

  test('recovery_rate is recomputable from the two amounts printed beside it', async () => {
    await makePayment('failed', 700_00, intl());
    const row = await summaryRow(WINDOW);
    const denominator = row.revenue_recovered_paise + row.revenue_at_risk_paise;
    expect(denominator).toBe(700_00);
    expect(row.revenue_recovered_paise / denominator).toBe(0);
  });

  test('recoverable_revenue is null before any case is scored — never 0', async () => {
    await makePayment('failed', 400_00, intl());
    // "Not measured" and "zero" are different claims (invariant 6).
    expect(await recoverableRevenue(WINDOW)).toBeNull();
  });

  test('attribution is zero and unverified before any action has run', async () => {
    await makePayment('failed', 400_00, intl());
    const a = await attributionRow(WINDOW);
    expect(a.verified).toBe(0);
    expect(a.direct_paise + a.assisted_paise + a.organic_paise).toBe(0);
  });
});

describe('§1.1 — acceptance is reported per segment', () => {
  test('domestic and international are counted separately', async () => {
    await makePayment('captured', 100_00, intl());
    await makePayment('failed', 100_00, intl());
    await makePayment('captured', 100_00, { is_international: false, method: 'upi', bank: 'HDFC' });

    const rows = await acceptanceRows(WINDOW);
    const bySegment = Object.fromEntries(rows.map((r) => [r.segment, r]));
    expect(bySegment.international?.attempts).toBe(2);
    expect(bySegment.international?.successes).toBe(1);
    expect(bySegment.domestic?.attempts).toBe(1);
    expect(bySegment.domestic?.successes).toBe(1);
  });
});

describe('money never arrives as a string', () => {
  test('every amount is a number, so arithmetic adds rather than concatenates', async () => {
    // `sum()` over a bigint column returns `numeric`, which the driver hands
    // back as a string: `recovered + at_risk` then produced "0" + "2400918253"
    // = "02400918253" and every rate downstream was silently wrong.
    await makePayment('failed', 500_00, intl());
    await makePayment('captured', 300_00, intl());

    const row = await summaryRow(WINDOW);
    expect(typeof row.revenue_at_risk_paise).toBe('number');
    expect(typeof row.revenue_recovered_paise).toBe('number');
    expect(row.revenue_at_risk_paise + row.revenue_recovered_paise).toBe(500_00);

    const acc = await acceptanceRows(WINDOW);
    for (const r of acc) {
      expect(typeof r.gross_amount_paise).toBe('number');
      expect(typeof r.captured_amount_paise).toBe('number');
    }

    const br = await breakdown(WINDOW, 'method');
    for (const r of br) {
      expect(typeof r.gross_amount_paise).toBe('number');
      expect(typeof r.failed_amount_paise).toBe('number');
    }

    const ts = await timeseries(WINDOW, 'hour', 'all', 'all');
    for (const p of ts) {
      expect(typeof p.gross_amount_paise).toBe('number');
      expect(typeof p.failed_amount_paise).toBe('number');
    }

    expect(typeof (await measureDrift({ from: WINDOW.from, to: WINDOW.to })).grossAmountPaise).toBe('number');
  });
});
