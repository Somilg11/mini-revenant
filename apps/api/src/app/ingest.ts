import { sql } from '../db/client.ts';
import { log } from '../lib/logger.ts';
import { OUTBOX_TOPIC_PAYMENT_EVENT, type WebhookEvent } from './events.ts';

/**
 * Ingest — the transactional outbox (§9).
 *
 * The event row and the outbox row are written in **one transaction**, then the
 * handler returns 200 with nothing else done synchronously. That single
 * property is what the outbox buys over a message broker here: a message cannot
 * exist without its event, and an event cannot exist without its message.
 * Matching that with RabbitMQ needs two-phase commit.
 *
 * Duplicate delivery is handled by `UNIQUE(event_id)` — invariant 2, idempotency
 * by constraint, never by an `if (exists)` check. The read-then-write version of
 * this is a race that somebody eventually loses under concurrent redelivery.
 */

export type IngestOutcome = 'accepted' | 'duplicate';

export interface IngestResult {
  outcome: IngestOutcome;
  eventId: string;
}

export async function ingest(event: WebhookEvent): Promise<IngestResult> {
  return sql.begin(async (tx) => {
    const inserted = await tx<{ event_id: string }[]>`
      INSERT INTO payment_events (event_id, payment_id, kind, payload, occurred_at)
      VALUES (
        ${event.event_id}, ${event.payment_id}, ${event.kind},
        ${tx.json(event.data as never)}, ${event.occurred_at}
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    // No row returned means the unique index rejected it: a redelivery. Writing
    // an outbox row here would hand the projector the same event twice, so the
    // duplicate stops at this line.
    if (inserted.length === 0) {
      log.debug('duplicate event ignored', { eventId: event.event_id, kind: event.kind });
      return { outcome: 'duplicate' as const, eventId: event.event_id };
    }

    await tx`
      INSERT INTO outbox (topic, payload)
      VALUES (${OUTBOX_TOPIC_PAYMENT_EVENT}, ${tx.json(event as never)})
    `;

    return { outcome: 'accepted' as const, eventId: event.event_id };
  });
}
