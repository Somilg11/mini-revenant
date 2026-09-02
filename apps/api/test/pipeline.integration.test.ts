import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql, closeDb } from '../src/db/client.ts';
import { drainOnce, registerHandler } from '../src/app/relay.ts';
import { project } from '../src/app/projector.ts';
import { ingest } from '../src/app/ingest.ts';
import { sweepAbandoned } from '../src/app/abandonment.ts';
import { createApp } from '../src/http/app.ts';
import { config } from '../src/config.ts';
import {
  CUSTOMER,
  assertNoCompetingRelay,
  countRows,
  createdEvent,
  event,
  postWebhook,
  resetFixtures,
  uid,
} from './helpers.ts';

const app = createApp();

const T = (mins: number) => new Date(Date.parse('2026-07-25T10:00:00.000Z') + mins * 60_000).toISOString();

beforeAll(assertNoCompetingRelay);
beforeEach(resetFixtures);
afterAll(async () => {
  await resetFixtures();
  await closeDb();
});

/** Drains until the queue is empty, so a test never depends on one batch. */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const r = await drainOnce();
    if (r.claimed === 0) return;
  }
  throw new Error('outbox did not drain');
}

describe('§14 — posting the same webhook 3× has the effect of posting it once', () => {
  test('one payment, one transition, one event row', async () => {
    const id = uid('pay_t_');
    const created = createdEvent(id, T(0));
    const failed = event(id, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' });
    const attempted = event(id, 'payment.attempted', T(1));

    // Each event delivered three times, as an at-least-once gateway would.
    for (const ev of [created, attempted, failed]) {
      for (let i = 0; i < 3; i += 1) {
        const res = await postWebhook(app, ev);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { outcome: string };
        expect(body.outcome).toBe(i === 0 ? 'accepted' : 'duplicate');
      }
    }

    await drainAll();

    expect(await countRows('payments', 'id', id)).toBe(1);
    expect(await countRows('payment_events', 'payment_id', id)).toBe(3);
    // CREATED→ATTEMPTED and ATTEMPTED→FAILED. Creation is not a transition.
    expect(await countRows('payment_state_transitions', 'payment_id', id)).toBe(2);

    const [p] = await sql<{ state: string; failure_code: string }[]>`
      SELECT state, failure_code FROM payments WHERE id = ${id}`;
    expect(p?.state).toBe('FAILED');
    expect(p?.failure_code).toBe('THREEDS_FAILED');
  });

  test('the duplicate never reaches the outbox — idempotency is by constraint', async () => {
    const id = uid('pay_t_');
    const ev = createdEvent(id, T(0));

    const first = await ingest(ev);
    const second = await ingest(ev);
    const third = await ingest(ev);

    expect(first.outcome).toBe('accepted');
    expect(second.outcome).toBe('duplicate');
    expect(third.outcome).toBe('duplicate');

    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox WHERE payload->>'payment_id' = ${id}`;
    expect(row?.n).toBe(1);
  });

  test('a redelivered event that already projected is a no-op, not a re-apply', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    const attempted = event(id, 'payment.attempted', T(1));

    expect((await project(attempted)).outcome).toBe('applied');
    expect((await project(attempted)).outcome).toBe('already_processed');
    expect((await project(attempted)).outcome).toBe('already_processed');

    expect(await countRows('payment_state_transitions', 'payment_id', id)).toBe(1);
    const [p] = await sql<{ attempt_index: number }[]>`
      SELECT attempt_index FROM payments WHERE id = ${id}`;
    expect(p?.attempt_index).toBe(1);
  });
});

describe('§14 — an out-of-order event is recorded stale and does not move state', () => {
  test('stale transition is written, payment state unchanged', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    await project(event(id, 'payment.attempted', T(10)));

    const late = event(id, 'payment.failed', T(5), { failure_code: 'CARD_DECLINED' });
    expect((await project(late)).outcome).toBe('stale');

    const [p] = await sql<{ state: string; failure_code: string | null }[]>`
      SELECT state, failure_code FROM payments WHERE id = ${id}`;
    expect(p?.state).toBe('ATTEMPTED');
    expect(p?.failure_code).toBeNull();

    const [t] = await sql<{ stale: boolean; from_state: string; to_state: string }[]>`
      SELECT stale, from_state, to_state FROM payment_state_transitions
      WHERE payment_id = ${id} AND stale ORDER BY id DESC LIMIT 1`;
    expect(t?.stale).toBe(true);
    expect(t?.from_state).toBe('ATTEMPTED');
    expect(t?.to_state).toBe('ATTEMPTED');
  });
});

describe('terminal protection reaches the database, not just the domain', () => {
  test('a CAPTURED payment is never re-attempted', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    await project(event(id, 'payment.attempted', T(1)));
    await project(event(id, 'payment.captured', T(2)));

    const retry = await project(event(id, 'payment.attempted', T(3)));
    expect(retry.outcome).toBe('rejected');
    expect(retry.reason).toBe('TERMINAL_PROTECTED');

    const [p] = await sql<{ state: string; attempt_index: number }[]>`
      SELECT state, attempt_index FROM payments WHERE id = ${id}`;
    expect(p?.state).toBe('CAPTURED');
    expect(p?.attempt_index).toBe(1);
  });
});

describe('recovery path — FAILED → ATTEMPTED increments attempt_index', () => {
  test('and a capture after the retry lands', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    await project(event(id, 'payment.attempted', T(1)));
    await project(event(id, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));

    const retry = await project(event(id, 'payment.attempted', T(40), { gateway: 'secondary' }));
    expect(retry.outcome).toBe('applied');

    const [p] = await sql<{ attempt_index: number; gateway: string; failure_code: string | null }[]>`
      SELECT attempt_index, gateway, failure_code FROM payments WHERE id = ${id}`;
    expect(p?.attempt_index).toBe(2);
    expect(p?.gateway).toBe('secondary');
    // A new attempt clears the previous verdict.
    expect(p?.failure_code).toBeNull();

    await project(event(id, 'payment.captured', T(41)));
    const [row] = await sql<{ state: string }[]>`SELECT state FROM payments WHERE id = ${id}`;
    expect(row?.state).toBe('CAPTURED');

    // The "was this ever FAILED?" test that revenue_recovered depends on (§10).
    const [ever] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_state_transitions
      WHERE payment_id = ${id} AND to_state = 'FAILED' AND NOT stale`;
    expect(ever?.n).toBe(1);
  });
});

describe('§14 — two relay loops never deliver the same outbox row twice', () => {
  test('SKIP LOCKED: every row delivered exactly once under concurrent drains', async () => {
    // Counts each delivery rather than asserting on a global claim total. The
    // property under test is "no row is handed to two consumers", and a global
    // count would also fail for reasons that have nothing to do with it.
    const deliveries: number[] = [];
    registerHandler('test.count', async (payload) => {
      deliveries.push((payload as { n: number }).n);
      // The handler has to take real time, or the claim window the old
      // autocommit bug lived in never opens and the test passes vacuously.
      await new Promise((r) => setTimeout(r, 5));
    });

    const N = 40;
    await sql`DELETE FROM outbox WHERE topic = 'test.count'`;
    for (let n = 0; n < N; n += 1) {
      await sql`INSERT INTO outbox (topic, payload) VALUES ('test.count', ${sql.json({ n })})`;
    }

    await Promise.all(Array.from({ length: 8 }, () => drainOnce(10)));

    const seen = new Map<number, number>();
    for (const n of deliveries) seen.set(n, (seen.get(n) ?? 0) + 1);

    const duplicated = [...seen.entries()].filter(([, c]) => c > 1);
    const missing = Array.from({ length: N }, (_, i) => i).filter((i) => !seen.has(i));

    expect(duplicated).toEqual([]);
    expect(missing).toEqual([]);
    expect(deliveries.length).toBe(N);

    const [pending] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox WHERE topic = 'test.count' AND sent_at IS NULL`;
    expect(pending?.n).toBe(0);

    await sql`DELETE FROM outbox WHERE topic = 'test.count'`;
  });

  test('concurrent drains of real payment events produce one payment each', async () => {
    const ids = Array.from({ length: 12 }, () => uid('pay_t_'));
    for (const id of ids) await ingest(createdEvent(id, T(0)));

    await Promise.all([drainOnce(), drainOnce(), drainOnce(), drainOnce()]);

    for (const id of ids) {
      expect(await countRows('payments', 'id', id)).toBe(1);
      expect(await countRows('payment_events', 'payment_id', id)).toBe(1);
    }

    const [pending] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox
      WHERE sent_at IS NULL AND NOT dead_lettered AND payload->>'payment_id' IN ${sql(ids)}`;
    expect(pending?.n).toBe(0);
  });
});

describe('the queue never blocks', () => {
  test('an unroutable topic dead-letters after 5 attempts, and never blocks the row behind it', async () => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO outbox (topic, payload)
      VALUES ('nope.unknown', ${sql.json({ payment_id: 'pay_t_dead' })})
      RETURNING id`;

    // It is retried rather than killed on sight, because another relay process
    // may be the one that handles this topic (§6.1 contemplates N relays).
    for (let i = 0; i < 4; i += 1) {
      await drainOnce();
      const [mid] = await sql<{ dead_lettered: boolean }[]>`
        SELECT dead_lettered FROM outbox WHERE id = ${row!.id}`;
      expect(mid?.dead_lettered).toBe(false);
    }

    await drainOnce();
    const [after] = await sql<{ dead_lettered: boolean; attempts: number; last_error: string }[]>`
      SELECT dead_lettered, attempts, last_error FROM outbox WHERE id = ${row!.id}`;
    expect(after?.dead_lettered).toBe(true);
    expect(after?.attempts).toBe(5);
    expect(after?.last_error).toContain('no handler');

    // And a following row still gets delivered — one poisonous message must not
    // stop every message behind it.
    const id = uid('pay_t_');
    await ingest(createdEvent(id, T(0)));
    await drainAll();
    expect(await countRows('payments', 'id', id)).toBe(1);

    await sql`DELETE FROM outbox WHERE id = ${row!.id}`;
  });
});

describe('webhook signature (§10)', () => {
  test('an unsigned request is rejected', async () => {
    const ev = createdEvent(uid('pay_t_'), T(0));
    const res = await app.fetch(
      new Request('http://localhost/webhooks/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('a tampered body is rejected — the signature covers the raw bytes', async () => {
    const ev = createdEvent(uid('pay_t_'), T(0));
    const raw = JSON.stringify(ev);
    const { sign } = await import('../src/lib/signature.ts');
    const tampered = raw.replace('124500', '999900');
    const res = await app.fetch(
      new Request('http://localhost/webhooks/gateway', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sign(raw, config.WEBHOOK_SECRET),
        },
        body: tampered,
      }),
    );
    expect(res.status).toBe(401);
  });

  test('a malformed event is a 400, not a 500', async () => {
    const raw = JSON.stringify({ event_id: 'evt_t_x', kind: 'not.a.kind' });
    const { sign } = await import('../src/lib/signature.ts');
    const res = await app.fetch(
      new Request('http://localhost/webhooks/gateway', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': sign(raw, config.WEBHOOK_SECRET),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('abandonment sweep (§7.1)', () => {
  test('ATTEMPTED and idle for 30 simulated minutes is flagged, and stays ATTEMPTED', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    await project(event(id, 'payment.attempted', T(1)));

    expect(await sweepAbandoned(new Date(Date.parse(T(20))))).toBe(0);

    const n = await sweepAbandoned(new Date(Date.parse(T(40))));
    expect(n).toBeGreaterThanOrEqual(1);

    const [p] = await sql<{ state: string; abandoned: boolean }[]>`
      SELECT state, abandoned FROM payments WHERE id = ${id}`;
    // No gateway ever reported a failure, so the state must not have moved.
    expect(p?.state).toBe('ATTEMPTED');
    expect(p?.abandoned).toBe(true);
  });

  test('a new attempt clears the abandoned flag', async () => {
    const id = uid('pay_t_');
    await project(createdEvent(id, T(0)));
    await project(event(id, 'payment.attempted', T(1)));
    await sweepAbandoned(new Date(Date.parse(T(40))));
    await project(event(id, 'payment.failed', T(50), { failure_code: 'PAYMENT_TIMEOUT' }));
    await project(event(id, 'payment.attempted', T(90)));

    const [p] = await sql<{ abandoned: boolean }[]>`
      SELECT abandoned FROM payments WHERE id = ${id}`;
    expect(p?.abandoned).toBe(false);
  });
});

describe('customer fixture sanity', () => {
  test('the test customer exists', async () => {
    expect(await countRows('customers', 'id', CUSTOMER)).toBe(1);
  });
});
