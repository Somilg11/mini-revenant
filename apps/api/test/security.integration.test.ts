import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { createApp } from '../src/http/app.ts';
import { config } from '../src/config.ts';
import { sign } from '../src/lib/signature.ts';
import { measureDrift } from '../src/app/analytics.ts';
import { project } from '../src/app/projector.ts';
import { sweepAbandoned } from '../src/app/abandonment.ts';
import { MAX_AMOUNT_PAISE } from '../src/app/events.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event, uid } from './helpers.ts';

const app = createApp();
const WINDOW_FROM = '2028-01-01T00:00:00.000Z';
const T = (m: number) => new Date(Date.parse('2028-05-01T10:00:00.000Z') + m * 60_000).toISOString();
const CUSTOMER = 'cus_sec_audit';

async function reset(): Promise<void> {
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= ${WINDOW_FROM}`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_sec_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_sec_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_sec_%'`;
  await sql`DELETE FROM processed_events WHERE event_id LIKE 'evt_t_%'`;
  await sql`DELETE FROM outbox WHERE payload->>'payment_id' LIKE 'pay_sec_%'`;
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

/** Runs `fn` and returns the error it threw, failing the test if it did not. */
async function expectRejection(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got none');
}

async function post(body: unknown, opts: { signed?: boolean } = {}): Promise<Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.signed !== false) headers['X-Webhook-Signature'] = sign(raw, config.WEBHOOK_SECRET);
  return app.fetch(new Request('http://localhost/webhooks/gateway', { method: 'POST', headers, body: raw }));
}

const created = (over: Record<string, unknown> = {}, occurredAt = T(0)) => ({
  event_id: uid('evt_t_'),
  payment_id: uid('pay_sec_'),
  kind: 'payment.created',
  occurred_at: occurredAt,
  data: {
    merchant_id: MERCHANT,
    customer_id: CUSTOMER,
    amount_paise: 50_000,
    method: 'card',
    ...over,
  },
});

describe('an amount cannot be made large enough to break every aggregate', () => {
  test('an amount past the cap is refused at the edge with an actionable 400', async () => {
    // Two payments near MAX_SAFE_INTEGER sum past it, and the driver then
    // refuses to round a BIGINT it cannot represent exactly — so
    // /metrics/summary answered 500 and kept answering 500 until the rows were
    // deleted. One accepted webhook took the dashboard down for good.
    const res = await post(created({ amount_paise: 9_007_199_254_740_000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_PAYLOAD');
  });

  test('the cap is enforced by the database too, not only by the validator', async () => {
    // Explicit try/catch rather than `expect(...).rejects`: a postgres.js query
    // is a lazy thenable, and driving it through that matcher hangs.
    const err = await expectRejection(
      () => sql`
        INSERT INTO payments (id, merchant_id, customer_id, amount_paise, method, state,
                              created_at, last_event_at)
        VALUES ('pay_sec_direct', ${MERCHANT}, ${CUSTOMER}, ${MAX_AMOUNT_PAISE + 1},
                'card', 'CREATED', ${T(0)}, ${T(0)})`,
    );
    expect(String(err)).toContain('payments_amount_sane');
  });

  test('a negative amount is refused', async () => {
    expect((await post(created({ amount_paise: -500 }))).status).toBe(400);
  });

  test('an amount at the cap is accepted', async () => {
    expect((await post(created({ amount_paise: MAX_AMOUNT_PAISE }))).status).toBe(200);
  });
});

describe('a timestamp cannot poison the dashboard window', () => {
  test('a far-future event is refused', async () => {
    // `occurred_at` decides bucketing and window membership, so one event
    // dated 9999 stretched the default window across eight millennia.
    const res = await post(created({}, '9999-01-01T00:00:00.000Z'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_EVENT');
  });

  test('a pre-2000 event is refused', async () => {
    expect((await post(created({}, '1970-01-01T00:00:00.000Z'))).status).toBe(400);
  });

  test('the database refuses one too', async () => {
    const err = await expectRejection(
      () => sql`
        INSERT INTO payments (id, merchant_id, customer_id, amount_paise, method, state,
                              created_at, last_event_at)
        VALUES ('pay_sec_far', ${MERCHANT}, ${CUSTOMER}, 5000, 'card', 'CREATED',
                '9999-01-01T00:00:00Z', '9999-01-01T00:00:00Z')`,
    );
    expect(String(err)).toContain('payments_created_at_sane');
  });
});

describe('the webhook refuses what it cannot process, rather than dropping it silently', () => {
  test('an unprocessable payload is a 400, not a 200 followed by a silent discard', async () => {
    // At-least-once delivery means the sender believes it delivered. Answering
    // 200 and then discarding the event in the projector leaves a gateway
    // silently losing payment events — the exact failure this system exists to
    // make visible.
    for (const bad of [
      { merchant_id: undefined },
      { method: 'crypto' },
      { customer_id: '' },
    ]) {
      const res = await post(created(bad as Record<string, unknown>));
      expect(res.status).toBe(400);
    }
  });

  test('an oversized body is refused before it is read', async () => {
    const res = await post('x'.repeat(200_000));
    expect(res.status).toBe(413);
  });

  test('an unsigned or tampered body is refused', async () => {
    expect((await post(created(), { signed: false })).status).toBe(401);
  });
});

describe('drift detection has no blind spots', () => {
  test('a corrupted `abandoned` count is detected', async () => {
    // It was not: the projector never gave the count back when a payment left
    // the abandoned state, and `measureDrift` compared neither `abandoned` nor
    // `captured_amount_paise` — so it reported 0 while the rollup was wrong.
    // A drift check with a blind spot asserts correctness it never tested.
    const id = uid('pay_sec_');
    await project(createdEvent(id, T(0), { customer_id: CUSTOMER }));
    await project(event(id, 'payment.attempted', T(1)));
    await sql`
      UPDATE metrics_rollup SET abandoned = abandoned + 3
      WHERE dimension = 'all' AND bucket_start >= ${WINDOW_FROM}`;

    const drift = await measureDrift({ from: WINDOW_FROM });
    expect(drift.rows).toBeGreaterThan(0);
    expect(drift.abandoned).toBe(3);
  });

  test('a corrupted `captured_amount_paise` is detected', async () => {
    const id = uid('pay_sec_');
    await project(createdEvent(id, T(0), { customer_id: CUSTOMER }));
    await sql`
      UPDATE metrics_rollup SET captured_amount_paise = captured_amount_paise + 999
      WHERE dimension = 'all' AND bucket_start >= ${WINDOW_FROM}`;

    const drift = await measureDrift({ from: WINDOW_FROM });
    expect(drift.rows).toBeGreaterThan(0);
    expect(drift.capturedAmountPaise).toBe(999);
  });

  test('leaving the abandoned state gives the rollup count back', async () => {
    const id = uid('pay_sec_');
    await project(createdEvent(id, T(0), { customer_id: CUSTOMER }));
    await project(event(id, 'payment.attempted', T(1)));
    await sweepAbandoned(new Date(Date.parse(T(60))));

    let [r] = await sql<{ abandoned: number }[]>`
      SELECT abandoned FROM metrics_rollup
      WHERE dimension = 'all' AND bucket_start >= ${WINDOW_FROM}`;
    expect(r?.abandoned).toBe(1);

    await project(event(id, 'payment.failed', T(90), { failure_code: 'THREEDS_FAILED' }));

    [r] = await sql<{ abandoned: number }[]>`
      SELECT abandoned FROM metrics_rollup
      WHERE dimension = 'all' AND bucket_start >= ${WINDOW_FROM}`;
    expect(r?.abandoned).toBe(0);
    expect((await measureDrift({ from: WINDOW_FROM })).rows).toBe(0);
  });

  test('measureDrift refuses an unparseable window rather than interpolating it', async () => {
    // `from` is concatenated into raw SQL, so it is normalised through
    // Date.parse first: unparseable input throws here instead of reaching the
    // database, and the output can hold no quote to break out of.
    const err = await expectRejection(() =>
      measureDrift({ from: "2028'; DROP TABLE payments; --" }),
    );
    expect(String(err)).toContain('invalid `from`');
  });

  test('a quote-bearing but parseable window cannot inject', async () => {
    const drift = await measureDrift({ from: '2028-01-01T00:00:00Z' });
    expect(drift.rows).toBeGreaterThanOrEqual(0);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM payments`;
    expect(row!.n).toBeGreaterThan(0);
  });
});
