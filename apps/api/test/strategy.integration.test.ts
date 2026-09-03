import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import { openCases } from '../src/app/recovery.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event, uid } from './helpers.ts';

/** 2031, outside every other window. */
const BASE = Date.parse('2031-02-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const NOW = new Date(BASE + 6 * 3600_000);
const CUSTOMER = 'cus_strategy_p11';

async function reset(): Promise<void> {
  await sql`DELETE FROM recovery_cases WHERE payment_id LIKE 'pay_st_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2031-01-01' AND bucket_start < '2032-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_st_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_st_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_st_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise) VALUES (${CUSTOMER}, ${MERCHANT}, 250000)
    ON CONFLICT (id) DO NOTHING`;
}

beforeAll(assertNoCompetingRelay);
beforeEach(reset);
afterAll(async () => {
  await reset();
  await sql`DELETE FROM customers WHERE id = ${CUSTOMER}`;
});

async function openAll(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const r = await openCases(NOW, 500);
    if (r.considered === 0) break;
  }
}

async function failed(code: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = uid('pay_st_');
  await project(createdEvent(id, T(0), { customer_id: CUSTOMER, amount_paise: 480_000, ...over }));
  await project(event(id, 'payment.attempted', T(1)));
  await project(event(id, 'payment.failed', T(2), { failure_code: code }));
  return id;
}

async function decisionOf(paymentId: string) {
  const [row] = await sql<{ chosen_strategy: string; expected_value_paise: number; strategy_options: { strategy: string; available: boolean; expectedValuePaise: number }[] }[]>`
    SELECT chosen_strategy, expected_value_paise, strategy_options FROM recovery_cases WHERE payment_id = ${paymentId}`;
  return row!;
}

describe('§7.6 — the decision is made and stored when a case opens', () => {
  test('a cross-border 3DS failure chooses alternate_gateway, with all five options stored', async () => {
    const id = await failed('THREEDS_FAILED', { is_international: true, card_country: 'US', card_network: 'visa', method: 'card' });
    await openAll();
    const d = await decisionOf(id);
    expect(d.chosen_strategy).toBe('alternate_gateway');
    expect(d.expected_value_paise).toBeGreaterThan(0);
    expect(d.strategy_options.map((o) => o.strategy).sort()).toEqual([
      'alternate_gateway', 'alternate_method', 'do_nothing', 'payment_link', 'retry',
    ]);
  });

  test('a domestic insufficient-funds chooses a plain retry over the second processor', async () => {
    const id = await failed('INSUFFICIENT_FUNDS', { is_international: false, method: 'card', card_network: 'visa', card_country: 'IN', bank: 'HDFC' });
    await openAll();
    const d = await decisionOf(id);
    // Not alternate_gateway — or this is a second retry bot.
    expect(d.chosen_strategy).not.toBe('alternate_gateway');
    const retry = d.strategy_options.find((o) => o.strategy === 'retry')!;
    const gateway = d.strategy_options.find((o) => o.strategy === 'alternate_gateway')!;
    expect(retry.expectedValuePaise).toBeGreaterThan(gateway.expectedValuePaise);
  });

  test('a suspected fraud chooses do_nothing, and every acting option is unavailable', async () => {
    const id = await failed('FRAUD_SUSPECTED');
    await openAll();
    const d = await decisionOf(id);
    expect(d.chosen_strategy).toBe('do_nothing');
    expect(d.expected_value_paise).toBe(0);
    for (const o of d.strategy_options) {
      if (o.strategy !== 'do_nothing') expect(o.available).toBe(false);
    }
  });

  test('a tiny amount chooses do_nothing — the cost exceeds the expectation', async () => {
    const id = await failed('CARD_DECLINED', { amount_paise: 300 });
    await openAll();
    expect((await decisionOf(id)).chosen_strategy).toBe('do_nothing');
  });

  test('a UPI failure cannot choose the second processor at all', async () => {
    const id = await failed('PAYMENT_TIMEOUT', { method: 'upi', bank: 'HDFC', is_international: false, card_network: null, card_country: null });
    await openAll();
    const d = await decisionOf(id);
    const gateway = d.strategy_options.find((o) => o.strategy === 'alternate_gateway')!;
    // §8.6: the secondary processor refuses INR-only instruments.
    expect(gateway.available).toBe(false);
    expect(d.chosen_strategy).toBe('retry');
  });
});
