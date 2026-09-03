import { sql } from '../db/client.ts';
import { analyse, DEFAULT_RCA_CONFIG, type Observation, type RcaResult } from '../domain/rca.ts';
import { rcaObservations, type IncidentRow, type RcaRow } from '../db/queries.ts';
import { log } from '../lib/logger.ts';
import { BUCKET_MINUTES } from './analytics.ts';
import { DEFAULT_DETECTOR_CONFIG } from '../domain/detector.ts';

/**
 * Runs root-cause apportionment for an incident and stores the result (§7.4).
 *
 * The comparison window is the detector's own evaluation window; the baseline
 * is the 24 hours before it, with the same 30-minute gap the detector uses — so
 * the degradation is not part of the history it is being measured against.
 */

const bucketMs = BUCKET_MINUTES * 60_000;

function toObservation(r: RcaRow): Observation {
  return {
    failed: r.failed,
    dims: {
      bank: r.bank ?? 'none',
      method: r.method,
      amount_band: r.amount_band,
      is_international: r.is_international,
      card_network: r.card_network ?? 'none',
      card_country: r.card_country ?? 'none',
      // Only present on a failure — `domain/rca.ts` treats it as narrowing the
      // numerator, never the denominator.
      failure_code: r.failed ? (r.failure_code ?? 'UNKNOWN') : null,
    },
  };
}

export async function diagnose(incident: IncidentRow): Promise<RcaResult> {
  const cfg = DEFAULT_DETECTOR_CONFIG;
  const openedMs = Date.parse(incident.opened_at);

  const windowFrom = new Date(openedMs - cfg.evaluationBuckets * bucketMs).toISOString();
  const windowTo = new Date(openedMs).toISOString();
  const baselineTo = new Date(
    openedMs - (cfg.evaluationBuckets + cfg.baselineGapBuckets) * bucketMs,
  ).toISOString();
  const baselineFrom = new Date(Date.parse(baselineTo) - cfg.baselineBuckets * bucketMs).toISOString();

  const [windowRows, baselineRows] = await Promise.all([
    rcaObservations(windowFrom, windowTo),
    rcaObservations(baselineFrom, baselineTo),
  ]);

  const result = analyse(
    windowRows.map(toObservation),
    baselineRows.map(toObservation),
    DEFAULT_RCA_CONFIG,
  );

  await sql`
    UPDATE incidents
    SET root_cause = ${sql.json({
      hypotheses: result.hypotheses,
      incident_excess: result.incidentExcess,
      window_attempts: result.windowAttempts,
      window_failures: result.windowFailures,
      pooled_rate: result.pooledRate,
      used_window_as_reference: result.usedWindowAsReference,
      window: { from: windowFrom, to: windowTo },
      baseline: { from: baselineFrom, to: baselineTo },
    } as never)}
    WHERE id = ${incident.id}`;

  const top = result.hypotheses[0];
  log.info('incident diagnosed', {
    incidentId: incident.id,
    slice: `${incident.dimension}=${incident.dimension_value}`,
    topHypothesis: top?.label ?? null,
    excessShare: top ? Number(top.excessShare.toFixed(3)) : null,
    confidence: top ? Number(top.confidence.toFixed(3)) : null,
  });

  return result;
}

/** Diagnoses any incident that does not yet carry a root cause. */
export async function diagnosePending(limit = 20): Promise<number> {
  const rows = await sql<IncidentRow[]>`
    SELECT * FROM incidents WHERE root_cause IS NULL ORDER BY opened_at LIMIT ${limit}`;
  for (const incident of rows) {
    try {
      await diagnose(incident);
    } catch (err) {
      // One incident failing to diagnose must not stop the rest, and must not
      // stop the replay — the incident is still real and still shown.
      log.error('diagnosis failed', { incidentId: incident.id, err });
    }
  }
  return rows.length;
}
