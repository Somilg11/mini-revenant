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
