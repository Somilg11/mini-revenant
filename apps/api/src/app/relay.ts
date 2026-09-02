import { sql, type Queryable } from '../db/client.ts';
import { describeError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { OUTBOX_TOPIC_PAYMENT_EVENT, WebhookEvent } from './events.ts';
import { project } from './projector.ts';

/**
 * Outbox relay (§9, §6.1).
 *
 * Ticks every 200 ms and **claims** work rather than scanning it, using
 * `FOR UPDATE SKIP LOCKED`: the second loop passes over the rows the first has
 * locked instead of blocking on them, so N relay loops never hand the same row
 * to two consumers.
 *
 * **The claim and the delivery share one transaction, and that is the whole
 * point.** A row lock lasts as long as the transaction that took it. Claiming
 * in an autocommit statement releases the locks the instant it commits — and
 * since `sent_at` is not set until the handler acknowledges, a second relay
 * would find the row still pending and deliver it again. The window is small
 * and the resulting double-delivery is intermittent, which is the worst kind.
 * Holding the transaction open across the handler closes it.
 *
 * A row that fails five times is dead-lettered rather than retried forever.
 * **The queue never blocks:** one poisonous message must not stop every message
 * behind it, which is the failure mode that takes a payments pipeline down.
 */

const TICK_MS = 200;
const BATCH_SIZE = 50;
/** Handlers run on their own connections; keep well under the pool. */
const HANDLER_CONCURRENCY = 5;
const MAX_ATTEMPTS = 5;

export type Handler = (payload: unknown) => Promise<void>;

export interface HandlerSpec {
  handle: Handler;
  /**
   * Rows sharing a key are delivered **in order, on one lane**.
   *
   * Concurrency without this is silently wrong: a payment's `payment.created`
   * and `payment.attempted` can land on different workers, and the second can
   * win the row lock first. The lock serialises *access*, not *arrival order* —
   * so the attempt arrives at a payment that does not exist yet, and the
   * payment ends up stranded mid-lifecycle. Partitioning by payment keeps every
   * payment's events sequential while different payments still run in parallel.
   */
  partitionKey?: (payload: unknown) => string;
}

const handlers = new Map<string, HandlerSpec>([
  [
    OUTBOX_TOPIC_PAYMENT_EVENT,
    {
      handle: async (payload) => {
        const event = WebhookEvent.parse(payload);
        await project(event);
      },
      partitionKey: (payload) => String((payload as { payment_id?: string }).payment_id ?? ''),
    },
  ],
]);

export function registerHandler(topic: string, handler: Handler | HandlerSpec): void {
  handlers.set(topic, typeof handler === 'function' ? { handle: handler } : handler);
}

/** Stable, cheap, and only ever used to pick a lane. */
function laneOf(key: string, lanes: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % lanes;
}

interface OutboxRow {
  id: number;
  topic: string;
  payload: unknown;
  attempts: number;
}

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

/**
 * One pass. Exported so tests and the simulator can drive the relay
 * deterministically instead of waiting on a timer.
 */
export async function drainOnce(batchSize = BATCH_SIZE): Promise<DrainResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<OutboxRow[]>`
      SELECT id, topic, payload, attempts
      FROM outbox
      WHERE sent_at IS NULL AND NOT dead_lettered
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `;

    const result: DrainResult = { claimed: rows.length, sent: 0, failed: 0, deadLettered: 0 };

    // Handlers run concurrently on their own connections. Rows touching the
    // same payment serialise on that payment's row lock inside the projector,
    // so ordering is preserved where it matters and only where it matters.
    // The outbox updates are applied afterwards on the claim's own connection,
    // which cannot be used concurrently.
    type Outcome = { row: OutboxRow; attempt: number; error: string | null };
    const outcomes: Outcome[] = [];

    // Rows are claimed in id order, which is the order they were written, which
    // is event order. Partitioning preserves that order *within* a payment
    // while letting different payments proceed in parallel.
    const laneCount = Math.min(HANDLER_CONCURRENCY, rows.length);
    const lanes: OutboxRow[][] = Array.from({ length: laneCount }, () => []);
    for (const row of rows) {
      const spec = handlers.get(row.topic);
      const key = spec?.partitionKey?.(row.payload) ?? '';
      // Rows with no partition key carry no ordering requirement, so they are
      // spread round-robin rather than piling onto one lane.
      const lane = key === '' ? outcomes.length % laneCount : laneOf(key, laneCount);
      lanes[lane]!.push(row);
    }

    await Promise.all(
      lanes.map(async (lane) => {
        for (const row of lane) {
          const attempt = row.attempts + 1;
          const spec = handlers.get(row.topic);

          if (!spec) {
            // This process cannot route the topic — but another relay might, and
            // §6.1 explicitly contemplates N of them. Dead-lettering on the spot
            // would let one process destroy messages addressed to another, so an
            // unroutable topic counts toward MAX_ATTEMPTS like any other failure.
            outcomes.push({ row, attempt, error: `no handler for topic ${row.topic}` });
            continue;
          }
          try {
            await spec.handle(row.payload);
            outcomes.push({ row, attempt, error: null });
          } catch (err) {
            outcomes.push({ row, attempt, error: describeError(err) });
          }
        }
      }),
    );

    for (const { row, attempt, error } of outcomes) {
      if (error === null) {
        // `sent_at` is set only after the handler acknowledged.
        await tx`
          UPDATE outbox SET attempts = ${attempt}, sent_at = now(), last_error = NULL
          WHERE id = ${row.id}
        `;
        result.sent += 1;
      } else if (attempt >= MAX_ATTEMPTS) {
        await deadLetter(tx, row.id, attempt, error);
        result.deadLettered += 1;
        log.error('outbox row dead-lettered', { outboxId: row.id, topic: row.topic, attempt, error });
      } else {
        await tx`
          UPDATE outbox SET attempts = ${attempt}, last_error = ${error} WHERE id = ${row.id}
        `;
        result.failed += 1;
        log.warn('outbox handler failed, will retry', {
          outboxId: row.id,
          topic: row.topic,
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          error,
        });
      }
    }

    return result;
  });
}

async function deadLetter(
  tx: Queryable,
  id: number,
  attempt: number,
  reason: string,
): Promise<void> {
  await tx`
    UPDATE outbox SET dead_lettered = TRUE, attempts = ${attempt}, last_error = ${reason}
    WHERE id = ${id}
  `;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = false;

/**
 * Self-scheduling loop rather than `setInterval`: a slow drain must not overlap
 * itself. Overlapping drains would still be correct thanks to `SKIP LOCKED`,
 * but they would quietly multiply the connection load under exactly the
 * conditions that made the drain slow.
 *
 * A full batch means there is probably more behind it, so the next pass runs
 * immediately rather than after the poll interval. Sleeping 200 ms between
 * fixed 50-row batches caps the relay at ~250 rows/second no matter how deep
 * the backlog — a replay that outruns that never catches up.
 */
export function startRelay(tickMs = TICK_MS): void {
  stopped = false;
  let saturated = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await drainOnce();
      if (r.claimed > 0) log.debug('relay drained', { ...r });
      saturated = r.claimed >= BATCH_SIZE;
    } catch (err) {
      log.error('relay tick failed', { err });
      saturated = false;
    } finally {
      running = false;
      // Back off only when idle; drain flat out while there is a backlog.
      if (!stopped) timer = setTimeout(() => void tick(), saturated ? 0 : tickMs);
    }
  };
  timer = setTimeout(() => void tick(), tickMs);
  log.info('relay started', { tickMs, batchSize: BATCH_SIZE, maxAttempts: MAX_ATTEMPTS });
}

/** Lets the in-flight drain finish so a claimed row is not abandoned mid-handler. */
export async function stopRelay(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  const deadline = Date.now() + 3000;
  while (running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  log.debug('relay stopped');
}

/** Rows still awaiting delivery. Used to tell a replay when it is genuinely done. */
export async function pendingOutbox(): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM outbox WHERE sent_at IS NULL AND NOT dead_lettered`;
  return row?.n ?? 0;
}
