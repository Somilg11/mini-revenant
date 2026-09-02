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

/**
 * Ingests many events in one transaction.
 *
 * The guarantee is unchanged and if anything stronger: every event row and its
 * outbox row still commit together, they simply share a transaction rather than
 * taking one each. Duplicates are still rejected by `UNIQUE(event_id)`, and
 * only the events that actually inserted get an outbox row — so a redelivery
 * inside a batch cannot smuggle a second message through.
 *
 * Used by the replay runner, which pushes hundreds of events per tick and
 * cannot afford a round trip each.
 */
export async function ingestBatch(events: readonly WebhookEvent[]): Promise<IngestResult[]> {
  if (events.length === 0) return [];

  return sql.begin(async (tx) => {
    const inserted = await tx<{ event_id: string }[]>`
      INSERT INTO payment_events ${tx(
        events.map((e) => ({
          event_id: e.event_id,
          payment_id: e.payment_id,
          kind: e.kind,
          // `sql.json(...)`, not `JSON.stringify(...)`: the column is JSONB, and handing
          // it a plain string stores a JSON *string* containing JSON rather than an
          // object. `payload->>'x'` then returns NULL for every key and the relay's
          // schema parse fails with "expected object, received string".
          payload: tx.json(e.data as never),
          occurred_at: e.occurred_at,
        })),
      )}
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;

    const accepted = new Set(inserted.map((r) => r.event_id));
    const fresh = events.filter((e) => accepted.has(e.event_id));

    if (fresh.length > 0) {
      await tx`
        INSERT INTO outbox ${tx(
          fresh.map((e) => ({
            topic: OUTBOX_TOPIC_PAYMENT_EVENT,
            payload: tx.json(e as never),
          })),
        )}
      `;
    }

    const duplicates = events.length - fresh.length;
    if (duplicates > 0) log.debug('duplicate events ignored', { duplicates });

    return events.map((e) => ({
      outcome: accepted.has(e.event_id) ? ('accepted' as const) : ('duplicate' as const),
      eventId: e.event_id,
    }));
  });
}
