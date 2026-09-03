import { Hono } from 'hono';
import { sql } from '../../db/client.ts';
import { activeModelVersion, listModelVersions, verifiedOutcomes } from '../../db/queries.ts';
import { brier, calibrationCurve } from '../../ml/logistic.ts';
import { rescoreOpenCases } from '../../app/recovery.ts';
import { NotFoundError } from '../../lib/errors.ts';
import { log } from '../../lib/logger.ts';
import type { AppEnv } from '../app.ts';

export const model = new Hono<AppEnv>();

/**
 * The model card (§11.2): what it is, what it is not, where it breaks.
 *
 * Returns `active: null` rather than 404 when nothing is trained — the
 * baseline is a supported state, and the page has something honest to say
 * about it.
 */
model.get('/api/v1/model', async (c) => {
  const [active, versions] = await Promise.all([activeModelVersion(), listModelVersions()]);
  return c.json({
    active: active
      ? {
          id: active.id,
          kind: active.kind,
          trained_at: active.trained_at,
          coefficients: active.coefficients,
          metrics: active.metrics,
        }
      : null,
    versions: versions.map((v) => ({
      id: v.id,
      trained_at: v.trained_at,
      is_active: v.is_active,
      metrics: v.metrics,
    })),
  });
});

/** Predicted vs observed on the held-out split, ten buckets, with the diagonal implied. */
model.get('/api/v1/model/calibration', async (c) => {
  const active = await activeModelVersion();
  if (!active) return c.json({ active: false, buckets: [] });
  const cal = active.calibration as { curve?: unknown[] };
  const metrics = active.metrics as { calibration_curve?: unknown[] };
  return c.json({
    active: true,
    model_id: active.id,
    // The curve stored on `calibration` was fitted on val; the one on `metrics`
    // is measured on test. The page shows test — the honest one.
    buckets: metrics.calibration_curve ?? cal.curve ?? [],
  });
});

/**
 * The feedback loop (§10): predicted vs actual on **verified** outcomes, not
 * on the test split. Beside the training curve on `/model`, this is what the
 * model has actually delivered since. Empty is a state, not an error.
 */
model.get('/api/v1/calibration/live', async (c) => {
  const rows = await verifiedOutcomes();
  const scores = rows.map((r) => r.predicted_probability);
  const labels: number[] = rows.map((r) => (r.actual_recovered ? 1 : 0));
  const model = rows.filter((r) => r.probability_source === 'model');
  return c.json({
    verified: rows.length,
    by_source: { model: model.length, baseline: rows.length - model.length },
    observed_rate: rows.length > 0 ? labels.reduce((a: number, b: number) => a + b, 0) / rows.length : null,
    mean_predicted: rows.length > 0 ? scores.reduce((a, b) => a + b, 0) / rows.length : null,
    brier: brier(scores, labels),
    buckets: rows.length > 0 ? calibrationCurve(scores, labels) : [],
    // The model's own curve, on the outcomes it priced — the training curve's
    // honest counterpart, without the baseline's rows mixed in.
    model_buckets: model.length > 0 ? calibrationCurve(model.map((r) => r.predicted_probability), model.map((r) => (r.actual_recovered ? 1 : 0))) : [],
  });
});

/**
 * Deactivates the live model — the §14 resilience demonstration.
 *
 * "Delete the trained model row → predictions fall back to the baseline,
 * flagged." The row is kept (a trained model is an artefact worth keeping) but
 * no longer active, and every open case is re-priced so the badges flip in
 * front of whoever is watching.
 */
model.post('/api/v1/model/deactivate', async (c) => {
  const active = await activeModelVersion();
  if (!active) throw new NotFoundError('active model', 'none');
  await sql`UPDATE model_versions SET is_active = FALSE WHERE id = ${active.id}`;
  const rescored = await rescoreOpenCases();
  log.warn('model deactivated — predictions now from the baseline', { id: active.id, ...rescored });
  return c.json({ deactivated: active.id, rescored });
});

/** Re-activates a stored version, re-pricing open cases with it. */
model.post('/api/v1/model/:id/activate', async (c) => {
  const id = c.req.param('id');
  const [row] = await sql<{ id: string }[]>`SELECT id FROM model_versions WHERE id = ${id}`;
  if (!row) throw new NotFoundError('model', id);
  await sql.begin(async (tx) => {
    await tx`UPDATE model_versions SET is_active = FALSE WHERE is_active`;
    await tx`UPDATE model_versions SET is_active = TRUE WHERE id = ${id}`;
  });
  const rescored = await rescoreOpenCases();
  log.info('model activated', { id, ...rescored });
  return c.json({ activated: id, rescored });
});
