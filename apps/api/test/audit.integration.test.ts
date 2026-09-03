import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { ingest } from '../src/app/ingest.ts';
import { project } from '../src/app/projector.ts';
import { openCases } from '../src/app/recovery.ts';
import { proposeForCases } from '../src/app/agent.ts';
import { runGate } from '../src/app/policy.ts';
import { verifyOutcomes } from '../src/app/verify.ts';
import { auditTrail } from '../src/app/audit.ts';
import { setLlmOverride } from '../src/lib/llm.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event } from './helpers.ts';

/**
 * §14: `/api/v1/audit/:paymentId` returns every stage in causal order with
 * its inputs, and every recomputable stage reproduces.
 */

/** 2034, outside every other suite's window and every seeded dataset. */
const BASE = Date.parse('2034-04-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const CUSTOMER = 'cus_audit_p16';
const PAYMENT = 'pay_au_p16_1';

async function reset(): Promise<void> {
  await sql`DELETE FROM outcome_verifications WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_au_%')`;
  await sql`DELETE FROM recovery_actions WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_au_%')`;
  await sql`DELETE FROM policy_decisions WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_au_%')`;
  await sql`DELETE FROM agent_decisions WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_au_%')`;
  await sql`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_au_%'`;
  await sql`DELETE FROM ground_truth_labels WHERE payment_id LIKE 'pay_au_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2034-01-01' AND bucket_start < '2035-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_au_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_au_%'`;
  await sql`DELETE FROM outbox WHERE payload->>'payment_id' LIKE 'pay_au_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_au_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%' OR event_id LIKE 'evt_ik_pd_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

/** Drains this suite's outbox rows through the projector, in order. */
async function drain(): Promise<void> {
  const rows = await sql<{ id: number; payload: never }[]>`
    SELECT id, payload FROM outbox WHERE sent_at IS NULL AND payload->>'payment_id' LIKE 'pay_au_%' ORDER BY id`;
  for (const r of rows) {
    await project(r.payload);
    await sql`UPDATE outbox SET sent_at = now() WHERE id = ${r.id}`;
  }
}

beforeAll(async () => {
  await assertNoCompetingRelay();
  setLlmOverride('off');
}, 30_000);
beforeEach(reset);
afterAll(async () => {
  setLlmOverride(null);
  await reset();
});

describe('the chain of custody', () => {
  test('event → case → agent → policy → action → outcome, in causal order, and every stored stage reproduces', async () => {
    for (const e of [
      createdEvent(PAYMENT, T(0), { customer_id: CUSTOMER, amount_paise: 480_000 }),
      event(PAYMENT, 'payment.attempted', T(1)),
      event(PAYMENT, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }),
    ]) {
      await ingest(e);
      await project(e);
    }
    await sql`
      INSERT INTO ground_truth_labels
        (payment_id, recoverable_by_retry, recoverable_by_link, recoverable_by_alternate, recoverable_by_gateway, recoverable, split)
      VALUES (${PAYMENT}, FALSE, FALSE, FALSE, TRUE, TRUE, 'test')`;

    const now = new Date(T(60));
    await openCases(now, 50);
    await proposeForCases(now, 50);
    // Scoped to this case: the worklist is global and a seeded database holds
    // thousands of older eligible cases.
    const [own] = await sql<{ id: string }[]>`SELECT id FROM recovery_cases WHERE payment_id = ${PAYMENT}`;
    const g = await runGate(now, 50, [own!.id]);
    if (g.gate.evaluated !== 1 || g.execute.executed !== 1) throw new Error(`expected one gated and one executed, got ${JSON.stringify({ gate: g.gate.evaluated, executed: g.execute.executed })}`);
    await drain();
    await verifyOutcomes(new Date(T(120)));

    const trail = await auditTrail(PAYMENT);
    expect(trail.payment.id).toBe(PAYMENT);

    const stages = trail.nodes.map((n) => n.stage);
    for (const s of ['event', 'case', 'agent', 'policy', 'action'] as const) expect(stages).toContain(s);
    // Causal: no node earlier in the list is later in simulated time.
    for (let i = 1; i < trail.nodes.length; i += 1) expect(trail.nodes[i]!.at >= trail.nodes[i - 1]!.at).toBe(true);
    // And within the sweep's instant, the pipeline order holds.
    const order = ['case', 'agent', 'policy', 'action'].map((s) => stages.indexOf(s as never));
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    // The policy node re-evaluated from its stored input and matched.
    const policy = trail.nodes.find((n) => n.stage === 'policy')!;
    expect(policy.reproduced?.ok).toBe(true);
    expect(policy.inputs.input).not.toBeNull();
    expect(String(policy.inputs.input_hash)).toMatch(/^[0-9a-f]{64}$/);
    // The case node's EV arithmetic re-added and matched.
    const kase = trail.nodes.find((n) => n.stage === 'case')!;
    expect(kase.reproduced?.ok).toBe(true);
    expect(trail.reproduced.checked).toBeGreaterThanOrEqual(2);
    expect(trail.reproduced.ok).toBe(trail.reproduced.checked);

    // Every event carries its payload and the transition it caused.
    const events = trail.nodes.filter((n) => n.stage === 'event');
    expect(events.length).toBeGreaterThanOrEqual(3);
    // `payment.created` brings the row into being; the first *transition* is the attempt.
    expect(events[0]!.artefact.transition).toBeNull();
    expect(events[1]!.artefact.transition).toBe('CREATED → ATTEMPTED');
    expect(events[2]!.artefact.transition).toBe('ATTEMPTED → FAILED');
    // The action carries its idempotency key; the agent its prompt hash.
    expect(String(trail.nodes.find((n) => n.stage === 'action')!.inputs.idempotency_key)).toMatch(/^ik_pd_/);
    expect(String(trail.nodes.find((n) => n.stage === 'agent')!.inputs.prompt_hash)).toMatch(/^[0-9a-f]{64}$/);
    // If the gateway recovered it, the outcome closes the chain.
    const outcome = trail.nodes.find((n) => n.stage === 'outcome');
    if (outcome) expect(['direct', 'assisted', 'organic']).toContain(outcome.artefact.attribution);
  });

  test('an unknown payment is a 404, not an empty page', async () => {
    let code: string | null = null;
    try {
      await auditTrail('pay_au_nope');
    } catch (err) {
      code = (err as { code?: string }).code ?? null;
    }
    expect(code).toBe('NOT_FOUND');
  });
});
