import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { openCases } from '../src/app/recovery.ts';
import { narrateIncidents, proposeForCases } from '../src/app/agent.ts';
import { gateCandidates } from '../src/db/queries.ts';
import { setLlmOverride } from '../src/lib/llm.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event } from './helpers.ts';

/**
 * The agent against Postgres with the model switched off — the supported
 * path (§14): every proposal is the strategy engine's own choice, recorded
 * as `fallback` with a templated narrative and a prompt hash, and the gate
 * does not see a case until that record exists.
 */

/** 2033, outside every other suite's window and every seeded dataset. */
const BASE = Date.parse('2033-02-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const NOW = new Date(BASE + 3 * 3600_000);
const CUSTOMER = 'cus_agent_p15';

async function reset(): Promise<void> {
  await sql`DELETE FROM agent_decisions WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_ag_%') OR incident_id LIKE 'inc_ag_%'`;
  await sql`DELETE FROM policy_decisions WHERE case_id IN (SELECT id FROM recovery_cases WHERE payment_id LIKE 'pay_ag_%')`;
  await sql`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_ag_%'`;
  await sql`DELETE FROM incidents WHERE id LIKE 'inc_ag_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2033-01-01' AND bucket_start < '2034-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_ag_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_ag_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_ag_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

let seq = 0;
async function failedPayment(over: Record<string, unknown> = {}): Promise<string> {
  seq += 1;
  const id = `pay_ag_${seq}`;
  await project(createdEvent(id, T(0), { customer_id: CUSTOMER, amount_paise: 480_000, ...over }));
  await project(event(id, 'payment.attempted', T(1)));
  await project(event(id, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
  return id;
}

const caseFor = async (paymentId: string) =>
  (await sql<{ id: string; chosen_strategy: string; expected_value_paise: number }[]>`
    SELECT id, chosen_strategy, expected_value_paise FROM recovery_cases WHERE payment_id = ${paymentId}`)[0]!;

beforeAll(async () => {
  await assertNoCompetingRelay();
  setLlmOverride('off');
}, 30_000);
beforeEach(reset);
afterAll(async () => {
  setLlmOverride(null);
  await reset();
});

describe('with the model off, the pipeline is correct and says so', () => {
  test('every open case gets a fallback decision whose choice is the engine argmax, with a prompt hash', async () => {
    const p1 = await failedPayment();
    const p2 = await failedPayment({ is_international: false, card_country: 'IN', method: 'upi', bank: 'HDFC', card_network: null, threeds_required: false });
    await openCases(NOW, 50);
    const before = [await caseFor(p1), await caseFor(p2)];

    const r = await proposeForCases(NOW, 50);
    expect(r.proposed).toBe(2);
    expect(r.fallback).toBe(2);
    expect(r.llm).toBe(0);
    expect(r.overridden).toBe(0);
    expect(r.changed).toBe(0);

    for (const c of before) {
      const [d] = await sql<{ source: string; narrative: string; prompt_hash: string; parsed_choice: string | null; confidence: string }[]>`
        SELECT source, narrative, prompt_hash, parsed_choice, confidence FROM agent_decisions WHERE case_id = ${c.id}`;
      expect(d!.source).toBe('fallback');
      expect(d!.parsed_choice).toBeNull();
      expect(d!.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(d!.narrative.length).toBeGreaterThan(40);
      expect(d!.confidence).toBe('medium');
      const after = await caseFor((await sql<{ payment_id: string }[]>`SELECT payment_id FROM recovery_cases WHERE id = ${c.id}`)[0]!.payment_id);
      expect(after.chosen_strategy).toBe(c.chosen_strategy);
      expect(after.expected_value_paise).toBe(c.expected_value_paise);
    }
  });

  test('a second sweep proposes nothing: one decision per case', async () => {
    await failedPayment();
    await openCases(NOW, 50);
    await proposeForCases(NOW, 50);
    const again = await proposeForCases(NOW, 50);
    expect(again.proposed).toBe(0);
  });

  test('the gate does not see a case until the agent has: proposal first, then policy', async () => {
    const p = await failedPayment();
    await openCases(NOW, 50);
    const c = await caseFor(p);
    // The worklist is global and a seeded database holds thousands of older
    // eligible cases; ask for all of them so the answer is about this case.
    const before = await gateCandidates(100_000, NOW.toISOString());
    expect(before.some((g) => g.case_id === c.id)).toBe(false);
    await proposeForCases(NOW, 50);
    const after = await gateCandidates(100_000, NOW.toISOString());
    expect(after.some((g) => g.case_id === c.id)).toBe(true);
  });

  test('a diagnosed incident gets a templated narrative, badged template, with an audit row', async () => {
    await sql`
      INSERT INTO incidents (id, merchant_id, status, dimension, dimension_value, opened_at, baseline_rate, current_rate, z_score,
                             gates, affected_payments, revenue_at_risk_paise, root_cause)
      VALUES ('inc_ag_1', NULL, 'OPEN', 'is_international', 'true', ${T(0)}, 0.19, 0.62, 7.3, '[]', 412, 19800000,
              ${sql.json({ hypotheses: [{ label: 'is_international=true ∧ card_network=visa', excessShare: 0.71, confidence: 0.9, observedRate: 0.7, expectedRate: 0.2 }] } as never)})`;
    const r = await narrateIncidents(NOW, 50);
    expect(r.narrated).toBe(1);
    expect(r.template).toBe(1);
    const [i] = await sql<{ narrative: string; narrative_source: string }[]>`SELECT narrative, narrative_source FROM incidents WHERE id = 'inc_ag_1'`;
    expect(i!.narrative_source).toBe('template');
    expect(i!.narrative).toContain('62% against a baseline of 19%');
    expect(i!.narrative).toContain('71% of the excess');
    const [d] = await sql<{ source: string }[]>`SELECT source FROM agent_decisions WHERE incident_id = 'inc_ag_1'`;
    expect(d!.source).toBe('fallback');
    expect((await narrateIncidents(NOW, 50)).narrated).toBe(0);
  });
});
