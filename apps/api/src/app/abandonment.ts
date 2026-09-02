import { sql } from '../db/client.ts';
import { ABANDONMENT_IDLE_MINUTES } from '../domain/payment-state.ts';
import { log } from '../lib/logger.ts';

/**
 * Abandonment sweep (§7.1, §9).
 *
 * A payment left in `ATTEMPTED` with no failure event and no activity for 30
 * simulated minutes is abandoned. It **stays `ATTEMPTED`** — no gateway ever
 * reported a failure, and inventing a FAILED state would put a failure code on
 * a payment that never got one — and is flagged instead.
 *
 * `now` is passed in rather than read from the clock: the sweep runs on
 * simulated time (1 real second = 30 simulated minutes), so a wall clock here
 * would mean the sweep never fires during a 3-minute demo.
 */
export async function sweepAbandoned(
  now: Date,
  idleMinutes: number = ABANDONMENT_IDLE_MINUTES,
): Promise<number> {
  const cutoff = new Date(now.getTime() - idleMinutes * 60_000).toISOString();

  const rows = await sql<{ id: string }[]>`
    UPDATE payments
    SET abandoned = TRUE, version = version + 1
    WHERE state = 'ATTEMPTED'
      AND NOT abandoned
      AND last_event_at < ${cutoff}
    RETURNING id
  `;

  if (rows.length > 0) {
    log.info('abandonment sweep', { abandoned: rows.length, cutoff, idleMinutes });
  }
  return rows.length;
}
