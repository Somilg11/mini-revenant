const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

/** Requests never hang the render — an unreachable API must fail fast and visibly. */
const DEFAULT_TIMEOUT_MS = 8000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'timeout' | 'http',
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
  requestId?: string;
}

/**
 * Typed fetch client.
 *
 * Distinguishes the three failures that mean different things to whoever is
 * looking at the screen: the API is not running, the API is too slow, and the
 * API answered with an error. "Something went wrong" for all three is how a
 * demo stalls on stage with nothing to go on.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      ...init,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ApiError(`${path} timed out after ${DEFAULT_TIMEOUT_MS}ms`, 'timeout');
    }
    throw new ApiError(`cannot reach the API at ${BASE} — is it running?`, 'unreachable');
  }

  const requestId = res.headers.get('X-Request-Id') ?? undefined;

  if (!res.ok) {
    let message = `${path} returned ${res.status}`;
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body.error?.message) message = body.error.message;
    } catch {
      // Body was not JSON. The status line is all we have, and it is enough.
    }
    throw new ApiError(message, 'http', res.status, requestId);
  }

  return res.json() as Promise<T>;
}

/**
 * `/ready` answers 503 when the database is down, which is information rather
 * than a failure — the page should render that state, not an error boundary.
 */
export async function fetchReady(): Promise<Ready | { unavailable: string }> {
  try {
    return await api<Ready>('/ready');
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'http' && err.status === 503) {
      try {
        const res = await fetch(`${BASE}/ready`, { cache: 'no-store' });
        return (await res.json()) as Ready;
      } catch {
        // Fall through to the message below.
      }
    }
    return { unavailable: err instanceof Error ? err.message : 'unknown error' };
  }
}

export interface Ready {
  ready: boolean;
  error?: string;
  checks: {
    database: { up: boolean; latency_ms: number; error?: string };
    migrations: { applied: number; tables: number } | null;
    dataset: {
      payments: number;
      merchants: number;
      seeded: boolean;
      checksum: string | null;
      seed: number | null;
    } | null;
    llm: { enabled: boolean; provider: string; model: string | null; reason?: string };
  };
}

// ── Metrics (§10) ────────────────────────────────────────────────────────────

export interface MetricWindow {
  from: string;
  to: string;
  merchant_id: string | null;
}

export interface Summary {
  window: MetricWindow | null;
  revenue_at_risk_paise: number;
  revenue_recovered_paise: number;
  /** null with `recoverable_estimated: false` until a model has scored a case. */
  recoverable_revenue_paise: number | null;
  recoverable_estimated: boolean;
  recoverable_open_cases: number;
  recovery_rate: number | null;
  recovery_rate_inputs: { numerator_paise: number; denominator_paise: number };
  counts: { attempts: number; successes: number; failures: number; abandoned: number };
  failure_rate: number | null;
  failure_rate_inputs: { numerator: number; denominator: number };
  attribution: {
    direct_paise: number;
    assisted_paise: number;
    organic_paise: number;
    verified: number;
    attributed: boolean;
  };
  probability_source_mix: { model: number; baseline: number };
}

export interface AcceptanceSegment {
  segment: 'domestic' | 'international';
  attempts: number;
  successes: number;
  acceptance_rate: number | null;
  gross_amount_paise: number;
  captured_amount_paise: number;
}

export interface Acceptance {
  window: MetricWindow | null;
  segments: AcceptanceSegment[];
  gap: { points: number; value_paise: number } | null;
}

export interface Drift {
  rows: number;
  attempts: number;
  successes: number;
  failures: number;
  grossAmountPaise: number;
  checkedAt: string;
}

export interface BreakdownRow {
  dimension_value: string;
  attempts: number;
  successes: number;
  failures: number;
  abandoned: number;
  gross_amount_paise: number;
  failed_amount_paise: number;
  failure_rate: number | null;
  acceptance_rate: number | null;
}

export interface Breakdown {
  window: MetricWindow | null;
  dimension: string;
  rows: BreakdownRow[];
}

/**
 * Fetches everything the Command Center needs, tolerating a dead API.
 *
 * One failed panel must not blank the page: a dashboard that shows nothing
 * because one query timed out is less useful than one that shows what it has
 * and says what it could not get.
 */
export async function fetchDashboard(): Promise<{
  ready: Ready | null;
  summary: Summary | null;
  acceptance: Acceptance | null;
  drift: Drift | null;
  breakdown: Breakdown | null;
  error: string | null;
}> {
  const [ready, summary, acceptance, drift, breakdown] = await Promise.all([
    api<Ready>('/ready').catch(() => null),
    api<Summary>('/api/v1/metrics/summary').catch(() => null),
    api<Acceptance>('/api/v1/metrics/acceptance').catch(() => null),
    api<Drift>('/api/v1/metrics/drift').catch(() => null),
    api<Breakdown>('/api/v1/metrics/breakdown?dimension=method').catch(() => null),
  ]);

  const error =
    summary === null && acceptance === null
      ? `cannot reach the API at ${BASE} — is it running? (bun dev)`
      : null;

  return { ready, summary, acceptance, drift, breakdown, error };
}

// ── Incidents (§11.2) ────────────────────────────────────────────────────────

export interface Gate {
  gate: string;
  passed: boolean;
  value: number;
  threshold: number;
  detail: string;
}

export interface RootCause {
  hypotheses: import('@/components/HypothesisCard').Hypothesis[];
  incident_excess: number;
  window_attempts: number;
  window_failures: number;
  pooled_rate: number;
  used_window_as_reference: boolean;
  window: { from: string; to: string };
  baseline: { from: string; to: string };
}

export interface Incident {
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
  gates: Gate[];
  affected_payments: number;
  revenue_at_risk_paise: number;
  root_cause: RootCause | null;
  narrative: string | null;
  narrative_source: 'llm' | 'template' | null;
}

export interface DetectionMatch {
  groundTruthId: string;
  kind: string;
  startedAt: string;
  endedAt: string;
  dimensions: Record<string, string>;
  affectedPayments: number;
  detected: boolean;
  onCorrectDimension: boolean;
  detectedDimension: string | null;
  corroboratingDetections: number;
  allDimensions: string[];
  missReason: string | null;
}

export interface RcaResult {
  kind: string;
  labelled: Record<string, string>;
  incidentId: string | null;
  top1: string | null;
  top1Confidence: number | null;
  top1ExcessShare: number | null;
  top1Correct: boolean;
  top3: string[];
  top3Correct: boolean;
}

export interface Evaluation {
  rca: {
    scored: number;
    top1_correct: number;
    top3_correct: number;
    top1_accuracy: number | null;
    results: RcaResult[];
  } | null;
  detection: {
    precision: number | null;
    recall: number | null;
    true_positives: number;
    false_positives: number;
    false_negatives: number;
    incidents_opened: number;
    matches: DetectionMatch[];
    unmatched: { id: string; dimension: string; dimensionValue: string; openedAt: string }[];
  };
  noise_windows: {
    clean: boolean;
    windows: { startedAt: string; endedAt: string; firedIncidents: number }[];
  };
}

export const fetchIncidents = (status = 'ALL') =>
  api<{ incidents: Incident[] }>(`/api/v1/incidents?status=${status}`).catch(() => ({ incidents: [] }));

export const fetchIncident = (id: string) =>
  api<{ incident: Incident }>(`/api/v1/incidents/${id}`);

export const fetchEvaluation = () =>
  api<Evaluation>('/api/v1/evaluation').catch((): Evaluation | null => null);

export interface IncidentSeries {
  incident_id: string;
  dimension: string;
  dimension_value: string;
  baseline_rate: number;
  opened_at: string;
  resolved_at: string | null;
  points: { start: string; attempts: number; failures: number; failure_rate: number | null }[];
}

export const fetchIncidentSeries = (id: string) =>
  api<IncidentSeries>(`/api/v1/incidents/${id}/timeseries`).catch((): IncidentSeries | null => null);

// ── Recovery cases (§11.2) ───────────────────────────────────────────────────

export interface RecoveryCase {
  id: string;
  payment_id: string;
  merchant_id: string;
  incident_id: string | null;
  status: 'OPEN' | 'ACTING' | 'RECOVERED' | 'LOST' | 'ABANDONED_BY_POLICY';
  recovery_probability: number | null;
  probability_source: 'model' | 'baseline' | null;
  chosen_strategy: string | null;
  strategy_options: unknown;
  expected_value_paise: number | null;
  opened_at: string;
  closed_at: string | null;
  amount_paise: number;
  method: string;
  failure_code: string | null;
  is_international: boolean;
  card_network: string | null;
  payment_state: string;
  abandoned: boolean;
}

export interface CaseList {
  cases: RecoveryCase[];
  stats: {
    open: number;
    total: number;
    expected_recoverable_paise: number;
    probability_source_mix: { model: number; baseline: number };
    actions: ActionStats;
  };
}

export interface StrategyOdds {
  retry: number;
  payment_link: number;
  alternate_method: number;
  alternate_gateway: number;
}

export interface CaseDetail {
  case: RecoveryCase;
  features: Record<string, unknown> | null;
  odds: StrategyOdds | null;
  decision: {
    chosen: string;
    customer_multiplier: number;
    options: import('@/components/StrategyComparison').StrategyOption[];
  } | null;
  decided_at_open: unknown;
  policy: {
    id: string;
    verdict: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';
    proposed_action: string;
    policy_version: string;
    input_hash: string;
    decided_at: string;
    reasons: { rules?: import('@/components/PolicyRuleList').RuleResult[]; human_approval?: unknown; deferred?: boolean };
  }[];
  actions: RecoveryAction[];
}

export interface RecoveryAction {
  id: string;
  case_id: string;
  policy_decision_id: string;
  kind: string;
  idempotency_key: string;
  status: 'RESERVED' | 'SENT' | 'SUCCEEDED' | 'FAILED' | 'ESCALATED';
  attempts: number;
  cost_paise: number;
  gateway_reference: string | null;
  error_class: 'RETRYABLE' | 'TERMINAL' | 'NEEDS_HUMAN' | null;
  created_at: string;
  completed_at: string | null;
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

export const fetchCases = (status?: string, limit = 100) =>
  api<CaseList>(`/api/v1/cases?limit=${limit}${status ? `&status=${status}` : ''}`).catch(
    (): CaseList => ({
      cases: [],
      stats: {
        open: 0,
        total: 0,
        expected_recoverable_paise: 0,
        probability_source_mix: { model: 0, baseline: 0 },
        actions: { total: 0, succeeded: 0, failed: 0, escalated: 0, in_flight: 0, retried: 0, cost_paise: 0 },
      },
    }),
  );

export const fetchCase = (id: string) => api<CaseDetail>(`/api/v1/cases/${id}`);

// ── Model card (§11.2) ───────────────────────────────────────────────────────

export interface CalibrationBucket {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface ModelMetrics {
  auc: number | null;
  brier: number | null;
  logLoss: number | null;
  baselineAuc: number | null;
  baselineBrier: number | null;
  positiveRate: number;
  rows: { train: number; val: number; test: number };
  split_boundaries: { trainEndsAt: string | null; valEndsAt: string | null; testEndsAt: string | null };
  calibration_curve: CalibrationBucket[];
  loss_history: number[];
  fit: { epochs: number; learningRate: number; l2: number };
}

export interface ModelCard {
  active: {
    id: string;
    kind: string;
    trained_at: string;
    coefficients: { weights: number[]; intercept: number; feature_names: string[] };
    metrics: ModelMetrics;
  } | null;
  versions: { id: string; trained_at: string; is_active: boolean; metrics: ModelMetrics }[];
}

export const fetchModel = () =>
  api<ModelCard>('/api/v1/model').catch((): ModelCard => ({ active: null, versions: [] }));
