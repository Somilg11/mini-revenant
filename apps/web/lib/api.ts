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
