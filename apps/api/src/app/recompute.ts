import { closeDb } from '../db/client.ts';
import { log } from '../lib/logger.ts';
import { measureDrift, recomputeRollups } from './analytics.ts';

/**
 * `bun rollups:recompute` — repair drift.
 *
 * Deliberately a command rather than something the drift check does on its own.
 * A rollup that repairs itself the moment anybody looks at it hides the bug
 * that caused the drift, and on a money dashboard that bug is a wrong number
 * somebody has already acted on (§10).
 */
if (import.meta.main) {
  try {
    const before = await measureDrift();
    log.info('drift before recompute', { rows: before.rows, attempts: before.attempts });
    const r = await recomputeRollups();
    const after = await measureDrift();
    log.info('drift after recompute', { rows: after.rows, recomputed: r.rows, ms: r.ms });
    if (after.rows !== 0) process.exitCode = 1;
  } catch (err) {
    log.error('recompute failed', { err });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
