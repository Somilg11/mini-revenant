import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, closeDb, type Sql } from './client.ts';
import { MigrationError } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';

/**
 * Forward-only migrations, applied in filename order, exactly once.
 *
 * Three properties, each load-bearing:
 *
 *  1. **One reserved connection.** `pg_advisory_lock` is session-scoped. Taking
 *     it on a pooled connection and then running the migrations on whichever
 *     connection the pool hands out next would leave the lock guarding nothing,
 *     and the unlock would run on a session that never held it.
 *
 *  2. **Lock before DDL.** `CREATE TABLE IF NOT EXISTS` is not atomic against a
 *     concurrent create — two processes racing on it fail with a duplicate key
 *     on `pg_type_typname_nsp_index`. Everything, including the bookkeeping
 *     table, happens inside the lock. This is what makes §14's "two API
 *     processes booting simultaneously migrate exactly once" true.
 *
 *  3. **Checksums.** Forward-only means an applied file is immutable. Editing
 *     one after the fact produces a database that no longer matches its own
 *     migration history, and nothing would otherwise notice. A changed checksum
 *     is a hard failure at boot, which is the only moment it is cheap to fix.
 */
const MIGRATION_LOCK_KEY = 0x5245564e; // 'REVN'

/** A stuck peer should surface as a clear error, not an indefinite hang at boot. */
const LOCK_TIMEOUT_MS = 30_000;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../migrations');

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

function checksum(body: string): string {
  // Normalise line endings so a checkout on another platform is not a mismatch.
  return createHash('sha256').update(body.replace(/\r\n/g, '\n')).digest('hex');
}

export async function migrate(db: Sql = sql): Promise<MigrationReport> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    throw new MigrationError('cannot read migrations directory', { dir: MIGRATIONS_DIR }, err);
  }
  if (files.length === 0) {
    throw new MigrationError('no migrations found', { dir: MIGRATIONS_DIR });
  }

  const conn = await db.reserve();
  const applied: string[] = [];
  let locked = false;

  try {
    // Bounded wait: a peer mid-migration is normal, a peer that died holding
    // the lock is not, and the two are indistinguishable without a timeout.
    await conn.unsafe(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
    try {
      await conn`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
      locked = true;
    } catch (err) {
      throw new MigrationError(
        `could not acquire the migration lock within ${LOCK_TIMEOUT_MS}ms — another process may be migrating, or one died holding it`,
        { lockKey: MIGRATION_LOCK_KEY },
        err,
      );
    }

    await conn`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    // Tolerate a database created before checksums existed.
    await conn`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT NOT NULL DEFAULT ''`;

    const done = await conn<{ filename: string; checksum: string }[]>`
      SELECT filename, checksum FROM schema_migrations`;
    const seen = new Map(done.map((r) => [r.filename, r.checksum]));

    for (const filename of files) {
      let body: string;
      try {
        body = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      } catch (err) {
        throw new MigrationError('cannot read migration file', { filename }, err);
      }
      const sum = checksum(body);

      const priorSum = seen.get(filename);
      if (priorSum !== undefined) {
        // '' is a row written before checksums were tracked — adopt it rather
        // than failing a database that was fine.
        if (priorSum === '') {
          await conn`UPDATE schema_migrations SET checksum = ${sum} WHERE filename = ${filename}`;
        } else if (priorSum !== sum) {
          throw new MigrationError(
            `${filename} changed after it was applied — migrations are forward-only`,
            { filename, appliedChecksum: priorSum, fileChecksum: sum },
          );
        }
        continue;
      }

      // One transaction per file: a migration either lands whole or not at all.
      // Transaction control is issued explicitly rather than through `.begin()`
      // — a reserved connection does not expose it, and the point of reserving
      // is that these statements are guaranteed to share one session anyway.
      const startedAt = performance.now();
      await conn.unsafe('BEGIN');
      try {
        await conn.unsafe(body);
        await conn`
          INSERT INTO schema_migrations (filename, checksum) VALUES (${filename}, ${sum})`;
        await conn.unsafe('COMMIT');
      } catch (err) {
        try {
          await conn.unsafe('ROLLBACK');
        } catch (rollbackErr) {
          log.error('rollback failed after a failed migration', { filename, err: rollbackErr });
        }
        throw new MigrationError(`${filename} failed to apply`, { filename }, err);
      }

      applied.push(filename);
      log.info('migration applied', {
        filename,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }

    return { applied, alreadyApplied: files.length - applied.length };
  } finally {
    if (locked) {
      try {
        await conn`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
      } catch (err) {
        // Releasing the connection drops the session and with it the lock, so
        // this is recoverable — but it is worth knowing it happened.
        log.warn('advisory unlock failed; releasing the session instead', { err });
      }
    }
    conn.release();
  }
}

if (import.meta.main) {
  try {
    const report = await migrate();
    if (report.applied.length === 0) {
      log.info('migrations up to date', { alreadyApplied: report.alreadyApplied });
    } else {
      log.info('migrations complete', {
        applied: report.applied,
        alreadyApplied: report.alreadyApplied,
      });
    }
  } catch (err) {
    log.error('migration failed', { err });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
