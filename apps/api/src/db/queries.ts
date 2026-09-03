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

// ── Detection (§7.3) ─────────────────────────────────────────────────────────

export interface SliceKey {
  dimension: string;
  dimensionValue: string;
}

/**
 * The slices carrying enough traffic to be worth evaluating.
 *
 * Summed across merchants: injected incidents are infrastructure-wide (§8.2),
 * and scoping detection per tenant divides the affected traffic by the merchant
 * count and produces "incidents" of four payments.
 */
export async function activeSlices(
  from: string,
  to: string,
  minAttempts: number,
  db: Sql = sql,
): Promise<SliceKey[]> {
  const rows = await db<{ dimension: string; dimension_value: string }[]>`
    SELECT r.dimension, r.dimension_value
    FROM metrics_rollup r
    WHERE r.bucket_start >= ${from} AND r.bucket_start < ${to}
    GROUP BY 1, 2
    HAVING sum(r.attempts) >= ${minAttempts}
  `;
  return rows.map((r) => ({ dimension: r.dimension, dimensionValue: r.dimension_value }));
}

export interface SeriesBucket {
  start: string;
  attempts: number;
  failures: number;
}

/**
 * A dense 5-minute series for one slice.
 *
 * `generate_series` fills the gaps: a bucket with no traffic must appear as
 * zero rather than be missing, or the detector's window silently spans a longer
 * period than it thinks and the sustained-ness gate reads the wrong buckets.
 */
export async function sliceSeries(
  slice: SliceKey,
  from: string,
  to: string,
  db: Sql = sql,
): Promise<SeriesBucket[]> {
  return db<SeriesBucket[]>`
    SELECT
      g.bucket::text AS start,
      COALESCE(sum(r.attempts), 0)::int AS attempts,
      COALESCE(sum(r.failures) + sum(r.abandoned), 0)::int AS failures
    FROM generate_series(
      ${from}::timestamptz, ${to}::timestamptz - interval '5 minutes', interval '5 minutes'
    ) AS g(bucket)
    LEFT JOIN metrics_rollup r
      ON r.bucket_start = g.bucket
     AND r.dimension = ${slice.dimension}
     AND r.dimension_value = ${slice.dimensionValue}
    GROUP BY g.bucket
    ORDER BY g.bucket
  `;
}

export interface IncidentRow {
  id: string;
  merchant_id: string | null;
  status: 'OPEN' | 'RESOLVED';
  dimension: string;
  dimension_value: string;
  opened_at: string;
  resolved_at: string | null;
  baseline_rate: number;
  current_rate: number;
  z_score: number;
  gates: unknown;
  affected_payments: number;
  revenue_at_risk_paise: number;
  root_cause: unknown;
  narrative: string | null;
  narrative_source: string | null;
}

export async function openIncidents(db: Sql = sql): Promise<IncidentRow[]> {
  return db<IncidentRow[]>`
    SELECT * FROM incidents WHERE status = 'OPEN' ORDER BY opened_at DESC`;
}

export async function listIncidents(
  status: 'OPEN' | 'RESOLVED' | 'ALL',
  limit: number,
  db: Sql = sql,
): Promise<IncidentRow[]> {
  return db<IncidentRow[]>`
    SELECT * FROM incidents
    ${status === 'ALL' ? db`` : db`WHERE status = ${status}`}
    ORDER BY opened_at DESC
    LIMIT ${limit}`;
}

export async function getIncident(id: string, db: Sql = sql): Promise<IncidentRow | null> {
  const [row] = await db<IncidentRow[]>`SELECT * FROM incidents WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Payments in a slice during a window — what the incident is costing.
 *
 * The dimension is matched by an explicit CASE rather than dynamic SQL, so no
 * caller can steer this at a column.
 */
export async function sliceExposure(
  slice: SliceKey,
  from: string,
  to: string,
  db: Sql = sql,
): Promise<{ affected: number; failed: number; atRiskPaise: number }> {
  const [row] = await db<{ affected: number; failed: number; at_risk: number }[]>`
    SELECT
      count(*)::int AS affected,
      count(*) FILTER (WHERE p.state <> 'CAPTURED')::int AS failed,
      COALESCE(sum(p.amount_paise) FILTER (WHERE p.state <> 'CAPTURED'), 0)::bigint AS at_risk
    FROM payments p
    WHERE p.created_at >= ${from} AND p.created_at < ${to}
      AND CASE ${slice.dimension}
            WHEN 'all'              THEN TRUE
            WHEN 'method'           THEN p.method::text = ${slice.dimensionValue}
            WHEN 'bank'             THEN COALESCE(p.bank, 'none') = ${slice.dimensionValue}
            WHEN 'is_international' THEN (CASE WHEN p.is_international THEN 'true' ELSE 'false' END) = ${slice.dimensionValue}
            WHEN 'card_network'     THEN COALESCE(p.card_network, 'none') = ${slice.dimensionValue}
            WHEN 'card_country'     THEN COALESCE(p.card_country, 'none') = ${slice.dimensionValue}
            WHEN 'amount_band'      THEN (CASE
                WHEN p.amount_paise >= 5000000 THEN '>50k'
                WHEN p.amount_paise >= 1000000 THEN '10k-50k'
                WHEN p.amount_paise >=  200000 THEN '2k-10k'
                WHEN p.amount_paise >=   50000 THEN '500-2k'
                ELSE '<500' END) = ${slice.dimensionValue}
            ELSE FALSE
          END
  `;
  return {
    affected: row?.affected ?? 0,
    failed: row?.failed ?? 0,
    atRiskPaise: row?.at_risk ?? 0,
  };
}

export interface GroundTruthIncidentRow {
  id: string;
  kind: string;
  started_at: string;
  ended_at: string;
  dimensions: Record<string, string>;
  affected_payments: number;
  detected_incident_id: string | null;
}

export async function groundTruthIncidents(db: Sql = sql): Promise<GroundTruthIncidentRow[]> {
  return db<GroundTruthIncidentRow[]>`
    SELECT id, kind, started_at::text, ended_at::text, dimensions, affected_payments,
           detected_incident_id
    FROM ground_truth_incidents ORDER BY started_at`;
}

// ── Root cause analysis (§7.4) ───────────────────────────────────────────────

export interface RcaRow {
  failed: boolean;
  bank: string | null;
  method: string;
  amount_band: string;
  is_international: string;
  card_network: string | null;
  card_country: string | null;
  failure_code: string | null;
}

/**
 * Raw payment rows for RCA.
 *
 * RCA works on 1-to-3 dimension **tuples**, which the single-dimension rollups
 * cannot answer — a rollup knows `method=card` and `is_international=true`
 * separately but never their intersection. It runs once per incident rather
 * than once per bucket, so reading the underlying rows is affordable and it is
 * the only way to reach the tuple the demo turns on.
 */
export async function rcaObservations(
  from: string,
  to: string,
  db: Sql = sql,
): Promise<RcaRow[]> {
  return db<RcaRow[]>`
    SELECT
      (p.state <> 'CAPTURED') AS failed,
      p.bank,
      p.method::text AS method,
      CASE
        WHEN p.amount_paise >= 5000000 THEN '>50k'
        WHEN p.amount_paise >= 1000000 THEN '10k-50k'
        WHEN p.amount_paise >=  200000 THEN '2k-10k'
        WHEN p.amount_paise >=   50000 THEN '500-2k'
        ELSE '<500' END AS amount_band,
      CASE WHEN p.is_international THEN 'true' ELSE 'false' END AS is_international,
      p.card_network,
      p.card_country,
      -- An abandoned payment carries no gateway code, but "the customer left"
      -- is exactly the kind of cause RCA exists to name.
      COALESCE(p.failure_code, CASE WHEN p.abandoned THEN 'CHECKOUT_ABANDONED' END) AS failure_code
    FROM payments p
    WHERE p.created_at >= ${from} AND p.created_at < ${to}
  `;
}

// ── Recovery cases (§7.5) ────────────────────────────────────────────────────

export interface RecoveryCandidate {
  id: string;
  merchant_id: string;
  customer_id: string;
  amount_paise: number;
  method: string;
  bank: string | null;
  card_network: string | null;
  failure_code: string | null;
  abandoned: boolean;
  attempt_index: number;
  created_at: string;
  last_event_at: string;
  is_international: boolean;
  customer_prior_attempts: number;
  customer_prior_successes: number;
  merchant_prior_attempts: number;
  merchant_prior_successes: number;
  seconds_since_last_attempt: number;
  incident_active: boolean;
  opted_out: boolean;
  lifetime_value_paise: number;
}

/**
 * Unresolved failures with no live case, and everything needed to score them.
 *
 * The features are computed in one pass rather than a query per payment: at
 * 6,770 unresolved payments a round trip each would take minutes, and the
 * recovery worklist is meant to keep up with a live replay.
 *
 * `customer_prior_*` counts only payments created **before** this one — a
 * feature that could see the future would make every training metric look
 * excellent and the model useless.
 */
export async function recoveryCandidates(
  now: string,
  limit: number,
  db: Sql = sql,
): Promise<RecoveryCandidate[]> {
  return db<RecoveryCandidate[]>`
    WITH candidate AS (
      SELECT p.*
      FROM payments p
      WHERE (p.state = 'FAILED' OR (p.state = 'ATTEMPTED' AND p.abandoned))
        AND p.created_at < ${now}
        AND NOT EXISTS (
          SELECT 1 FROM recovery_cases c
          WHERE c.payment_id = p.id AND c.status IN ('OPEN', 'ACTING')
        )
        AND NOT EXISTS (
          SELECT 1 FROM recovery_cases c WHERE c.payment_id = p.id
        )
      ORDER BY p.created_at
      LIMIT ${limit}
    )
    SELECT
      c.id, c.merchant_id, c.customer_id, c.amount_paise,
      c.method::text AS method, c.bank, c.card_network, c.failure_code,
      c.abandoned, c.attempt_index, c.created_at::text, c.last_event_at::text,
      c.is_international,
      COALESCE(cust.attempts, 0)::int  AS customer_prior_attempts,
      COALESCE(cust.successes, 0)::int AS customer_prior_successes,
      COALESCE(merch.attempts, 0)::int  AS merchant_prior_attempts,
      COALESCE(merch.successes, 0)::int AS merchant_prior_successes,
      COALESCE(
        EXTRACT(EPOCH FROM (c.created_at - prev.last_created))::int,
        -1
      ) AS seconds_since_last_attempt,
      EXISTS (
        -- Only incidents the DETECTOR opened, never the answer key (§7.5).
        -- "Active" means active *when the payment failed*: an incident that has
        -- since resolved still counts, or a case opened late (at the end of a
        -- replay) would be scored as if the outage had never happened.
        SELECT 1 FROM incidents i
        WHERE i.opened_at <= c.created_at
          AND (i.status = 'OPEN' OR i.resolved_at >= c.created_at)
          AND (
            (i.dimension = 'all')
            OR (i.dimension = 'method' AND i.dimension_value = c.method::text)
            OR (i.dimension = 'bank' AND i.dimension_value = COALESCE(c.bank, 'none'))
            OR (i.dimension = 'is_international'
                AND i.dimension_value = CASE WHEN c.is_international THEN 'true' ELSE 'false' END)
            OR (i.dimension = 'card_network' AND i.dimension_value = COALESCE(c.card_network, 'none'))
          )
      ) AS incident_active,
      cu.opted_out,
      cu.lifetime_value_paise
    FROM candidate c
    JOIN customers cu ON cu.id = c.customer_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p2.state = 'CAPTURED')::int AS successes
      FROM payments p2
      WHERE p2.customer_id = c.customer_id AND p2.created_at < c.created_at
    ) cust ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p3.state = 'CAPTURED')::int AS successes
      FROM payments p3
      WHERE p3.merchant_id = c.merchant_id AND p3.created_at < c.created_at
    ) merch ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(p4.created_at) AS last_created
      FROM payments p4
      WHERE p4.customer_id = c.customer_id AND p4.created_at < c.created_at
    ) prev ON TRUE
  `;
}

export interface CaseRow {
  id: string;
  payment_id: string;
  merchant_id: string;
  incident_id: string | null;
  status: string;
  recovery_probability: number | null;
  probability_source: string | null;
  chosen_strategy: string | null;
  strategy_options: unknown;
  expected_value_paise: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface CaseListRow extends CaseRow {
  amount_paise: number;
  method: string;
  failure_code: string | null;
  is_international: boolean;
  card_network: string | null;
  payment_state: string;
  abandoned: boolean;
}

export async function listCases(
  status: string | null,
  limit: number,
  db: Sql = sql,
): Promise<CaseListRow[]> {
  return db<CaseListRow[]>`
    SELECT c.*, p.amount_paise, p.method::text AS method, p.failure_code,
           p.is_international, p.card_network, p.state::text AS payment_state, p.abandoned
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    ${status ? db`WHERE c.status = ${status}` : db``}
    ORDER BY c.opened_at DESC
    LIMIT ${limit}`;
}

export async function getCase(id: string, db: Sql = sql): Promise<CaseListRow | null> {
  const [row] = await db<CaseListRow[]>`
    SELECT c.*, p.amount_paise, p.method::text AS method, p.failure_code,
           p.is_international, p.card_network, p.state::text AS payment_state, p.abandoned
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    WHERE c.id = ${id}`;
  return row ?? null;
}

export interface CaseStats {
  open: number;
  total: number;
  model: number;
  baseline: number;
  expected_recoverable_paise: number;
}

export async function caseStats(db: Sql = sql): Promise<CaseStats> {
  const [row] = await db<CaseStats[]>`
    SELECT
      count(*) FILTER (WHERE c.status = 'OPEN')::int AS open,
      count(*)::int AS total,
      count(*) FILTER (WHERE c.probability_source = 'model')::int    AS model,
      count(*) FILTER (WHERE c.probability_source = 'baseline')::int AS baseline,
      COALESCE(sum(round(c.recovery_probability * p.amount_paise))
        FILTER (WHERE c.status = 'OPEN'), 0)::bigint AS expected_recoverable_paise
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id`;
  return row ?? { open: 0, total: 0, model: 0, baseline: 0, expected_recoverable_paise: 0 };
}

/** The active trained model, if one has been activated (P10). */
export async function activeModelRow(
  db: Sql = sql,
): Promise<{ id: string; coefficients: unknown; calibration: unknown } | null> {
  const [row] = await db<{ id: string; coefficients: unknown; calibration: unknown }[]>`
    SELECT id, coefficients, calibration FROM model_versions WHERE is_active LIMIT 1`;
  return row ?? null;
}

/**
 * The scoring features for one existing payment.
 *
 * Shares its shape with `recoveryCandidates` so the odds shown on a case detail
 * page are computed from the same inputs the case was opened with, rather than
 * from a reconstruction that might drift from it.
 */
export async function candidateForPayment(
  paymentId: string,
  db: Sql = sql,
): Promise<RecoveryCandidate | null> {
  const [row] = await db<RecoveryCandidate[]>`
    SELECT
      p.id, p.merchant_id, p.customer_id, p.amount_paise,
      p.method::text AS method, p.bank, p.card_network, p.failure_code,
      p.abandoned, p.attempt_index, p.created_at::text, p.last_event_at::text,
      p.is_international,
      COALESCE(cust.attempts, 0)::int  AS customer_prior_attempts,
      COALESCE(cust.successes, 0)::int AS customer_prior_successes,
      COALESCE(merch.attempts, 0)::int  AS merchant_prior_attempts,
      COALESCE(merch.successes, 0)::int AS merchant_prior_successes,
      COALESCE(EXTRACT(EPOCH FROM (p.created_at - prev.last_created))::int, -1)
        AS seconds_since_last_attempt,
      EXISTS (
        SELECT 1 FROM incidents i
        WHERE i.opened_at <= p.created_at
          AND (i.status = 'OPEN' OR i.resolved_at >= p.created_at)
          AND (
            (i.dimension = 'all')
            OR (i.dimension = 'method' AND i.dimension_value = p.method::text)
            OR (i.dimension = 'bank' AND i.dimension_value = COALESCE(p.bank, 'none'))
            OR (i.dimension = 'is_international'
                AND i.dimension_value = CASE WHEN p.is_international THEN 'true' ELSE 'false' END)
            OR (i.dimension = 'card_network' AND i.dimension_value = COALESCE(p.card_network, 'none'))
          )
      ) AS incident_active,
      cu.opted_out,
      cu.lifetime_value_paise
    FROM payments p
    JOIN customers cu ON cu.id = p.customer_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p2.state = 'CAPTURED')::int AS successes
      FROM payments p2 WHERE p2.customer_id = p.customer_id AND p2.created_at < p.created_at
    ) cust ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p3.state = 'CAPTURED')::int AS successes
      FROM payments p3 WHERE p3.merchant_id = p.merchant_id AND p3.created_at < p.created_at
    ) merch ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(p4.created_at) AS last_created
      FROM payments p4 WHERE p4.customer_id = p.customer_id AND p4.created_at < p.created_at
    ) prev ON TRUE
    WHERE p.id = ${paymentId}`;
  return row ?? null;
}

// ── Training (§7.5) ──────────────────────────────────────────────────────────

export interface TrainingRow extends RecoveryCandidate {
  recoverable: boolean;
  split: 'train' | 'val' | 'test';
}

/**
 * Every labelled payment with the features it would have been scored with.
 *
 * Same shape as the worklist so `featuresOf` applies unchanged — the one
 * encoding pipeline again. Ordered by creation because the split is
 * chronological: the generator assigned `split` by position, and reading rows
 * in that order makes the boundary visible on the model card.
 */
export async function trainingRows(db: Sql = sql): Promise<TrainingRow[]> {
  return db<TrainingRow[]>`
    SELECT
      p.id, p.merchant_id, p.customer_id, p.amount_paise,
      p.method::text AS method, p.bank, p.card_network, p.failure_code,
      p.abandoned, p.attempt_index, p.created_at::text, p.last_event_at::text,
      p.is_international,
      COALESCE(cust.attempts, 0)::int  AS customer_prior_attempts,
      COALESCE(cust.successes, 0)::int AS customer_prior_successes,
      COALESCE(merch.attempts, 0)::int  AS merchant_prior_attempts,
      COALESCE(merch.successes, 0)::int AS merchant_prior_successes,
      COALESCE(EXTRACT(EPOCH FROM (p.created_at - prev.last_created))::int, -1)
        AS seconds_since_last_attempt,
      EXISTS (
        SELECT 1 FROM incidents i
        WHERE i.opened_at <= p.created_at
          AND (i.status = 'OPEN' OR i.resolved_at >= p.created_at)
          AND (
            (i.dimension = 'all')
            OR (i.dimension = 'method' AND i.dimension_value = p.method::text)
            OR (i.dimension = 'bank' AND i.dimension_value = COALESCE(p.bank, 'none'))
            OR (i.dimension = 'is_international'
                AND i.dimension_value = CASE WHEN p.is_international THEN 'true' ELSE 'false' END)
            OR (i.dimension = 'card_network' AND i.dimension_value = COALESCE(p.card_network, 'none'))
          )
      ) AS incident_active,
      cu.opted_out,
      cu.lifetime_value_paise,
      l.recoverable,
      l.split
    FROM ground_truth_labels l
    JOIN payments p ON p.id = l.payment_id
    JOIN customers cu ON cu.id = p.customer_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p2.state = 'CAPTURED')::int AS successes
      FROM payments p2 WHERE p2.customer_id = p.customer_id AND p2.created_at < p.created_at
    ) cust ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE p3.state = 'CAPTURED')::int AS successes
      FROM payments p3 WHERE p3.merchant_id = p.merchant_id AND p3.created_at < p.created_at
    ) merch ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(p4.created_at) AS last_created
      FROM payments p4 WHERE p4.customer_id = p.customer_id AND p4.created_at < p.created_at
    ) prev ON TRUE
    ORDER BY p.created_at, p.id`;
}

export interface ModelVersionRow {
  id: string;
  kind: string;
  coefficients: unknown;
  calibration: unknown;
  metrics: unknown;
  trained_at: string;
  is_active: boolean;
}

export async function listModelVersions(db: Sql = sql): Promise<ModelVersionRow[]> {
  return db<ModelVersionRow[]>`
    SELECT id, kind, coefficients, calibration, metrics, trained_at::text, is_active
    FROM model_versions ORDER BY trained_at DESC LIMIT 20`;
}

export async function activeModelVersion(db: Sql = sql): Promise<ModelVersionRow | null> {
  const [row] = await db<ModelVersionRow[]>`
    SELECT id, kind, coefficients, calibration, metrics, trained_at::text, is_active
    FROM model_versions WHERE is_active LIMIT 1`;
  return row ?? null;
}

// ── Policy (§7.7) ────────────────────────────────────────────────────────────

export interface MerchantPolicyRow {
  id: string;
  is_paused: boolean;
  daily_action_budget_paise: number;
  daily_action_budget_count: number;
}

export async function merchantForPolicy(id: string, db: Sql = sql): Promise<MerchantPolicyRow | null> {
  const [row] = await db<MerchantPolicyRow[]>`
    SELECT id, is_paused, daily_action_budget_paise, daily_action_budget_count FROM merchants WHERE id = ${id}`;
  return row ?? null;
}

/**
 * The merchant's activity today and this hour, from persisted actions. "Today"
 * and "this hour" are in **simulated** time, because that is the clock the
 * budget is spent against.
 */
export async function merchantActivity(
  merchantId: string,
  now: string,
  db: Sql = sql,
): Promise<{ todayCount: number; todaySpendPaise: number; hourExposurePaise: number }> {
  const [row] = await db<{ today_count: number; today_spend: number; hour_exposure: number }[]>`
    SELECT
      count(*) FILTER (WHERE a.created_at >= date_trunc('day', ${now}::timestamptz))::int AS today_count,
      COALESCE(sum(a.cost_paise) FILTER (WHERE a.created_at >= date_trunc('day', ${now}::timestamptz)), 0)::bigint AS today_spend,
      COALESCE(sum(p.amount_paise) FILTER (WHERE a.created_at >= date_trunc('hour', ${now}::timestamptz)), 0)::bigint AS hour_exposure
    FROM recovery_actions a
    JOIN recovery_cases c ON c.id = a.case_id
    JOIN payments p ON p.id = c.payment_id
    WHERE c.merchant_id = ${merchantId}
      AND a.created_at < ${now}::timestamptz + interval '1 second'
      AND a.status <> 'FAILED'`;
  return {
    todayCount: row?.today_count ?? 0,
    todaySpendPaise: row?.today_spend ?? 0,
    hourExposurePaise: row?.hour_exposure ?? 0,
  };
}

export async function lastActionOnPayment(paymentId: string, db: Sql = sql): Promise<string | null> {
  const [row] = await db<{ at: string | null }[]>`
    SELECT max(a.created_at)::text AS at
    FROM recovery_actions a JOIN recovery_cases c ON c.id = a.case_id
    WHERE c.payment_id = ${paymentId}`;
  return row?.at ? new Date(row.at).toISOString() : null;
}

/**
 * Cases the strategy engine chose to act on that the gate has not settled: no
 * decision at all, or only *deferred* DENYs (capacity rules 6–9) whose latest
 * is at least an hour old in simulated time — the blast radius is hourly, so
 * an hour is the soonest a deferred case can possibly clear.
 */
export interface GateCandidate {
  case_id: string;
  payment_id: string;
  merchant_id: string;
  chosen_strategy: string;
  expected_value_paise: number;
  strategy_options: { strategy: string; costPaise: number }[];
  payment_state: string;
  amount_paise: number;
  attempt_index: number;
  failure_code: string | null;
  abandoned: boolean;
  method: string;
  bank: string | null;
  is_international: boolean;
  card_network: string | null;
  opted_out: boolean;
}

export const DEFERRAL_INTERVAL = '1 hour';

export async function gateCandidates(limit: number, now: string, db: Sql = sql): Promise<GateCandidate[]> {
  return db<GateCandidate[]>`
    SELECT c.id AS case_id, c.payment_id, c.merchant_id, c.chosen_strategy, c.expected_value_paise,
           c.strategy_options,
           p.state::text AS payment_state, p.amount_paise, p.attempt_index, p.failure_code,
           p.abandoned, p.method::text AS method, p.bank, p.is_international, p.card_network,
           cu.opted_out
    FROM recovery_cases c
    JOIN payments p ON p.id = c.payment_id
    JOIN customers cu ON cu.id = p.customer_id
    WHERE c.status = 'OPEN'
      AND c.chosen_strategy IS NOT NULL
      AND c.chosen_strategy <> 'do_nothing'
      AND NOT EXISTS (
        SELECT 1 FROM policy_decisions d
        WHERE d.case_id = c.id
          AND (NOT (d.reasons ? 'deferred')
               OR d.decided_at > ${now}::timestamptz - ${DEFERRAL_INTERVAL}::interval))
    ORDER BY c.opened_at
    LIMIT ${limit}`;
}

export async function openIncidentOnPayment(
  p: { method: string; bank: string | null; is_international: boolean; card_network: string | null },
  db: Sql = sql,
): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM incidents i
    WHERE i.status = 'OPEN' AND (
      i.dimension = 'all'
      OR (i.dimension = 'method' AND i.dimension_value = ${p.method})
      OR (i.dimension = 'bank' AND i.dimension_value = ${p.bank ?? 'none'})
      OR (i.dimension = 'is_international' AND i.dimension_value = ${p.is_international ? 'true' : 'false'})
      OR (i.dimension = 'card_network' AND i.dimension_value = ${p.card_network ?? 'none'})
    )`;
  return (row?.n ?? 0) > 0;
}

export interface PolicyDecisionRow {
  id: string;
  case_id: string;
  proposed_action: string;
  verdict: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
  reasons: unknown;
  policy_version: string;
  input_hash: string;
  decided_at: string;
  payment_id: string;
  amount_paise: number;
  chosen_strategy: string | null;
}

export async function listPolicyDecisions(limit: number, db: Sql = sql): Promise<PolicyDecisionRow[]> {
  return db<PolicyDecisionRow[]>`
    SELECT d.*, c.payment_id, p.amount_paise, c.chosen_strategy
    FROM policy_decisions d
    JOIN recovery_cases c ON c.id = d.case_id
    JOIN payments p ON p.id = c.payment_id
    ORDER BY d.decided_at DESC, d.id DESC LIMIT ${limit}`;
}

export async function policyDecisionCounts(db: Sql = sql): Promise<Record<string, number>> {
  const rows = await db<{ verdict: string; n: number }[]>`
    SELECT verdict, count(*)::int AS n FROM policy_decisions GROUP BY 1`;
  return Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
}

export async function decisionsForCase(caseId: string, db: Sql = sql): Promise<PolicyDecisionRow[]> {
  return db<PolicyDecisionRow[]>`
    SELECT d.*, c.payment_id, p.amount_paise, c.chosen_strategy
    FROM policy_decisions d
    JOIN recovery_cases c ON c.id = d.case_id
    JOIN payments p ON p.id = c.payment_id
    WHERE d.case_id = ${caseId}
    ORDER BY d.decided_at, d.id`;
}

/** The kill switch (§7.7 rule 1). Read by the policy engine on every decision. */
export async function setMerchantPaused(id: string, paused: boolean, db: Sql = sql): Promise<MerchantRow | null> {
  const [row] = await db<MerchantRow[]>`
    UPDATE merchants SET is_paused = ${paused} WHERE id = ${id}
    RETURNING id, name, is_paused, daily_action_budget_paise, daily_action_budget_count`;
  return row ?? null;
}

// ── Executor and gateway (§8.6, §9) ──────────────────────────────────────────

export interface GatewayInstrumentRow {
  method: string;
  card_network: string | null;
  failure_code: string | null;
  amount_paise: number;
}

/** What the simulated gateway needs to know about a payment to answer for it. */
export async function gatewayInstrument(paymentId: string, db: Sql = sql): Promise<GatewayInstrumentRow | null> {
  const [row] = await db<GatewayInstrumentRow[]>`
    SELECT method::text AS method, card_network, failure_code, amount_paise FROM payments WHERE id = ${paymentId}`;
  return row ?? null;
}

export interface GroundTruthLabelRow {
  recoverable_by_retry: boolean;
  recoverable_by_link: boolean;
  recoverable_by_alternate: boolean;
  recoverable_by_gateway: boolean;
  recoverable: boolean;
}

export async function groundTruthLabel(paymentId: string, db: Sql = sql): Promise<GroundTruthLabelRow | null> {
  const [row] = await db<GroundTruthLabelRow[]>`
    SELECT recoverable_by_retry, recoverable_by_link, recoverable_by_alternate, recoverable_by_gateway, recoverable
    FROM ground_truth_labels WHERE payment_id = ${paymentId}`;
  return row ?? null;
}

export type ActionStatus = 'RESERVED' | 'SENT' | 'SUCCEEDED' | 'FAILED' | 'ESCALATED';

export interface ActionRow {
  id: string;
  case_id: string;
  policy_decision_id: string;
  kind: string;
  idempotency_key: string;
  status: ActionStatus;
  attempts: number;
  cost_paise: number;
  gateway_reference: string | null;
  error_class: 'RETRYABLE' | 'TERMINAL' | 'NEEDS_HUMAN' | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * Reserves the idempotency key **before** the gateway call. The UNIQUE
 * constraint is the guard: a second reservation for the same key inserts
 * nothing and returns the row that got there first, so the caller learns it
 * is a replay without a read-then-write race.
 */
export async function reserveAction(
  a: { id: string; caseId: string; decisionId: string; kind: string; idempotencyKey: string; costPaise: number; now: string },
  db: Sql = sql,
): Promise<{ row: ActionRow; fresh: boolean }> {
  return db.begin(async (tx) => {
    const [inserted] = await tx<ActionRow[]>`
      INSERT INTO recovery_actions
        (id, case_id, policy_decision_id, kind, idempotency_key, status, attempts, cost_paise, created_at)
      VALUES (${a.id}, ${a.caseId}, ${a.decisionId}, ${a.kind}, ${a.idempotencyKey}, 'RESERVED', 0, ${a.costPaise}, ${a.now})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *`;
    if (inserted) {
      await tx`UPDATE recovery_cases SET status = 'ACTING' WHERE id = ${a.caseId} AND status = 'OPEN'`;
      return { row: inserted, fresh: true };
    }
    const [existing] = await tx<ActionRow[]>`SELECT * FROM recovery_actions WHERE idempotency_key = ${a.idempotencyKey}`;
    if (!existing) throw new Error(`idempotency key ${a.idempotencyKey} neither inserted nor found`);
    return { row: existing, fresh: false };
  }) as Promise<{ row: ActionRow; fresh: boolean }>;
}

export async function markActionSent(id: string, attempts: number, db: Sql = sql): Promise<void> {
  await db`UPDATE recovery_actions SET status = 'SENT', attempts = ${attempts} WHERE id = ${id}`;
}

export async function completeAction(
  id: string,
  outcome: {
    status: 'SUCCEEDED' | 'FAILED' | 'ESCALATED';
    attempts: number;
    gatewayReference: string | null;
    errorClass: 'RETRYABLE' | 'TERMINAL' | 'NEEDS_HUMAN' | null;
    completedAt: string;
  },
  db: Sql = sql,
): Promise<ActionRow> {
  const [row] = await db<ActionRow[]>`
    UPDATE recovery_actions SET
      status = ${outcome.status}, attempts = ${outcome.attempts},
      gateway_reference = ${outcome.gatewayReference}, error_class = ${outcome.errorClass},
      completed_at = ${outcome.completedAt}
    WHERE id = ${id}
    RETURNING *`;
  if (!row) throw new Error(`action ${id} vanished while completing`);
  return row;
}

export async function actionsForCase(caseId: string, db: Sql = sql): Promise<ActionRow[]> {
  return db<ActionRow[]>`SELECT * FROM recovery_actions WHERE case_id = ${caseId} ORDER BY created_at, id`;
}

export interface PendingExecutionRow {
  decision_id: string;
  case_id: string;
  reasons: unknown;
  policy_version: string;
  input_hash: string;
}

/**
 * Approved decisions the executor has not acted on: ALLOW verdicts — the
 * gate's own and a human's — whose case is still OPEN and which have no action
 * row. Crash between decision and action, and the next tick picks it up.
 */
export async function pendingExecutions(limit: number, db: Sql = sql): Promise<PendingExecutionRow[]> {
  return db<PendingExecutionRow[]>`
    SELECT d.id AS decision_id, d.case_id, d.reasons, d.policy_version, d.input_hash
    FROM policy_decisions d
    JOIN recovery_cases c ON c.id = d.case_id
    WHERE d.verdict = 'ALLOW'
      AND c.status = 'OPEN'
      AND NOT EXISTS (SELECT 1 FROM recovery_actions a WHERE a.policy_decision_id = d.id)
    ORDER BY d.decided_at, d.id
    LIMIT ${limit}`;
}

export interface ActionStats {
  total: number;
  succeeded: number;
  failed: number;
  escalated: number;
  in_flight: number;
  retried: number;
  cost_paise: number;
}

export async function actionStats(db: Sql = sql): Promise<ActionStats> {
  const [row] = await db<ActionStats[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE status = 'ESCALATED')::int AS escalated,
      count(*) FILTER (WHERE status IN ('RESERVED', 'SENT'))::int AS in_flight,
      count(*) FILTER (WHERE attempts > 1)::int AS retried,
      COALESCE(sum(cost_paise) FILTER (WHERE status = 'SUCCEEDED'), 0)::bigint AS cost_paise
    FROM recovery_actions`;
  return row ?? { total: 0, succeeded: 0, failed: 0, escalated: 0, in_flight: 0, retried: 0, cost_paise: 0 };
}
