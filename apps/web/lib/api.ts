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
