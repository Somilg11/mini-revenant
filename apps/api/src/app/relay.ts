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
const MAX_ATTEMPTS = 5;

export type Handler = (payload: unknown) => Promise<void>;

const handlers = new Map<string, Handler>([
  [
    OUTBOX_TOPIC_PAYMENT_EVENT,
    async (payload) => {
      const event = WebhookEvent.parse(payload);
      await project(event);
    },
  ],
]);

export function registerHandler(topic: string, handler: Handler): void {
  handlers.set(topic, handler);
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

    for (const row of rows) {
      const attempt = row.attempts + 1;
      const handler = handlers.get(row.topic);

      if (!handler) {
        // This process cannot route the topic — but another relay might, and
        // §6.1 explicitly contemplates N of them. Dead-lettering on the spot
        // would let one process destroy messages addressed to another, so an
        // unroutable topic counts toward MAX_ATTEMPTS like any other failure.
        // A genuinely unhandled topic still dies, just after five tries rather
        // than instantly, and the queue still never blocks.
        const reason = `no handler for topic ${row.topic}`;
        if (attempt >= MAX_ATTEMPTS) {
          await deadLetter(tx, row.id, attempt, reason);
          result.deadLettered += 1;
          log.error('outbox row dead-lettered', { outboxId: row.id, topic: row.topic, attempt });
        } else {
          await tx`
            UPDATE outbox SET attempts = ${attempt}, last_error = ${reason} WHERE id = ${row.id}
          `;
          result.failed += 1;
        }
        continue;
      }

      try {
        // The handler runs on its own connection and commits independently.
        // That is deliberate: `processed_events` is what makes the effect
        // happen once, so the delivery does not need to be atomic with it.
        await handler(row.payload);
        await tx`
          UPDATE outbox SET attempts = ${attempt}, sent_at = now(), last_error = NULL
          WHERE id = ${row.id}
        `;
        result.sent += 1;
      } catch (err) {
        const message = describeError(err);
        if (attempt >= MAX_ATTEMPTS) {
          await deadLetter(tx, row.id, attempt, message);
          result.deadLettered += 1;
          log.error('outbox row dead-lettered', { outboxId: row.id, topic: row.topic, attempt, err });
        } else {
          await tx`
            UPDATE outbox SET attempts = ${attempt}, last_error = ${message} WHERE id = ${row.id}
          `;
          result.failed += 1;
          log.warn('outbox handler failed, will retry', {
            outboxId: row.id,
            topic: row.topic,
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            err,
          });
        }
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
 */
export function startRelay(tickMs = TICK_MS): void {
  stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await drainOnce();
      if (r.claimed > 0) log.debug('relay drained', { ...r });
    } catch (err) {
      log.error('relay tick failed', { err });
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), tickMs);
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
