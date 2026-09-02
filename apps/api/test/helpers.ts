import { sql } from '../src/db/client.ts';
import { sign } from '../src/lib/signature.ts';
import { config } from '../src/config.ts';
import type { EventKind } from '../src/domain/payment-state.ts';
import type { WebhookEvent } from '../src/app/events.ts';

export const MERCHANT = 'mch_kavir';
export const CUSTOMER = 'cus_test_p3';

/**
 * Wipes only what these tests write, in FK order. Deliberately not a
 * `TRUNCATE ... CASCADE` of everything: merchants come from a migration and
 * dropping them would make the suite depend on re-running migrations.
 */
/**
 * Tests live in 2027, outside any seeded dataset, so a seeded database is
 * neither depended on nor disturbed. Rollups are cleared for that whole range:
 * deleting a payment row does not undo the rollup it contributed, and an
 * orphaned rollup row shows up as drift in a later test that did nothing wrong.
 */
export const TEST_EPOCH = '2027-01-01T00:00:00.000Z';

export async function resetFixtures(): Promise<void> {
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= ${TEST_EPOCH}`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_t_%'`;
  await sql`DELETE FROM payment_events           WHERE payment_id LIKE 'pay_t_%'`;
  await sql`DELETE FROM payments                 WHERE id         LIKE 'pay_t_%'`;
  await sql`DELETE FROM processed_events         WHERE event_id   LIKE 'evt_t_%'`;
  await sql`DELETE FROM outbox                   WHERE payload->>'payment_id' LIKE 'pay_t_%'`;
  await sql`DELETE FROM customers                WHERE id = ${CUSTOMER}`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 250000)
    ON CONFLICT (id) DO NOTHING
  `;
}

let seq = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}_${seq++}`;

export function createdEvent(paymentId: string, at: string, over: Partial<Record<string, unknown>> = {}): WebhookEvent {
  return {
    event_id: uid('evt_t_'),
    payment_id: paymentId,
    kind: 'payment.created',
    occurred_at: at,
    data: {
      merchant_id: MERCHANT,
      customer_id: CUSTOMER,
      amount_paise: 124500,
      method: 'card',
      bank: null,
      currency: 'INR',
      card_country: 'US',
      card_network: 'visa',
      is_international: true,
      threeds_required: true,
      gateway: 'primary',
      ...over,
    },
  };
}

export function event(
  paymentId: string,
  kind: EventKind,
  at: string,
  data: Record<string, unknown> = {},
): WebhookEvent {
  return { event_id: uid('evt_t_'), payment_id: paymentId, kind, occurred_at: at, data };
}

/** Posts through the real HTTP handler, signed the way a gateway would sign it. */
export async function postWebhook(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  ev: WebhookEvent,
): Promise<Response> {
  const raw = JSON.stringify(ev);
  return app.fetch(
    new Request('http://localhost/webhooks/gateway', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': sign(raw, config.WEBHOOK_SECRET),
      },
      body: raw,
    }),
  );
}

export async function countRows(table: string, where: string, value: string): Promise<number> {
  const [row] = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where} = $1`,
    [value],
  );
  return row?.n ?? 0;
}

/**
 * Fails loudly if another relay is draining the same database.
 *
 * A `bun dev` API in the background ticks its own relay every 200 ms against
 * this outbox. It claims rows these tests are waiting to deliver themselves,
 * which makes the suite fail intermittently in a way that looks like a
 * concurrency bug in the relay and is not one. Detect it and say so, rather
 * than leaving somebody to debug a phantom.
 */
export async function assertNoCompetingRelay(): Promise<void> {
  const topic = `test.probe.${Date.now()}`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO outbox (topic, payload) VALUES (${topic}, ${sql.json({ probe: true })})
    RETURNING id`;

  // Longer than the 200 ms relay tick, so a live relay will have touched it.
  await new Promise((r) => setTimeout(r, 700));

  const [after] = await sql<{ attempts: number }[]>`
    SELECT attempts FROM outbox WHERE id = ${row!.id}`;
  await sql`DELETE FROM outbox WHERE id = ${row!.id}`;

  if ((after?.attempts ?? 0) > 0) {
    throw new Error(
      'Another relay is draining this database — stop the dev API before running ' +
        'integration tests:  pkill -f "src/index.ts"',
    );
  }
}
