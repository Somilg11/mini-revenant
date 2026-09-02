import { sql, type Sql } from './client.ts';

/**
 * Every SQL statement in the application lives here (§5).
 *
 * The rule exists so that the storage layer can be read as one document: the
 * indexes in §6 are chosen for the queries below, and a query that does not
 * ride one of them is visible by inspection rather than by profiling. Domain
 * modules import none of this — they are pure functions over passed-in state.
 *
 * Grows one section per phase. P1 covers only what boot and readiness need.
 */

// ── Readiness ────────────────────────────────────────────────────────────────

export interface SchemaState {
  migrationsApplied: number;
  tableCount: number;
}

export async function schemaState(db: Sql = sql): Promise<SchemaState> {
  const [row] = await db<{ migrations: number; tables: number }[]>`
    SELECT
      (SELECT count(*)::int FROM schema_migrations)                          AS migrations,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public')      AS tables
  `;
  return {
    migrationsApplied: row?.migrations ?? 0,
    tableCount: row?.tables ?? 0,
  };
}

export interface DatasetState {
  payments: number;
  merchants: number;
  /** The seed run that produced the current data, if any (§8.1). */
  checksum: string | null;
  seed: number | null;
}

/**
 * Reported by `/ready` and by the dashboard's empty state. An unseeded database
 * is a supported state, not an error: `bun dev` must not require `bun seed`,
 * and the UI renders an empty dashboard rather than a crash or a fake number.
 */
export async function datasetState(db: Sql = sql): Promise<DatasetState> {
  const [row] = await db<
    { payments: number; merchants: number; checksum: string | null; seed: number | null }[]
  >`
    SELECT
      (SELECT count(*)::int FROM payments)  AS payments,
      (SELECT count(*)::int FROM merchants) AS merchants,
      r.checksum,
      r.seed
    FROM (SELECT 1) AS _
    LEFT JOIN LATERAL (
      SELECT checksum, seed FROM dataset_runs ORDER BY created_at DESC LIMIT 1
    ) AS r ON TRUE
  `;
  return {
    payments: row?.payments ?? 0,
    merchants: row?.merchants ?? 0,
    checksum: row?.checksum ?? null,
    seed: row?.seed ?? null,
  };
}

// ── Merchants ────────────────────────────────────────────────────────────────

export interface MerchantRow {
  id: string;
  name: string;
  is_paused: boolean;
  daily_action_budget_paise: number;
  daily_action_budget_count: number;
}

/** Backs `GET /api/v1/merchants` and the merchant switcher. */
export async function listMerchants(db: Sql = sql): Promise<MerchantRow[]> {
  return db<MerchantRow[]>`
    SELECT id, name, is_paused, daily_action_budget_paise, daily_action_budget_count
    FROM merchants
    ORDER BY name
  `;
}

// ── Metrics (§10) ────────────────────────────────────────────────────────────

export interface Window {
  from: string;
  to: string;
  merchantId?: string | undefined;
}

/** The full extent of the data, used when no window is given. */
export async function dataWindow(db: Sql = sql): Promise<{ from: string; to: string } | null> {
  const [row] = await db<{ from: string | null; to: string | null }[]>`
    SELECT min(created_at)::text AS from, max(created_at)::text AS to FROM payments`;
  if (!row?.from || !row.to) return null;
  return { from: new Date(row.from).toISOString(), to: new Date(row.to).toISOString() };
}

export interface SummaryRow {
  attempts: number;
  successes: number;
  failures: number;
  abandoned: number;
  revenue_at_risk_paise: number;
  revenue_recovered_paise: number;
}

/**
 * The metric definitions of §10, in one query.
 *
 *   revenue_at_risk   = Σ amount WHERE the payment did not succeed and is still
 *                       unresolved (never since captured), created_at ∈ window
 *   revenue_recovered = Σ amount WHERE the payment is now CAPTURED **and it was
 *                       FAILED at some earlier point**, created_at ∈ window
 *
 * The two are **mutually exclusive by construction** — that is what stops the
 * same rupee being counted twice. The "was previously failed" test reads the
 * transition history rather than the current state: a captured payment that
 * never failed is an ordinary sale, and counting it inflates the number that
 * matters most.
 *
 * A payment belongs to the window it was **created** in, not the one it settled
 * in, or it is a failure in one window and a recovery in another and the two
 * never reconcile.
 */
export async function summaryRow(w: Window, db: Sql = sql): Promise<SummaryRow> {
  const [row] = await db<SummaryRow[]>`
    SELECT
      count(*)::int AS attempts,
      count(*) FILTER (WHERE p.state = 'CAPTURED')::int AS successes,
      count(*) FILTER (WHERE p.state = 'FAILED')::int   AS failures,
      count(*) FILTER (WHERE p.abandoned)::int          AS abandoned,
      COALESCE(sum(p.amount_paise) FILTER (WHERE p.state <> 'CAPTURED'), 0)::bigint
        AS revenue_at_risk_paise,
      COALESCE(sum(p.amount_paise) FILTER (
        WHERE p.state = 'CAPTURED' AND EXISTS (
          SELECT 1 FROM payment_state_transitions t
          WHERE t.payment_id = p.id AND t.to_state = 'FAILED' AND NOT t.stale
        )
      ), 0)::bigint AS revenue_recovered_paise
    FROM payments p
    WHERE p.created_at >= ${w.from} AND p.created_at < ${w.to}
      ${w.merchantId ? db`AND p.merchant_id = ${w.merchantId}` : db``}
  `;
  return (
    row ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      abandoned: 0,
      revenue_at_risk_paise: 0,
      revenue_recovered_paise: 0,
    }
  );
}

/**
 * `recoverable_revenue` = Σ (amount × P(recovery)) over OPEN cases.
 *
 * Returns `null` when no case has ever carried a probability, because that is
 * "not measured" rather than "zero" (invariant 6). Cases arrive in P9.
 */
export async function recoverableRevenue(
  w: Window,
  db: Sql = sql,
): Promise<{ paise: number; cases: number } | null> {
  const [row] = await db<{ paise: number | null; cases: number }[]>`
    SELECT
      sum(round(c.recovery_probability * p.amount_paise))::bigint AS paise,
      count(*)::int AS cases
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    WHERE c.status = 'OPEN'
      AND c.recovery_probability IS NOT NULL
      AND p.created_at >= ${w.from} AND p.created_at < ${w.to}
      ${w.merchantId ? db`AND p.merchant_id = ${w.merchantId}` : db``}
  `;
  if (!row || row.cases === 0) return null;
  return { paise: row.paise ?? 0, cases: row.cases };
}

export interface AttributionRow {
  direct_paise: number;
  assisted_paise: number;
  organic_paise: number;
  verified: number;
}

/** Attribution is a separate question from recovery (§10). Organic credits zero. */
export async function attributionRow(w: Window, db: Sql = sql): Promise<AttributionRow> {
  const [row] = await db<AttributionRow[]>`
    SELECT
      COALESCE(sum(v.credited_amount_paise) FILTER (WHERE v.attribution = 'direct'), 0)::bigint   AS direct_paise,
      COALESCE(sum(v.credited_amount_paise) FILTER (WHERE v.attribution = 'assisted'), 0)::bigint AS assisted_paise,
      COALESCE(sum(v.credited_amount_paise) FILTER (WHERE v.attribution = 'organic'), 0)::bigint  AS organic_paise,
      count(*)::int AS verified
    FROM outcome_verifications v
    JOIN recovery_cases c ON c.id = v.case_id
    JOIN payments p ON p.id = c.payment_id
    WHERE p.created_at >= ${w.from} AND p.created_at < ${w.to}
      ${w.merchantId ? db`AND p.merchant_id = ${w.merchantId}` : db``}
  `;
  return row ?? { direct_paise: 0, assisted_paise: 0, organic_paise: 0, verified: 0 };
}

/** Which predictions came from the trained model and which from the baseline. */
export async function probabilitySourceMix(
  w: Window,
  db: Sql = sql,
): Promise<{ model: number; baseline: number }> {
  const [row] = await db<{ model: number; baseline: number }[]>`
    SELECT
      count(*) FILTER (WHERE c.probability_source = 'model')::int    AS model,
      count(*) FILTER (WHERE c.probability_source = 'baseline')::int AS baseline
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    WHERE p.created_at >= ${w.from} AND p.created_at < ${w.to}
      ${w.merchantId ? db`AND p.merchant_id = ${w.merchantId}` : db``}
  `;
  return row ?? { model: 0, baseline: 0 };
}

export interface AcceptanceRow {
  segment: 'domestic' | 'international';
  attempts: number;
  successes: number;
  gross_amount_paise: number;
  captured_amount_paise: number;
}

/**
 * Domestic vs international acceptance, side by side (§1.1).
 *
 * The first thing on screen after the money, because it is the line no merchant
 * dashboard shows them today — and the whole wedge of the product.
 */
export async function acceptanceRows(w: Window, db: Sql = sql): Promise<AcceptanceRow[]> {
  return db<AcceptanceRow[]>`
    SELECT
      CASE WHEN p.is_international THEN 'international' ELSE 'domestic' END AS segment,
      count(*)::int AS attempts,
      count(*) FILTER (WHERE p.state = 'CAPTURED')::int AS successes,
      COALESCE(sum(p.amount_paise), 0)::bigint AS gross_amount_paise,
      COALESCE(sum(p.amount_paise) FILTER (WHERE p.state = 'CAPTURED'), 0)::bigint AS captured_amount_paise
    FROM payments p
    WHERE p.created_at >= ${w.from} AND p.created_at < ${w.to}
      ${w.merchantId ? db`AND p.merchant_id = ${w.merchantId}` : db``}
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface SeriesPoint {
  bucket_start: string;
  attempts: number;
  successes: number;
  failures: number;
  abandoned: number;
  gross_amount_paise: number;
  failed_amount_paise: number;
}

/**
 * Timeseries from the rollups, not from `payments` — this is the read path the
 * rollups exist for, and the one the detector will ride in P7.
 */
export async function timeseries(
  w: Window,
  granularity: 'hour' | '5m',
  dimension: string,
  dimensionValue: string,
  db: Sql = sql,
): Promise<SeriesPoint[]> {
  const seconds = granularity === 'hour' ? 3600 : 300;
  return db<SeriesPoint[]>`
    SELECT
      to_timestamp(floor(extract(epoch FROM r.bucket_start) / ${seconds}) * ${seconds})::text
        AS bucket_start,
      sum(r.attempts)::int  AS attempts,
      sum(r.successes)::int AS successes,
      sum(r.failures)::int  AS failures,
      sum(r.abandoned)::int AS abandoned,
      COALESCE(sum(r.gross_amount_paise), 0)::bigint  AS gross_amount_paise,
      COALESCE(sum(r.failed_amount_paise), 0)::bigint AS failed_amount_paise
    FROM metrics_rollup r
    WHERE r.dimension = ${dimension} AND r.dimension_value = ${dimensionValue}
      AND r.bucket_start >= ${w.from} AND r.bucket_start < ${w.to}
      ${w.merchantId ? db`AND r.merchant_id = ${w.merchantId}` : db``}
    GROUP BY 1
    ORDER BY 1
  `;
}

export interface BreakdownRow {
  dimension_value: string;
  attempts: number;
  successes: number;
  failures: number;
  abandoned: number;
  gross_amount_paise: number;
  failed_amount_paise: number;
}

export async function breakdown(
  w: Window,
  dimension: string,
  db: Sql = sql,
): Promise<BreakdownRow[]> {
  return db<BreakdownRow[]>`
    SELECT
      r.dimension_value,
      sum(r.attempts)::int  AS attempts,
      sum(r.successes)::int AS successes,
      sum(r.failures)::int  AS failures,
      sum(r.abandoned)::int AS abandoned,
      COALESCE(sum(r.gross_amount_paise), 0)::bigint  AS gross_amount_paise,
      COALESCE(sum(r.failed_amount_paise), 0)::bigint AS failed_amount_paise
    FROM metrics_rollup r
    WHERE r.dimension = ${dimension}
      AND r.bucket_start >= ${w.from} AND r.bucket_start < ${w.to}
      ${w.merchantId ? db`AND r.merchant_id = ${w.merchantId}` : db``}
    GROUP BY 1
    ORDER BY sum(r.attempts) DESC
  `;
}
