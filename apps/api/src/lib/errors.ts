import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Error taxonomy.
 *
 * §9 classifies failures as RETRYABLE / TERMINAL / NEEDS_HUMAN, and the retry
 * logic reads the **class**, never the message text — message matching is how a
 * reliability policy silently stops working after a vendor reworks its copy.
 *
 * Unclassified defaults to NEEDS_HUMAN: in a money system, "I don't know" means
 * "ask a person", never "try it again".
 */
export type ErrorClass = 'RETRYABLE' | 'TERMINAL' | 'NEEDS_HUMAN';

export interface AppErrorOptions {
  status?: ContentfulStatusCode;
  errorClass?: ErrorClass;
  /** Safe to show a caller. Must never contain PII or a payment payload. */
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: ContentfulStatusCode;
  readonly errorClass: ErrorClass;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: string, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.errorClass = opts.errorClass ?? 'NEEDS_HUMAN';
    this.detail = opts.detail;
  }
}

export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('CONFIG_INVALID', message, { status: 500, errorClass: 'NEEDS_HUMAN', cause });
    this.name = 'ConfigError';
  }
}

export class MigrationError extends AppError {
  constructor(message: string, detail?: Record<string, unknown>, cause?: unknown) {
    super('MIGRATION_FAILED', message, {
      status: 500,
      errorClass: 'NEEDS_HUMAN',
      ...(detail ? { detail } : {}),
      cause,
    });
    this.name = 'MigrationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found`, {
      status: 404,
      errorClass: 'TERMINAL',
      detail: { resource, id },
    });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, {
      status: 400,
      errorClass: 'TERMINAL',
      ...(detail ? { detail } : {}),
    });
    this.name = 'ValidationError';
  }
}

/**
 * Postgres error codes that mean "somebody else got there first". These are
 * the partial unique indexes of §6.1 doing their job — `incidents_one_open`,
 * `cases_one_live`, `model_one_active` — so they are an expected control-flow
 * signal, not an incident.
 */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as unknown as Record<string, unknown>;
  if (e.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || e.constraint_name === constraint;
}

/** Postgres is unreachable or refusing connections, as opposed to rejecting a query. */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as unknown as Record<string, unknown>).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'CONNECTION_CLOSED' ||
    code === 'CONNECT_TIMEOUT'
  );
}

/** A short, safe string for a caller. Never leaks a stack or a payload. */
export function publicMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  return 'internal error';
}

/**
 * A human-readable one-liner for any error.
 *
 * `AggregateError` is the case that matters here: `localhost` resolves to both
 * `::1` and `127.0.0.1`, so a refused connection arrives as an AggregateError
 * whose own `message` is the empty string, with the real causes in `.errors`.
 * Reporting that verbatim gives a readiness probe that says "down" and nothing
 * else, which is the single least useful thing it could say.
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map(describeError).filter(Boolean);
    const unique = [...new Set(parts)];
    if (unique.length > 0) return unique.join('; ');
  }
  if (err instanceof Error) {
    if (err.message) return err.message;
    const code = (err as unknown as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
    if (err.cause !== undefined) return describeError(err.cause);
    return err.name;
  }
  return String(err);
}
