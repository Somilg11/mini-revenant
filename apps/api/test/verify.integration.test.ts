import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { ingest } from '../src/app/ingest.ts';
import { project } from '../src/app/projector.ts';
import { verifyOutcomes } from '../src/app/verify.ts';
import { attributionRow } from '../src/db/queries.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event } from './helpers.ts';

/**
 * Verification against Postgres: attribution from the capture's own event and
 * our action's reference, one verdict per case by constraint, organic credits
 * zero, and `revenue_recovered` moving only from here.
 */

/** 2032, outside every other suite's window and every seeded dataset. */
const BASE = Date.parse('2032-05-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const CUSTOMER = 'cus_verify_p14';
const WINDOW = { from: '2032-01-01T00:00:00.000Z', to: '2033-01-01T00:00:00.000Z', merchantId: null };

let seq = 0;
const ids = () => {
  seq += 1;
  return { payment: `pay_v_p14_${seq}`, kase: `case_v_p14_${seq}`, decision: `pd_v_p14_${seq}`, action: `act_v_p14_${seq}` };
};

async function reset(): Promise<void> {
  await sql`DELETE FROM outcome_verifications WHERE case_id LIKE 'case_v_%'`;
  await sql`DELETE FROM recovery_actions WHERE case_id LIKE 'case_v_%'`;
  await sql`DELETE FROM policy_decisions WHERE case_id LIKE 'case_v_%'`;
  await sql`DELETE FROM recovery_cases WHERE id LIKE 'case_v_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2032-01-01' AND bucket_start < '2033-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_v_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_v_%'`;
  await sql`DELETE FROM outbox WHERE payload->>'payment_id' LIKE 'pay_v_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_v_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

/** A failed payment with a case; optionally an action we sent at `actedAtMin`. */
async function scenario(o: { actedAtMin: number | null; reference?: string; probability?: number; strategy?: string; status?: string }) {
  const id = ids();
  await project(createdEvent(id.payment, T(0), { customer_id: CUSTOMER, amount_paise: 480_000 }));
  await project(event(id.payment, 'payment.attempted', T(1)));
  await project(event(id.payment, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
  await sql`
    INSERT INTO recovery_cases (id, payment_id, merchant_id, status, recovery_probability, probability_source, chosen_strategy, expected_value_paise, opened_at)
    VALUES (${id.kase}, ${id.payment}, ${MERCHANT}, ${o.status ?? (o.actedAtMin === null ? 'OPEN' : 'ACTING')}, ${o.probability ?? 0.6}, 'model',
            ${o.strategy ?? 'alternate_gateway'}, 250000, ${T(5)})`;
  if (o.actedAtMin !== null) {
    await sql`
      INSERT INTO policy_decisions (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
      VALUES (${id.decision}, ${id.kase}, 'route_alternate_gateway', 'ALLOW', '{"rules":[]}', 'v1.0.0', 'test', ${T(o.actedAtMin)})`;
    await sql`
      INSERT INTO recovery_actions (id, case_id, policy_decision_id, kind, idempotency_key, status, attempts, cost_paise, gateway_reference, created_at, completed_at)
      VALUES (${id.action}, ${id.kase}, ${id.decision}, 'route_alternate_gateway', ${`ik_${id.decision}`}, 'SUCCEEDED', 1, 900,
              ${o.reference ?? 'gw_s_ours'}, ${T(o.actedAtMin)}, ${T(o.actedAtMin)})`;
  }
  return id;
}

/**
 * Through ingest *and* the projector: attribution reads the capture event's
 * payload from `payment_events`, which only the ingest path writes.
 */
async function capture(paymentId: string, atMin: number, reference: string | null) {
  for (const e of [
    event(paymentId, 'payment.attempted', T(atMin - 1), reference ? { gateway_reference: reference } : {}),
    event(paymentId, 'payment.captured', T(atMin), reference ? { gateway_reference: reference } : {}),
  ]) {
    await ingest(e);
    await project(e);
  }
}

const verification = async (caseId: string) =>
  (await sql<{ attribution: string; credited_amount_paise: number; recovered_amount_paise: number; actual_recovered: boolean; predicted_probability: number | null }[]>`
    SELECT * FROM outcome_verifications WHERE case_id = ${caseId}`)[0] ?? null;
const caseStatus = async (caseId: string) => (await sql<{ status: string }[]>`SELECT status FROM recovery_cases WHERE id = ${caseId}`)[0]!.status;

beforeAll(assertNoCompetingRelay, 30_000);
beforeEach(reset);
afterAll(reset);

describe('attribution', () => {
  test('direct: captured 10 minutes after our action with our reference — credited in full, case RECOVERED', async () => {
    const id = await scenario({ actedAtMin: 10, reference: 'gw_s_ours' });
    await capture(id.payment, 20, 'gw_s_ours');
    const r = await verifyOutcomes(new Date(T(30)));
    expect(r.recovered).toBe(1);
    const v = await verification(id.kase);
    expect(v!.attribution).toBe('direct');
    expect(v!.credited_amount_paise).toBe(480_000);
    expect(v!.actual_recovered).toBe(true);
    expect(v!.predicted_probability).toBeCloseTo(0.6, 6);
    expect(await caseStatus(id.kase)).toBe('RECOVERED');
  });

  test('assisted: captured 3 hours later with a different reference — credited in full', async () => {
    const id = await scenario({ actedAtMin: 10, reference: 'gw_s_ours' });
    await capture(id.payment, 10 + 180, 'gw_p_theirs');
    await verifyOutcomes(new Date(T(400)));
    const v = await verification(id.kase);
    expect(v!.attribution).toBe('assisted');
    expect(v!.credited_amount_paise).toBe(480_000);
  });

  test('organic: captured with no action at all — recovered, credits ZERO', async () => {
    const id = await scenario({ actedAtMin: null, strategy: 'do_nothing' });
    await capture(id.payment, 60, null);
    await verifyOutcomes(new Date(T(90)));
    const v = await verification(id.kase);
    expect(v!.attribution).toBe('organic');
    expect(v!.actual_recovered).toBe(true);
    expect(v!.recovered_amount_paise).toBe(480_000);
    expect(v!.credited_amount_paise).toBe(0);
    expect(await caseStatus(id.kase)).toBe('RECOVERED');
  });

  test('organic: captured 7 hours after our action, beyond the assist window — credits ZERO', async () => {
    const id = await scenario({ actedAtMin: 10, reference: 'gw_s_ours' });
    await capture(id.payment, 10 + 7 * 60, 'gw_s_ours');
    await verifyOutcomes(new Date(T(500)));
    const v = await verification(id.kase);
    expect(v!.attribution).toBe('organic');
    expect(v!.credited_amount_paise).toBe(0);
  });
});

describe('lost', () => {
  test('an action six simulated hours old with no capture is LOST; five hours is still pending', async () => {
    const id = await scenario({ actedAtMin: 10 });
    await verifyOutcomes(new Date(T(10 + 5 * 60)));
    expect(await verification(id.kase)).toBeNull();
    expect(await caseStatus(id.kase)).toBe('ACTING');
    const r = await verifyOutcomes(new Date(T(10 + 6 * 60)));
    expect(r.lost).toBe(1);
    const v = await verification(id.kase);
    expect(v!.actual_recovered).toBe(false);
    expect(v!.credited_amount_paise).toBe(0);
    expect(v!.recovered_amount_paise).toBe(0);
    expect(await caseStatus(id.kase)).toBe('LOST');
  });

  test('a do_nothing case is LOST six hours after opening; a deferred or pending case is not', async () => {
    const nothing = await scenario({ actedAtMin: null, strategy: 'do_nothing' });
    const waiting = await scenario({ actedAtMin: null, strategy: 'retry' });
    await verifyOutcomes(new Date(T(5 + 6 * 60)));
    expect(await caseStatus(nothing.kase)).toBe('LOST');
    expect(await caseStatus(waiting.kase)).toBe('OPEN');
  });
});

describe('once, by constraint', () => {
  test('a second sweep over the same capture inserts nothing and changes nothing', async () => {
    const id = await scenario({ actedAtMin: 10 });
    await capture(id.payment, 20, 'gw_s_ours');
    const first = await verifyOutcomes(new Date(T(30)));
    const second = await verifyOutcomes(new Date(T(30)));
    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    const n = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outcome_verifications WHERE case_id = ${id.kase}`;
    expect(n[0]!.n).toBe(1);
    let refused = false;
    try {
      await sql`INSERT INTO outcome_verifications (id, case_id, attribution, actual_recovered) VALUES ('ov_dup', ${id.kase}, 'direct', TRUE)`;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe('the metric', () => {
  test('revenue_recovered credits direct and assisted, and reports organic separately at zero credit', async () => {
    const a = await scenario({ actedAtMin: 10, reference: 'gw_s_ours' });
    const b = await scenario({ actedAtMin: null, strategy: 'do_nothing' });
    await capture(a.payment, 20, 'gw_s_ours');
    await capture(b.payment, 20, null);
    await verifyOutcomes(new Date(T(60)));
    const row = await attributionRow(WINDOW);
    expect(row.direct_paise).toBe(480_000);
    expect(row.assisted_paise).toBe(0);
    expect(row.organic_paise).toBe(480_000);
    expect(row.verified).toBe(2);
  });
});
