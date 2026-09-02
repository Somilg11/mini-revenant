import { config } from '../config.ts';

/**
 * Structured logging. One JSON object per line, so the whole demo is greppable
 * and a log line can be pasted into a ticket without reformatting.
 *
 * §15.2 is a hard rule: **payment payloads and PII are never logged.** The
 * `redact` pass below drops known-sensitive keys wherever they appear in the
 * fields object, so a careless `log.info('x', { payload })` fails safe rather
 * than leaking a card country and an amount into a log aggregator.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.LOG_LEVEL];

/**
 * Keys never written to a log, at any depth. `payload` and `payment_events`
 * carry gateway bodies; the rest are secrets or direct identifiers.
 */
const REDACTED_KEYS = new Set([
  'payload',
  'raw_response',
  'rawtext',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'webhook_secret',
  'card_number',
  'email',
  'phone',
  'contact',
]);

const MAX_DEPTH = 4;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Errors do not survive `JSON.stringify` — an uncaught one serialises to `{}`,
 * which is how a production incident becomes unreadable. Unwrap explicitly.
 */
function serialiseError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  // An AggregateError's own message is empty; the causes are in `.errors`.
  // Without this a refused connection logs as `{"name":"AggregateError","message":""}`.
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out.errors = err.errors.slice(0, 5).map((e) => serialiseError(e));
  }
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 8).join('\n');
  if (err.cause !== undefined) out.cause = serialiseError(err.cause);
  // postgres.js attaches these and they are the useful part of a DB failure.
  for (const k of ['code', 'constraint_name', 'table_name', 'detail', 'severity']) {
    const v = (err as unknown as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;

  const line: Record<string, unknown> = {
    ts: new Date().toISOString(), // UTC everywhere in code (invariant 7)
    level,
    msg,
  };

  if (fields) {
    const { err, ...rest } = fields;
    Object.assign(line, redact(rest));
    if (err !== undefined) line.err = serialiseError(err);
  }

  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
