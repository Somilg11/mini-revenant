import { randomUUID } from 'node:crypto';
import { sql } from '../db/client.ts';
import { notify } from '../db/notify.ts';
import {
  DEFAULT_DETECTOR_CONFIG,
  evaluate,
  isResolved,
  requiredBuckets,
  type DetectorConfig,
  type Verdict,
} from '../domain/detector.ts';
import {
  activeSlices,
  openIncidents,
  sliceExposure,
  sliceSeries,
  type IncidentRow,
} from '../db/queries.ts';
import { isUniqueViolation } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { BUCKET_MINUTES } from './analytics.ts';

/**
 * The detection sweep (§7.3, §9).
 *
 * Runs on **simulated** time, every five simulated minutes, single-flighted by
 * `pg_advisory_xact_lock`. Two sweeps racing would evaluate the same slices
 * against the same series and try to open the same incident twice; the
 * `incidents_one_open` partial unique index would refuse the second, but a lock
 * is cheaper than an exception and keeps the log honest.
 */

const SWEEP_LOCK_KEY = 0x44455443; // 'DETC'

/** An open incident on a slice suppresses a new one for 60 simulated minutes. */
const SUPPRESSION_MINUTES = 60;

export interface SweepResult {
  evaluated: number;
  opened: string[];
  resolved: string[];
  skipped: number;
}

export async function sweep(
  now: Date,
  cfg: DetectorConfig = DEFAULT_DETECTOR_CONFIG,
): Promise<SweepResult> {
  const result: SweepResult = { evaluated: 0, opened: [], resolved: [], skipped: 0 };

  const bucketMs = BUCKET_MINUTES * 60_000;
  const to = new Date(Math.floor(now.getTime() / bucketMs) * bucketMs).toISOString();
  const from = new Date(Date.parse(to) - requiredBuckets(cfg) * bucketMs).toISOString();

  return sql.begin(async (tx) => {
    // Transaction-scoped: released on commit or rollback, so a crashed sweep
    // cannot wedge every later one.
    const [lock] = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_KEY}) AS locked`;
    if (!lock?.locked) {
      log.debug('detection sweep already running, skipped');
      return result;
    }

    const open = await openIncidents(tx as never);
    const openBySlice = new Map(open.map((i) => [`${i.dimension}:${i.dimension_value}`, i]));

    // ── Resolve first, so a slice that recovered can be re-detected later ────
    for (const incident of open) {
      const series = await sliceSeries(
        { dimension: incident.dimension, dimensionValue: incident.dimension_value },
        new Date(Date.parse(to) - cfg.resolveBuckets * bucketMs).toISOString(),
        to,
        tx as never,
      );
      if (isResolved(series, incident.baseline_rate, cfg)) {
        await tx`
          UPDATE incidents SET status = 'RESOLVED', resolved_at = ${to} WHERE id = ${incident.id}`;
        await notify(tx, 'incident.resolved', {
          incident_id: incident.id,
          dimension: incident.dimension,
          dimension_value: incident.dimension_value,
        });
        openBySlice.delete(`${incident.dimension}:${incident.dimension_value}`);
        result.resolved.push(incident.id);
        log.info('incident resolved', {
          incidentId: incident.id,
          dimension: incident.dimension,
          value: incident.dimension_value,
        });
      }
    }

    // ── Then evaluate every slice with enough traffic to be worth judging ────
    const slices = await activeSlices(from, to, cfg.minAttempts, tx as never);

    for (const slice of slices) {
      const key = `${slice.dimension}:${slice.dimensionValue}`;
      if (openBySlice.has(key)) {
        result.skipped += 1;
        continue;
      }
      if (await recentlyResolved(tx as never, slice, to)) {
        // A slice that just recovered will wobble; re-opening on that wobble
        // produces a stutter of near-identical incidents.
        result.skipped += 1;
        continue;
      }

      const series = await sliceSeries(slice, from, to, tx as never);
      const verdict = evaluate(series, cfg);
      if (!verdict.evaluated) continue;
      result.evaluated += 1;
      if (!verdict.anomalous) continue;

      const id = await openIncident(tx as never, slice, verdict, to, cfg);
      if (id) result.opened.push(id);
    }

    if (result.opened.length > 0 || result.resolved.length > 0) {
      log.info('detection sweep', {
        at: to,
        evaluated: result.evaluated,
        opened: result.opened.length,
        resolved: result.resolved.length,
      });
    }
    return result;
  });
}

async function recentlyResolved(
  tx: typeof sql,
  slice: { dimension: string; dimensionValue: string },
  now: string,
): Promise<boolean> {
  const since = new Date(Date.parse(now) - SUPPRESSION_MINUTES * 60_000).toISOString();
  const [row] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM incidents
    WHERE dimension = ${slice.dimension}
      AND dimension_value = ${slice.dimensionValue}
      AND status = 'RESOLVED'
      AND resolved_at >= ${since}`;
  return (row?.n ?? 0) > 0;
}

async function openIncident(
  tx: typeof sql,
  slice: { dimension: string; dimensionValue: string },
  verdict: Verdict,
  at: string,
  cfg: DetectorConfig,
): Promise<string | null> {
  const bucketMs = BUCKET_MINUTES * 60_000;
  const windowFrom = new Date(Date.parse(at) - cfg.evaluationBuckets * bucketMs).toISOString();
  const exposure = await sliceExposure(slice, windowFrom, at, tx as never);

  const id = `inc_${randomUUID().slice(0, 12)}`;
  try {
    await tx`
      INSERT INTO incidents (
        id, merchant_id, status, dimension, dimension_value, opened_at,
        baseline_rate, current_rate, z_score, gates, affected_payments, revenue_at_risk_paise
      ) VALUES (
        ${id},
        -- NULL: injected incidents are infrastructure-wide, not per-merchant (§8.2).
        NULL, 'OPEN', ${slice.dimension}, ${slice.dimensionValue}, ${at},
        ${verdict.baselineRate}, ${verdict.currentRate}, ${verdict.zScore},
        ${tx.json(verdict.gates as never)}, ${exposure.affected}, ${exposure.atRiskPaise}
      )`;
  } catch (err) {
    // Deduplication is a constraint, not a lookup (§6.1): a concurrent sweep
    // got there first, which is a normal outcome rather than an error.
    if (isUniqueViolation(err, 'incidents_one_open')) return null;
    throw err;
  }

  await notify(tx, 'incident.opened', {
    incident_id: id,
    dimension: slice.dimension,
    dimension_value: slice.dimensionValue,
    current_rate: verdict.currentRate,
    baseline_rate: verdict.baselineRate,
    z_score: verdict.zScore,
    revenue_at_risk_paise: exposure.atRiskPaise,
  });

  log.info('incident opened', {
    incidentId: id,
    dimension: slice.dimension,
    value: slice.dimensionValue,
    currentRate: Number(verdict.currentRate.toFixed(4)),
    baselineRate: Number(verdict.baselineRate.toFixed(4)),
    zScore: Number(verdict.zScore.toFixed(1)),
    affected: exposure.affected,
  });
  return id;
}

export type { IncidentRow };

/**
 * The most recent 5-minute bucket that actually holds data.
 *
 * Detection must follow the **data**, not the clock. The replay emits events at
 * simulated time T, but the relay projects them asynchronously, so the rollups
 * trail the clock by however deep the outbox happens to be. A sweep run at T
 * therefore evaluates a window whose most recent buckets are still empty, fails
 * the volume gate, and moves on — and because the sweep only ever looks
 * forward, that window is never revisited. Every incident was missed this way.
 */
export async function latestDataBucket(): Promise<Date | null> {
  const [row] = await sql<{ latest: string | null }[]>`
    SELECT max(bucket_start)::text AS latest FROM metrics_rollup`;
  return row?.latest ? new Date(row.latest) : null;
}

/**
 * Sweeps every bucket from `after` up to the latest one carrying data.
 *
 * Stepping bucket by bucket rather than jumping to the end matters: an
 * evaluation window is fifteen minutes wide, so a sweep that skipped from
 * Monday to Wednesday would step straight over a two-hour outage without ever
 * evaluating it.
 */
export async function catchUp(
  after: Date,
  opts: { maxBuckets?: number; config?: DetectorConfig; until?: Date } = {},
): Promise<{ result: SweepResult; sweptTo: Date }> {
  const cfg = opts.config ?? DEFAULT_DETECTOR_CONFIG;
  const bucketMs = BUCKET_MINUTES * 60_000;
  const combined: SweepResult = { evaluated: 0, opened: [], resolved: [], skipped: 0 };

  const dataBucket = await latestDataBucket();
  if (!dataBucket) return { result: combined, sweptTo: after };

  // A bucket is only ready to judge once every fact about it has arrived.
  // Abandonment is decided 30 simulated minutes after a payment goes quiet, so
  // the abandoned counts for a bucket land well after its payments did.
  // Evaluating sooner reads a bucket that is still filling — which is how the
  // abandonment spike scored 10.5% against a 9.1% baseline and was dismissed.
  const latest = opts.until
    ? new Date(Math.min(dataBucket.getTime(), opts.until.getTime()))
    : dataBucket;

  let cursor = Date.parse(after.toString()) || after.getTime();
  const limit = opts.maxBuckets ?? 24;
  let swept = after;

  for (let i = 0; i < limit; i += 1) {
    const next = cursor + bucketMs;
    if (next > latest.getTime()) break;
    cursor = next;
    const r = await sweep(new Date(cursor), cfg);
    combined.evaluated += r.evaluated;
    combined.skipped += r.skipped;
    combined.opened.push(...r.opened);
    combined.resolved.push(...r.resolved);
    swept = new Date(cursor);
  }

  return { result: combined, sweptTo: swept };
}
