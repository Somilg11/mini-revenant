import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { createExecutor, type GatewayPort } from '../src/app/executor.ts';
import { completeAction, markActionSent, reserveAction } from '../src/db/queries.ts';
import { approve, evaluatePolicy, type PolicyInput } from '../src/domain/policy.ts';
import { SimulatedGateway } from '../src/sim/gateway.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event } from './helpers.ts';

/**
 * The Postgres half of the executor's guarantees: the idempotency key is a
 * UNIQUE constraint reserved before the gateway call, and the simulated
 * gateway's verdict reaches `payments` through the real ingest path.
 */

/** 2031, outside every other suite's window and every seeded dataset. */
const BASE = Date.parse('2031-03-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const NOW = new Date(BASE + 60 * 60_000);
const CUSTOMER = 'cus_exec_p13';
const PAYMENT = 'pay_x_p13_1';
const CASE = 'case_x_p13_1';
const DECISION = 'pd_x_p13_1';

async function reset(): Promise<void> {
  await sql`DELETE FROM recovery_actions WHERE case_id LIKE 'case_x_%'`;
  await sql`DELETE FROM policy_decisions WHERE case_id LIKE 'case_x_%'`;
  await sql`DELETE FROM recovery_cases WHERE id LIKE 'case_x_%'`;
  await sql`DELETE FROM ground_truth_labels WHERE payment_id LIKE 'pay_x_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2031-01-01' AND bucket_start < '2032-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_x_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_x_%'`;
  await sql`DELETE FROM outbox WHERE payload->>'payment_id' LIKE 'pay_x_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_x_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%' OR event_id LIKE 'evt_ik_pd_x_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

/** A failed international card payment with a recorded counterfactual. */
async function failedPayment(recoverableByGateway: boolean): Promise<void> {
  await project(createdEvent(PAYMENT, T(0), { customer_id: CUSTOMER, amount_paise: 480_000 }));
  await project(event(PAYMENT, 'payment.attempted', T(1)));
  await project(event(PAYMENT, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
  await sql`
    INSERT INTO ground_truth_labels
      (payment_id, recoverable_by_retry, recoverable_by_link, recoverable_by_alternate, recoverable_by_gateway, recoverable, split)
    VALUES (${PAYMENT}, FALSE, FALSE, FALSE, ${recoverableByGateway}, ${recoverableByGateway}, 'test')`;
  await sql`
    INSERT INTO recovery_cases (id, payment_id, merchant_id, status, chosen_strategy, expected_value_paise, opened_at)
    VALUES (${CASE}, ${PAYMENT}, ${MERCHANT}, 'OPEN', 'alternate_gateway', 250000, ${T(5)})`;
  await sql`
    INSERT INTO policy_decisions (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
    VALUES (${DECISION}, ${CASE}, 'route_alternate_gateway', 'ALLOW', '{"rules":[]}', 'v1.0.0', 'test', ${T(6)})`;
}

const input: PolicyInput = {
  now: NOW.toISOString(),
  merchant: { id: MERCHANT, isPaused: false, dailyActionBudgetPaise: 5_000_000, dailyActionBudgetCount: 200 },
  merchantToday: { actionCount: 0, actionSpendPaise: 0 },
  merchantHour: { exposurePaise: 0 },
  customer: { optedOut: false },
  payment: { id: PAYMENT, state: 'FAILED', amountPaise: 480_000, attemptIndex: 1, failureFamily: 'CROSS_BORDER' },
  lastActionAt: null,
  proposal: { caseId: CASE, strategy: 'alternate_gateway', actionKind: 'route_alternate_gateway', expectedValuePaise: 250_000, costPaise: 900 },
  openIncidentOnSlice: false,
};
const approved = approve(input, evaluatePolicy(input))!;

/** Drains the outbox rows this suite wrote, in order, through the projector. */
async function drain(): Promise<void> {
  const rows = await sql<{ id: number; payload: { event_id: string; payment_id: string; kind: string; occurred_at: string; data: Record<string, unknown> } }[]>`
    SELECT id, payload FROM outbox WHERE sent_at IS NULL AND payload->>'payment_id' LIKE 'pay_x_%' ORDER BY id`;
  for (const r of rows) {
    await project(r.payload as never);
    await sql`UPDATE outbox SET sent_at = now() WHERE id = ${r.id}`;
  }
}

function build(gateway: GatewayPort) {
  return createExecutor({
    gateway,
    store: { reserve: reserveAction, markSent: markActionSent, complete: completeAction },
    sleep: async () => {},
    jitter: () => 0.5,
  });
}

beforeAll(assertNoCompetingRelay, 30_000);
beforeEach(reset);
afterAll(reset);

describe('the idempotency key is reserved before the gateway call, by constraint', () => {
  test('the same decision executed twice creates one action and one gateway effect', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    const executor = build(gateway);

    const first = await executor.execute(approved, DECISION, NOW);
    const second = await executor.execute(approved, DECISION, NOW);

    expect(second.replayed).toBe(true);
    expect(second.action.id).toBe(first.action.id);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM recovery_actions WHERE case_id = ${CASE}`;
    expect(rows[0]!.n).toBe(1);
    expect(gateway.snapshot().effects).toBeLessThanOrEqual(1);

    const [c] = await sql<{ status: string }[]>`SELECT status FROM recovery_cases WHERE id = ${CASE}`;
    expect(c!.status).toBe('ACTING');
  });

  test('two executors racing on the same key: the constraint lets exactly one through', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    const a = build(gateway);
    const b = build(gateway);
    const [ra, rb] = await Promise.all([a.execute(approved, DECISION, NOW), b.execute(approved, DECISION, NOW)]);
    expect([ra.replayed, rb.replayed].filter(Boolean)).toHaveLength(1);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM recovery_actions WHERE idempotency_key = ${`ik_${DECISION}`}`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe('the simulator panel\'s fault injector (§13 step 9)', () => {
  test('three injected 429s: capped backoff, two retries, then ESCALATED rather than a loop — and no gateway effect', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    gateway.injectFaults('retryable', 3);
    const r = await build(gateway).execute(approved, DECISION, NOW);
    expect(r.action.status).toBe('ESCALATED');
    expect(r.action.attempts).toBe(3);
    expect(r.action.error_class).toBe('RETRYABLE');
    const g = gateway.snapshot();
    expect(g.faults.retryable).toBe(3);
    expect(g.effects).toBe(0);
    expect(g.queuedFaults).toEqual([]);
  });

  test('an injected timeout is reconciled by reference, never blind-retried: the gateway is asked what it did', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    gateway.injectFaults('timeout', 1);
    const r = await build(gateway).execute(approved, DECISION, NOW);
    const g = gateway.snapshot();
    expect(g.faults.timeout).toBe(1);
    // Either the gateway had acted (adopted by reference, one attempt) or it
    // had not (a confirmed nothing, then a retry). Never two effects.
    expect(g.effects).toBeLessThanOrEqual(1);
    if (r.reconciled) expect(r.action.attempts).toBe(1);
    else expect(r.action.attempts).toBeGreaterThanOrEqual(2);
  });

  test('an injected hard rejection fails at once', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    gateway.injectFaults('terminal', 1);
    const r = await build(gateway).execute(approved, DECISION, NOW);
    expect(r.action.status).toBe('FAILED');
    expect(r.action.error_class).toBe('TERMINAL');
    expect(r.action.attempts).toBe(1);
    expect(gateway.snapshot().effects).toBe(0);
  });
});

describe('the gateway answers from the counterfactual, through the real ingest path', () => {
  test('recoverable_by_gateway = true: attempted then captured land on the payment with our reference', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    // The first draw for this key may be an injected fault; the executor's
    // retry loop is what gets past it. What is asserted is the end state.
    const r = await build(gateway).execute(approved, DECISION, NOW);
    if (r.action.status !== 'SUCCEEDED') {
      // A key that draws ≥3 faults in a row escalates — vanishingly rare, and
      // not what this test is about. Say so rather than fail mysteriously.
      throw new Error(`unlucky key: ${r.action.status} after ${r.action.attempts} attempts`);
    }
    await drain();

    const [p] = await sql<{ state: string; attempt_index: number; gateway: string }[]>`
      SELECT state::text, attempt_index, gateway FROM payments WHERE id = ${PAYMENT}`;
    expect(p!.state).toBe('CAPTURED');
    expect(p!.attempt_index).toBe(2);
    expect(p!.gateway).toBe('secondary');

    const [captured] = await sql<{ payload: { gateway_reference: string } }[]>`
      SELECT payload FROM payment_events WHERE payment_id = ${PAYMENT} AND kind = 'payment.captured'`;
    expect(captured!.payload.gateway_reference).toBe(r.action.gateway_reference!);
  });

  test('recoverable_by_gateway = false: attempted then failed, and the payment stays FAILED', async () => {
    await failedPayment(false);
    const gateway = new SimulatedGateway();
    const r = await build(gateway).execute(approved, DECISION, NOW);
    if (r.action.status !== 'SUCCEEDED') throw new Error(`unlucky key: ${r.action.status}`);
    expect(r.gateway!.recovered).toBe(false);
    await drain();
    const [p] = await sql<{ state: string; attempt_index: number }[]>`SELECT state::text, attempt_index FROM payments WHERE id = ${PAYMENT}`;
    expect(p!.state).toBe('FAILED');
    expect(p!.attempt_index).toBe(2);
  });

  test('the secondary route refuses an INR-only instrument: TERMINAL, no events, no retry', async () => {
    await failedPayment(true);
    await sql`UPDATE payments SET method = 'upi', card_network = NULL, card_country = NULL, is_international = FALSE WHERE id = ${PAYMENT}`;
    const gateway = new SimulatedGateway();
    const r = await build(gateway).execute(approved, DECISION, NOW);
    // The route check happens inside the effect, after the fault draw; a
    // RETRYABLE draw first is retried and then refused, so attempts may be >1.
    expect(['FAILED', 'ESCALATED']).toContain(r.action.status);
    if (r.action.status === 'FAILED') {
      expect(r.action.error_class).toBe('TERMINAL');
      expect(gateway.snapshot().refusedByRoute).toBe(1);
    }
    const events = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_events WHERE payment_id = ${PAYMENT} AND payload->>'recovery_action' IS NOT NULL`;
    expect(events[0]!.n).toBe(0);
  });

  test('the gateway honours its own idempotency: a replayed key returns the first result and acts once', async () => {
    await failedPayment(true);
    const gateway = new SimulatedGateway();
    const key = 'ik_pd_x_direct';
    let first: Awaited<ReturnType<typeof gateway.executeAction>> | null = null;
    for (let i = 0; i < 5 && !first; i += 1) {
      try {
        first = await gateway.executeAction('route_alternate_gateway', PAYMENT, key, NOW);
      } catch (err) {
        if ((err as { outcomeUnknown?: boolean }).outcomeUnknown) first = await gateway.lookup(key);
      }
    }
    expect(first).not.toBeNull();
    const again = await gateway.executeAction('route_alternate_gateway', PAYMENT, key, NOW);
    expect(again.reference).toBe(first!.reference);
    expect(gateway.snapshot().effects).toBe(1);
    const events = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM payment_events WHERE payment_id = ${PAYMENT} AND payload->>'recovery_action' = ${key}`;
    expect(events[0]!.n).toBe(2);
  });
});
