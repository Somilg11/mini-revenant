import { sql, type Queryable } from '../db/client.ts';
import { amountBand } from '../domain/money.ts';
import { ValidationError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';

/**
 * Rollups, recompute and drift (§9, §10).
 *
 * Rollups are maintained **incrementally** — in the same transaction as the
 * projection that caused them — *and* recomputed by a sweep. Any difference is
 * **drift**: logged and surfaced on the dashboard, never silently corrected.
 * A rollup that repairs itself hides the bug that caused it, and on a money
 * dashboard that bug is a wrong number somebody has already acted on.
 */

export const BUCKET_MINUTES = 5;

/** The dimensions every payment is counted under (§10 breakdown, §7.3 detector). */
export type RollupDimension =
  | 'all'
  | 'method'
  | 'bank'
  | 'amount_band'
  | 'is_international'
  | 'card_network'
  | 'card_country';

export interface RollupSubject {
  merchantId: string;
  createdAt: string;
  amountPaise: number;
  method: string;
  bank: string | null;
  isInternational: boolean;
  cardNetwork: string | null;
  cardCountry: string | null;
}

/** Floor to the 5-minute UTC bucket. Window membership is decided by `created_at`. */
export function bucketOf(iso: string): string {
  const ms = Date.parse(iso);
  const size = BUCKET_MINUTES * 60_000;
  return new Date(Math.floor(ms / size) * size).toISOString();
}

/**
 * `is_international` is a first-class dimension, not a flag (§1.1) — the
 * centrepiece incident is only visible when the detector runs on this series
 * rather than on the aggregate.
 */
export function dimensionsOf(p: RollupSubject): [RollupDimension, string][] {
  return [
    ['all', 'all'],
    ['method', p.method],
    ['bank', p.bank ?? 'none'],
    ['amount_band', amountBand(p.amountPaise)],
    ['is_international', p.isInternational ? 'true' : 'false'],
    ['card_network', p.cardNetwork ?? 'none'],
    ['card_country', p.cardCountry ?? 'none'],
  ];
}

export interface RollupDelta {
  attempts?: number;
  successes?: number;
  failures?: number;
  abandoned?: number;
  grossAmountPaise?: number;
  capturedAmountPaise?: number;
}

/**
 * Applies a delta to every dimension of one payment, in the caller's
 * transaction.
 *
 * `failed_amount_paise` is derived as `gross − captured` rather than tracked
 * separately: two counters that must agree are two counters that eventually do
 * not, and this one has a closed-form answer.
 */
export async function applyRollupDelta(
  tx: Queryable,
  p: RollupSubject,
  delta: RollupDelta,
): Promise<void> {
  const bucket = bucketOf(p.createdAt);
  const d = {
    attempts: delta.attempts ?? 0,
    successes: delta.successes ?? 0,
    failures: delta.failures ?? 0,
    abandoned: delta.abandoned ?? 0,
    gross: delta.grossAmountPaise ?? 0,
    captured: delta.capturedAmountPaise ?? 0,
  };
  if (Object.values(d).every((v) => v === 0)) return;

  for (const [dimension, value] of dimensionsOf(p)) {
    await tx`
      INSERT INTO metrics_rollup (
        merchant_id, bucket_start, dimension, dimension_value,
        attempts, successes, failures, abandoned,
        gross_amount_paise, captured_amount_paise, failed_amount_paise
      ) VALUES (
        ${p.merchantId}, ${bucket}, ${dimension}, ${value},
        ${d.attempts}, ${d.successes}, ${d.failures}, ${d.abandoned},
        ${d.gross}, ${d.captured}, ${d.gross - d.captured}
      )
      ON CONFLICT (merchant_id, bucket_start, dimension, dimension_value) DO UPDATE SET
        attempts              = metrics_rollup.attempts + EXCLUDED.attempts,
        successes             = metrics_rollup.successes + EXCLUDED.successes,
        failures              = metrics_rollup.failures + EXCLUDED.failures,
        abandoned             = metrics_rollup.abandoned + EXCLUDED.abandoned,
        gross_amount_paise    = metrics_rollup.gross_amount_paise + EXCLUDED.gross_amount_paise,
        captured_amount_paise = metrics_rollup.captured_amount_paise + EXCLUDED.captured_amount_paise,
        failed_amount_paise   =
          (metrics_rollup.gross_amount_paise + EXCLUDED.gross_amount_paise)
          - (metrics_rollup.captured_amount_paise + EXCLUDED.captured_amount_paise)
    `;
  }
}

// ── Recompute and drift ──────────────────────────────────────────────────────

/**
 * The dimension expressions, written once. The recompute and the incremental
 * path must agree on what a slice *is*, or the drift they are compared on is
 * measuring the definition rather than the bug.
 */
const DIMENSION_SQL: Record<RollupDimension, string> = {
  all: `'all'`,
  method: `p.method::text`,
  bank: `COALESCE(p.bank, 'none')`,
  amount_band: `CASE
      WHEN p.amount_paise >= 5000000 THEN '>50k'
      WHEN p.amount_paise >= 1000000 THEN '10k-50k'
      WHEN p.amount_paise >=  200000 THEN '2k-10k'
      WHEN p.amount_paise >=   50000 THEN '500-2k'
      ELSE '<500' END`,
  is_international: `CASE WHEN p.is_international THEN 'true' ELSE 'false' END`,
  card_network: `COALESCE(p.card_network, 'none')`,
  card_country: `COALESCE(p.card_country, 'none')`,
};

export interface RecomputeResult {
  rows: number;
  ms: number;
}

/**
 * Rebuilds every rollup row from `payments`, which is itself derived from
 * `payment_events` (invariant 1). Truth is always recomputable.
 */
export async function recomputeRollups(): Promise<RecomputeResult> {
  const startedAt = performance.now();

  const selects = (Object.keys(DIMENSION_SQL) as RollupDimension[]).map(
    (dim) => `
      SELECT
        p.merchant_id,
        to_timestamp(floor(extract(epoch FROM p.created_at) / ${BUCKET_MINUTES * 60})
          * ${BUCKET_MINUTES * 60}) AS bucket_start,
        '${dim}'::text AS dimension,
        ${DIMENSION_SQL[dim]} AS dimension_value,
        count(*)::int AS attempts,
        count(*) FILTER (WHERE p.state = 'CAPTURED')::int AS successes,
        count(*) FILTER (WHERE p.state = 'FAILED')::int AS failures,
        count(*) FILTER (WHERE p.abandoned)::int AS abandoned,
        COALESCE(sum(p.amount_paise), 0)::bigint AS gross_amount_paise,
        COALESCE(sum(p.amount_paise) FILTER (WHERE p.state = 'CAPTURED'), 0)::bigint AS captured_amount_paise,
        COALESCE(sum(p.amount_paise) FILTER (WHERE p.state <> 'CAPTURED'), 0)::bigint AS failed_amount_paise
      FROM payments p
      GROUP BY 1, 2, 3, 4`,
  );

  // DELETE then INSERT as two statements in one transaction — **not** as a
  // data-modifying CTE. Every CTE in a statement sees the same snapshot and
  // they are not ordered relative to one another, so an `INSERT` alongside a
  // `DELETE` collides with the very rows the delete is removing:
  //   duplicate key value violates unique constraint "metrics_rollup_pkey"
  const rows = await sql.begin(async (tx) => {
    await tx`DELETE FROM metrics_rollup`;
    return tx.unsafe<{ n: number }[]>(`
      INSERT INTO metrics_rollup
        (merchant_id, bucket_start, dimension, dimension_value, attempts, successes,
         failures, abandoned, gross_amount_paise, captured_amount_paise, failed_amount_paise)
      ${selects.join('\nUNION ALL\n')}
      RETURNING 1 AS n
    `);
  });

  const ms = Math.round(performance.now() - startedAt);
  invalidateDriftCache();
  log.info('rollups recomputed', { rows: rows.length, ms });
  return { rows: rows.length, ms };
}

export interface Drift {
  /** Rows where the stored rollup disagrees with a fresh computation. */
  rows: number;
  attempts: number;
  successes: number;
  failures: number;
  abandoned: number;
  grossAmountPaise: number;
  capturedAmountPaise: number;
  checkedAt: string;
}

/**
 * Compares the stored (incrementally maintained) rollups against a fresh
 * computation **without writing anything**. Displayed, not corrected (§10).
 */
export async function measureDrift(opts: { from?: string } = {}): Promise<Drift> {
  // `from` is interpolated into raw SQL below, because the fragment is built by
  // string concatenation across a UNION ALL. Normalise it to a fixed-format ISO
  // timestamp first: an unparseable value throws here rather than reaching the
  // database, and the output can contain no quote to break out of.
  let fromIso: string | null = null;
  if (opts.from !== undefined) {
    const ms = Date.parse(opts.from);
    if (Number.isNaN(ms)) throw new ValidationError('measureDrift: invalid `from`', { from: opts.from });
    fromIso = new Date(ms).toISOString();
  }

  const selects = (Object.keys(DIMENSION_SQL) as RollupDimension[]).map(
    (dim) => `
      SELECT
        p.merchant_id,
        to_timestamp(floor(extract(epoch FROM p.created_at) / ${BUCKET_MINUTES * 60})
          * ${BUCKET_MINUTES * 60}) AS bucket_start,
        '${dim}'::text AS dimension,
        ${DIMENSION_SQL[dim]} AS dimension_value,
        count(*)::int AS attempts,
        count(*) FILTER (WHERE p.state = 'CAPTURED')::int AS successes,
        count(*) FILTER (WHERE p.state = 'FAILED')::int AS failures,
        count(*) FILTER (WHERE p.abandoned)::int AS abandoned,
        COALESCE(sum(p.amount_paise), 0)::bigint AS gross_amount_paise,
        COALESCE(sum(p.amount_paise) FILTER (WHERE p.state = 'CAPTURED'), 0)::bigint
          AS captured_amount_paise
      FROM payments p
      ${fromIso ? `WHERE p.created_at >= '${fromIso}'` : ''}
      GROUP BY 1, 2, 3, 4`,
  );

  const bucketFilter = fromIso
    ? `AND COALESCE(r.bucket_start, c.bucket_start) >= '${fromIso}'`
    : '';

  const [row] = await sql.unsafe<
    {
      rows: number;
      attempts: number;
      successes: number;
      failures: number;
      abandoned: number;
      gross: number;
      captured: number;
    }[]
  >(`
    WITH computed AS (${selects.join('\nUNION ALL\n')})
    SELECT
      count(*)::int AS rows,
      COALESCE(sum(abs(COALESCE(r.attempts, 0)  - c.attempts)), 0)::int  AS attempts,
      COALESCE(sum(abs(COALESCE(r.successes, 0) - c.successes)), 0)::int AS successes,
      COALESCE(sum(abs(COALESCE(r.failures, 0)  - c.failures)), 0)::int  AS failures,
      COALESCE(sum(abs(COALESCE(r.abandoned, 0)  - c.abandoned)), 0)::int AS abandoned,
      COALESCE(sum(abs(COALESCE(r.gross_amount_paise, 0) - c.gross_amount_paise)), 0)::bigint AS gross,
      COALESCE(sum(abs(COALESCE(r.captured_amount_paise, 0) - c.captured_amount_paise)), 0)::bigint
        AS captured
    FROM computed c
    FULL OUTER JOIN metrics_rollup r
      ON r.merchant_id = c.merchant_id
     AND r.bucket_start = c.bucket_start
     AND r.dimension = c.dimension
     AND r.dimension_value = c.dimension_value
    WHERE TRUE ${bucketFilter}
      AND (COALESCE(r.attempts, 0)  <> c.attempts
       OR COALESCE(r.successes, 0) <> c.successes
       OR COALESCE(r.failures, 0)  <> c.failures
       OR COALESCE(r.abandoned, 0) <> c.abandoned
       OR COALESCE(r.gross_amount_paise, 0) <> c.gross_amount_paise
       OR COALESCE(r.captured_amount_paise, 0) <> c.captured_amount_paise)
  `);

  const drift: Drift = {
    rows: row?.rows ?? 0,
    attempts: row?.attempts ?? 0,
    successes: row?.successes ?? 0,
    failures: row?.failures ?? 0,
    abandoned: row?.abandoned ?? 0,
    grossAmountPaise: row?.gross ?? 0,
    capturedAmountPaise: row?.captured ?? 0,
    checkedAt: new Date().toISOString(),
  };

  if (drift.rows > 0) {
    // Surfaced, never repaired here. The repair is `recomputeRollups()`, and
    // it is a deliberate act rather than a side effect of noticing.
    log.warn('rollup drift detected', { ...drift });
  }
  return drift;
}

/**
 * Cached drift, for the dashboard.
 *
 * `measureDrift` scans every payment across seven dimensions — about 750 ms on
 * the seeded dataset — and the Command Center asks for it on every render. An
 * endpoint that expensive on an unauthenticated read path is a denial of
 * service anyone can trigger by holding down refresh, so the read path serves a
 * recent answer and says how old it is. Drift changes on the timescale of a
 * bug, not of a request.
 */
const DRIFT_TTL_MS = 15_000;
let cached: { at: number; drift: Drift } | null = null;
let inFlight: Promise<Drift> | null = null;

export async function cachedDrift(): Promise<Drift & { cached: boolean; age_ms: number }> {
  const now = Date.now();
  if (cached && now - cached.at < DRIFT_TTL_MS) {
    return { ...cached.drift, cached: true, age_ms: now - cached.at };
  }
  // Concurrent callers share one scan rather than starting several.
  inFlight ??= measureDrift()
    .then((d) => {
      cached = { at: Date.now(), drift: d };
      return d;
    })
    .finally(() => {
      inFlight = null;
    });
  const drift = await inFlight;
  return { ...drift, cached: false, age_ms: 0 };
}

/** Drops the cache after a deliberate repair, so the next read is honest. */
export function invalidateDriftCache(): void {
  cached = null;
}
