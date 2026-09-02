import type { Queryable } from './client.ts';

/**
 * `NOTIFY revenant_events` (§6.1).
 *
 * Emitted **inside the transaction that writes**, never after it. Postgres
 * delivers notifications only on commit, so the dashboard sees an event exactly
 * when it becomes true — nothing appears on screen that a rollback later
 * un-happens, and there is no polling loop.
 *
 * The listener side lands in P6 with SSE. This is the write half.
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
