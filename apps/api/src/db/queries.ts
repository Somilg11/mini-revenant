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
      cu.opted_out
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
      cu.opted_out
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
