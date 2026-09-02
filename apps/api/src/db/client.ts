import postgres from 'postgres';
import { config } from '../config.ts';
import { describeError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';

/**
 * One pool for the whole process.
 *
 * `LISTEN` will get its own dedicated connection (db/notify.ts, P6) rather than
 * borrowing from here — a listener holds its connection for the lifetime of the
 * process, so running it through the pool would permanently shrink the pool by
 * one and eventually deadlock a busy relay.
 */
export const sql = postgres(config.DATABASE_URL, {
  max: config.PGPOOL_MAX,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 60 * 30,
  prepare: true,

  // Money is BIGINT paise. At this scale every amount is far inside the safe
  // integer range, so parsing to `number` keeps invariant 5 (integer paise, no
  // float arithmetic on amounts) workable in ordinary TypeScript. The guard is
  // the point: if a value ever exceeds 2^53 the parse throws instead of
  // silently rounding, because a silently rounded amount is a money bug.
  types: {
    bigint: {
      to: 20,
      from: [20],
      serialize: (v: number) => String(v),
      parse: (v: string) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) {
          throw new Error(`bigint ${v} exceeds safe integer range — refusing to round`);
        }
        return n;
      },
    },
  },

  // Notices are not errors, but swallowing them entirely hides things like
  // "index already exists, skipping" during a migration.
  onnotice: (notice) => log.debug('postgres notice', { severity: notice.severity, message: notice.message }),
});

export type Sql = typeof sql;

/**
 * Anything that can run a query: the pool, or a transaction handle from
 * `sql.begin()`. Helpers take this so the same function works inside and
 * outside a transaction — which matters because §6.1 requires several writes
 * (the NOTIFY, the outbox update) to ride *inside* the transaction that makes
 * them true, not alongside it.
 */
export type Queryable = Sql | postgres.TransactionSql<{ bigint: number }>;

export interface PingResult {
  up: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Liveness probe for the database. Returns the failure reason rather than a
 * bare boolean — "not ready" without a cause is the least useful thing a
 * readiness endpoint can say.
 */
export async function ping(): Promise<PingResult> {
  const startedAt = performance.now();
  try {
    await sql`SELECT 1`;
    return { up: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (err) {
    log.warn('database ping failed', { err });
    return {
      up: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: describeError(err),
    };
  }
}

let closed = false;

/** Idempotent: the shutdown handler and a CLI's `finally` may both call it. */
export async function closeDb(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    await sql.end({ timeout: 5 });
    log.debug('database pool closed');
  } catch (err) {
    log.warn('database pool did not close cleanly', { err });
  }
}
