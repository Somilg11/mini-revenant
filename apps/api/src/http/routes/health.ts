import { Hono } from 'hono';
import { ping } from '../../db/client.ts';
import { schemaState, datasetState } from '../../db/queries.ts';
import { describeError } from '../../lib/errors.ts';
import { llmStatus } from '../../lib/llm.ts';
import { log } from '../../lib/logger.ts';

export const health = new Hono();

/**
 * Liveness. Deliberately touches nothing — a process that can answer this is
 * running, and that is the only question. Wiring a dependency in here is how a
 * database blip turns into a restart loop.
 */
health.get('/health', (c) =>
  c.json({ ok: true, service: 'minirevenant-api', uptime_s: Math.round(process.uptime()) }),
);

/**
 * Readiness, with a per-dependency breakdown (§10).
 *
 * Two judgements are encoded here:
 *  - A degraded LLM is **not** a reason to fail readiness. The deterministic
 *    path is the supported one (§14), so `llm.enabled: false` is a normal state
 *    and says why.
 *  - An unseeded database is **not** a reason to fail readiness either. It
 *    renders an empty dashboard, never a crash and never a fake number.
 * Only the database and its migrations gate readiness.
 */
health.get('/ready', async (c) => {
  const db = await ping();

  let schema: { applied: number; tables: number } | null = null;
  let dataset: Awaited<ReturnType<typeof datasetState>> | null = null;
  let error: string | null = db.up ? null : (db.error ?? 'database unreachable');

  if (db.up) {
    try {
      const s = await schemaState();
      schema = { applied: s.migrationsApplied, tables: s.tableCount };
      dataset = await datasetState();
    } catch (err) {
      // Reporting the reason is the entire job of this endpoint. Swallowing it
      // leaves an operator staring at `ready: false` with nowhere to go.
      error = describeError(err);
      log.warn('readiness probe could not read schema state', { err });
    }
  }

  const ready = db.up && (schema?.applied ?? 0) > 0;

  return c.json(
    {
      ready,
      checks: {
        database: {
          up: db.up,
          latency_ms: db.latencyMs,
          ...(db.error ? { error: db.error } : {}),
        },
        migrations: schema ? { applied: schema.applied, tables: schema.tables } : null,
        // "Not measured" is null with a label, never 0 (invariant 6).
        dataset: dataset
          ? {
              payments: dataset.payments,
              merchants: dataset.merchants,
              seeded: dataset.payments > 0,
              checksum: dataset.checksum,
              seed: dataset.seed,
            }
          : null,
        llm: llmStatus(),
      },
      ...(error ? { error } : {}),
    },
    ready ? 200 : 503,
  );
});
