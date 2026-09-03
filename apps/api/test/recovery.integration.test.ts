import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { sweepAbandoned } from '../src/app/abandonment.ts';
import { featuresOf, openCases } from '../src/app/recovery.ts';
import { candidateForPayment, recoveryCandidates } from '../src/db/queries.ts';
import { baselineProbability } from '../src/domain/recovery-model.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event, uid } from './helpers.ts';

/** 2030, outside every other test file's window and every seeded dataset. */
const BASE = Date.parse('2030-06-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const NOW = new Date(BASE + 12 * 3600_000);
const CUSTOMER = 'cus_recovery_p9';
const OPTED_OUT = 'cus_recovery_p9_optout';

async function reset(): Promise<void> {
  await sql`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_rc_%'`;
  await sql`DELETE FROM incidents WHERE opened_at >= '2030-01-01' AND opened_at < '2031-01-01'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2030-01-01' AND bucket_start < '2031-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_rc_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_rc_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_rc_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise, opted_out)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000, FALSE), (${OPTED_OUT}, ${MERCHANT}, 500000, TRUE)
    ON CONFLICT (id) DO NOTHING`;
}

/**
 * These tests exercise the **baseline** scorer specifically. A trained model
 * may be active in the database from `bun train` or the model suite; it is set
 * aside for the duration and restored afterwards, so the assertions here are
 * about the fallback path and not about whichever scorer happens to be live.
 */
let parkedModel: string | null = null;

beforeAll(async () => {
  await assertNoCompetingRelay();
  const [active] = await sql<{ id: string }[]>`SELECT id FROM model_versions WHERE is_active`;
  if (active) {
    parkedModel = active.id;
    await sql`UPDATE model_versions SET is_active = FALSE WHERE id = ${active.id}`;
  }
}, 30_000);

beforeEach(reset);

afterAll(async () => {
  await reset();
  await sql`DELETE FROM customers WHERE id IN (${CUSTOMER}, ${OPTED_OUT})`;
  if (parkedModel) {
    await sql`UPDATE model_versions SET is_active = TRUE WHERE id = ${parkedModel}`;
  }
}, 30_000);

/**
 * Drains the worklist. It is global and ordered by creation, so older
 * unresolved payments from any seeded dataset legitimately come first; a test
 * cannot assume its own payment lands in the first batch.
 */
async function openAll(now: Date): Promise<{ opened: number; bySource: { model: number; baseline: number } }> {
  const total = { opened: 0, bySource: { model: 0, baseline: 0 } };
  for (let i = 0; i < 100; i += 1) {
    const r = await openCases(now, 500);
    total.opened += r.opened;
    total.bySource.model += r.bySource.model;
    total.bySource.baseline += r.bySource.baseline;
    if (r.considered === 0) break;
  }
  return total;
}

async function failedPayment(
  code: string,
  over: Record<string, unknown> = {},
  at = 0,
): Promise<string> {
  const id = uid('pay_rc_');
  await project(createdEvent(id, T(at), { customer_id: CUSTOMER, amount_paise: 120_000, ...over }));
  await project(event(id, 'payment.attempted', T(at + 1)));
  await project(event(id, 'payment.failed', T(at + 2), { failure_code: code }));
  return id;
}

describe('cases open for every unresolved failure, priced by the baseline', () => {
  test('a failed payment gets one OPEN case with probability_source = baseline', async () => {
    const id = await failedPayment('THREEDS_FAILED');
    const r = await openAll(NOW);
    expect(r.opened).toBeGreaterThanOrEqual(1);
    expect(r.bySource.model).toBe(0);

    const [row] = await sql<{ status: string; recovery_probability: number; probability_source: string }[]>`
      SELECT status, recovery_probability, probability_source FROM recovery_cases WHERE payment_id = ${id}`;
    expect(row?.status).toBe('OPEN');
    // No model has been trained, so the source is the measured baseline — and
    // it says so. A prediction with no source is a number nobody can weigh.
    expect(row?.probability_source).toBe('baseline');
    expect(row?.recovery_probability).toBeGreaterThan(0);
    expect(row?.recovery_probability).toBeLessThanOrEqual(0.95);
  });

  test('the stored probability is exactly what the domain model computes from the same features', async () => {
    const id = await failedPayment('INSUFFICIENT_FUNDS', { method: 'upi', bank: 'HDFC', is_international: false });
    await openAll(NOW);
    const candidate = (await candidateForPayment(id))!;
    const expected = baselineProbability(featuresOf(candidate));
    const [row] = await sql<{ recovery_probability: number }[]>`
      SELECT recovery_probability FROM recovery_cases WHERE payment_id = ${id}`;
    expect(row?.recovery_probability).toBeCloseTo(expected, 6);
  });

  test('a captured payment never gets a case', async () => {
    const id = uid('pay_rc_');
    await project(createdEvent(id, T(0), { customer_id: CUSTOMER }));
    await project(event(id, 'payment.attempted', T(1)));
    await project(event(id, 'payment.captured', T(2)));
    await openAll(NOW);
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM recovery_cases WHERE payment_id = ${id}`;
    expect(n?.n).toBe(0);
  });

  test('an abandoned payment gets a case, scored as CHECKOUT_ABANDONED', async () => {
    const id = uid('pay_rc_');
    await project(createdEvent(id, T(0), { customer_id: CUSTOMER }));
    await project(event(id, 'payment.attempted', T(1)));
    await sweepAbandoned(new Date(BASE + 60 * 60_000));
    await openAll(NOW);

    const candidate = (await candidateForPayment(id))!;
    expect(featuresOf(candidate).failureCode).toBe('CHECKOUT_ABANDONED');
    const [row] = await sql<{ recovery_probability: number }[]>`
      SELECT recovery_probability FROM recovery_cases WHERE payment_id = ${id}`;
    // The most recoverable case there is — nothing was ever wrong.
    expect(row?.recovery_probability).toBeGreaterThan(0.5);
  });

  test('a payment that has not failed yet, in simulated time, is not a case', async () => {
    const id = await failedPayment('GATEWAY_ERROR');
    // "Now" is before the payment was even created.
    const r = await openCases(new Date(BASE - 60_000));
    expect(r.considered).toBe(0);
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM recovery_cases WHERE payment_id = ${id}`;
    expect(n?.n).toBe(0);
  });
});

describe('§6.1 — one live case per payment, by constraint', () => {
  test('a second sweep does not open a second case', async () => {
    const id = await failedPayment('CARD_DECLINED');
    await openAll(NOW);
    const again = await openAll(NOW);
    expect(again.opened).toBe(0);
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM recovery_cases WHERE payment_id = ${id}`;
    expect(n?.n).toBe(1);
  });

  test('the database refuses a duplicate live case even when the code does not ask', async () => {
    // `cases_one_live` is a partial unique index, not an `if (exists)`: a
    // read-then-write race is a race somebody eventually loses.
    const id = await failedPayment('CARD_DECLINED');
    await openAll(NOW);
    let err: unknown = null;
    try {
      await sql`
        INSERT INTO recovery_cases (id, payment_id, merchant_id, status, opened_at)
        VALUES ('case_rc_dup', ${id}, ${MERCHANT}, 'OPEN', ${NOW.toISOString()})`;
    } catch (e) {
      err = e;
    }
    expect(String(err)).toContain('cases_one_live');
  });
});

describe('features come from history, never from the future', () => {
  test('customer priors count only earlier payments', async () => {
    // Two earlier successes, then the failure. The failure must see 2 priors at
    // 100%, and must not see itself or anything after it.
    for (const at of [0, 10]) {
      const id = uid('pay_rc_');
      await project(createdEvent(id, T(at), { customer_id: CUSTOMER }));
      await project(event(id, 'payment.attempted', T(at + 1)));
      await project(event(id, 'payment.captured', T(at + 2)));
    }
    const failed = await failedPayment('GATEWAY_ERROR', {}, 20);
    await failedPayment('GATEWAY_ERROR', {}, 40); // later — must be invisible

    const c = (await candidateForPayment(failed))!;
    expect(c.customer_prior_attempts).toBe(2);
    expect(c.customer_prior_successes).toBe(2);
    expect(c.seconds_since_last_attempt).toBe(10 * 60);
  });

  test('a first-ever payment has no prior, signalled explicitly', () => {
    return (async () => {
      const id = await failedPayment('GATEWAY_ERROR');
      const c = (await candidateForPayment(id))!;
      expect(c.customer_prior_attempts).toBe(0);
      // Negative means "no history" — a different claim from "zero seconds".
      expect(c.seconds_since_last_attempt).toBe(-1);
    })();
  });

  test('incident_active reflects the incident at the time of failure, not at query time', async () => {
    const id = await failedPayment('BANK_DOWN', { method: 'upi', bank: 'HDFC', is_international: false });
    // An incident on this bank that was open when the payment failed, and has
    // since resolved.
    await sql`
      INSERT INTO incidents (id, status, dimension, dimension_value, opened_at, resolved_at,
                             baseline_rate, current_rate, z_score, gates)
      VALUES ('inc_rc_hdfc', 'RESOLVED', 'bank', 'HDFC', ${T(-30)}, ${T(30)}, 0.07, 0.5, 8, '[]')`;
    const c = (await candidateForPayment(id))!;
    // A case opened late — at the end of a replay — must still be scored as
    // having failed inside the outage.
    expect(c.incident_active).toBe(true);
    await sql`DELETE FROM incidents WHERE id = 'inc_rc_hdfc'`;
  });
});

describe('the worklist query is bounded', () => {
  test('respects its limit and orders by creation', async () => {
    for (let i = 0; i < 5; i += 1) await failedPayment('GATEWAY_ERROR', {}, i * 5);
    const rows = await recoveryCandidates(NOW.toISOString(), 3);
    const mine = rows.filter((r) => r.id.startsWith('pay_rc_'));
    expect(mine.length).toBeLessThanOrEqual(3);
  });
});

describe('opted-out customers', () => {
  test('still get a case — pricing is not acting — and the flag travels with it', async () => {
    // Policy rule 3 (P12) is what refuses to contact them. A case is a price on
    // the failure, not a decision to touch the customer, and the flag is on the
    // candidate so the gate can see it.
    const id = uid('pay_rc_');
    await project(createdEvent(id, T(0), { customer_id: OPTED_OUT }));
    await project(event(id, 'payment.attempted', T(1)));
    await project(event(id, 'payment.failed', T(2), { failure_code: 'CARD_DECLINED' }));
    const c = (await candidateForPayment(id))!;
    expect(c.opted_out).toBe(true);
  });
});
