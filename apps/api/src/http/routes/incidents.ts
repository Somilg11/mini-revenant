import { Hono } from 'hono';
import { scoreDetection, scoreNoiseWindows } from '../../app/evaluation.ts';
import { getIncident, listIncidents, sliceSeries } from '../../db/queries.ts';
import { DEFAULT_DETECTOR_CONFIG } from '../../domain/detector.ts';
import { runner } from '../../sim/runner.ts';
import { NotFoundError, ValidationError } from '../../lib/errors.ts';
import { rate } from '../../domain/money.ts';
import type { AppEnv } from '../app.ts';

export const incidents = new Hono<AppEnv>();

incidents.get('/api/v1/incidents', async (c) => {
  const status = (c.req.query('status') ?? 'ALL').toUpperCase();
  if (!['OPEN', 'RESOLVED', 'ALL'].includes(status)) {
    throw new ValidationError(`unknown status ${status}`, { allowed: ['OPEN', 'RESOLVED', 'ALL'] });
  }
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const rows = await listIncidents(status as 'OPEN' | 'RESOLVED' | 'ALL', limit);
  return c.json({ incidents: rows });
});

/** Verdict, evidence and the five gates with their numbers (§11.2). */
incidents.get('/api/v1/incidents/:id', async (c) => {
  const id = c.req.param('id');
  const incident = await getIncident(id);
  if (!incident) throw new NotFoundError('incident', id);
  return c.json({ incident });
});

incidents.get('/api/v1/incidents/:id/timeseries', async (c) => {
  const id = c.req.param('id');
  const incident = await getIncident(id);
  if (!incident) throw new NotFoundError('incident', id);

  // A few hours either side of the detection moment, so the shape of the
  // degradation is visible rather than just its peak.
  const openedMs = Date.parse(incident.opened_at);
  const from = new Date(openedMs - 6 * 3600_000).toISOString();
  const to = new Date(
    Math.min(
      openedMs + 6 * 3600_000,
      incident.resolved_at ? Date.parse(incident.resolved_at) + 6 * 3600_000 : Infinity,
    ),
  ).toISOString();

  const points = await sliceSeries(
    { dimension: incident.dimension, dimensionValue: incident.dimension_value },
    from,
    to,
  );
  return c.json({
    incident_id: id,
    dimension: incident.dimension,
    dimension_value: incident.dimension_value,
    baseline_rate: incident.baseline_rate,
    opened_at: incident.opened_at,
    resolved_at: incident.resolved_at,
    points: points.map((p) => ({ ...p, failure_rate: rate(p.failures, p.attempts) })),
  });
});

/**
 * Detection scored against the answer key (§8.4).
 *
 * Recall alone proves nothing — a detector that fires on everything has perfect
 * recall. The noise windows are the other half, and they are reported beside it.
 */
incidents.get('/api/v1/evaluation', async (c) => {
  const score = await scoreDetection();
  const noise = await scoreNoiseWindows(runner.state().noiseWindows);

  return c.json({
    detection: {
      precision: score.precision,
      recall: score.recall,
      true_positives: score.truePositives,
      false_positives: score.falsePositives,
      false_negatives: score.falseNegatives,
      incidents_opened: score.totalIncidentsOpened,
      matches: score.matches,
      unmatched: score.unmatched,
    },
    noise_windows: {
      clean: noise.clean,
      windows: noise.windows,
    },
    detector_config: DEFAULT_DETECTOR_CONFIG,
    // RCA top-1 accuracy lands in P8.
    rca: null,
  });
});
