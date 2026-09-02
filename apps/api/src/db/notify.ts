import { sql, type Queryable } from './client.ts';
import { log } from '../lib/logger.ts';

/**
 * `LISTEN` / `NOTIFY revenant_events` (§6.1).
 *
 * Notifications are emitted **inside the transaction that writes**, never after
 * it. Postgres delivers them only on commit, so the dashboard sees an event
 * exactly when it becomes true — nothing appears on screen that a rollback
 * later un-happens, and there is no polling loop.
 *
 * One dedicated connection listens and fans out to every SSE subscriber. It is
 * dedicated rather than pooled because a listener holds its connection for the
 * lifetime of the process: borrowing from the pool would permanently shrink it
 * by one and eventually starve the relay.
 */
export const CHANNEL = 'revenant_events';

/** Payload kinds the dashboard subscribes to (§10). */
export type EventTopic =
  | 'payment'
  | 'incident.opened'
  | 'incident.resolved'
  | 'case.opened'
  | 'policy.decided'
  | 'action.executed'
  | 'outcome.verified'
  | 'metrics.tick';

/**
 * `pg_notify` caps a payload at 8000 bytes. Keep these small — they are a
 * nudge to the dashboard, not a data transfer. The dashboard re-reads what it
 * needs over REST.
 */
const MAX_PAYLOAD_BYTES = 7000;

export async function notify(
  tx: Queryable,
  topic: EventTopic,
  data: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({ topic, data });
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    // Dropping the detail is better than aborting the write it rides along with.
    await tx`SELECT pg_notify(${CHANNEL}, ${JSON.stringify({ topic, data: {} })})`;
    return;
  }
  await tx`SELECT pg_notify(${CHANNEL}, ${body})`;
}

// ── Listener and fan-out ─────────────────────────────────────────────────────

export interface RevenantEvent {
  topic: EventTopic;
  data: Record<string, unknown>;
}

type Subscriber = (event: RevenantEvent) => void;

const subscribers = new Set<Subscriber>();
let listening: { unlisten: () => Promise<void> } | null = null;

/** Returns an unsubscribe function. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function subscriberCount(): number {
  return subscribers.size;
}

/**
 * Starts the single `LISTEN` connection.
 *
 * postgres.js reconnects `listen` automatically and calls `onlisten` again, so
 * a database restart mid-demo re-establishes the stream rather than silently
 * going quiet — which would look exactly like "nothing is happening".
 */
export async function startListener(): Promise<void> {
  if (listening) return;
  listening = await sql.listen(
    CHANNEL,
    (payload: string) => {
      let event: RevenantEvent;
      try {
        event = JSON.parse(payload) as RevenantEvent;
      } catch {
        log.warn('unparseable notification payload dropped');
        return;
      }
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (err) {
          // One broken subscriber must not stop the others.
          log.warn('sse subscriber threw', { err });
        }
      }
    },
    () => log.info('listening for database notifications', { channel: CHANNEL }),
  );
}

export async function stopListener(): Promise<void> {
  if (!listening) return;
  try {
    await listening.unlisten();
  } catch (err) {
    log.warn('unlisten failed', { err });
  }
  listening = null;
  subscribers.clear();
}
