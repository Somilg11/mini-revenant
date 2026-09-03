import { randomUUID } from 'node:crypto';
import { sql, closeDb } from '../db/client.ts';
import { trainingRows, type TrainingRow } from '../db/queries.ts';
import { featuresOf, rescoreOpenCases } from '../app/recovery.ts';
import { FEATURE_NAMES, encode } from '../domain/recovery-model.ts';
import { log } from '../lib/logger.ts';
import {
  DEFAULT_FIT,
  auc,
  brier,
  calibrationCurve,
  calibrationMap,
  fitLogistic,
  logLoss,
  predictProba,
  standardisation,
  standardise,
  type CalibrationBucket,
} from './logistic.ts';

/**
 * `bun train` — fit the recovery model, evaluate it, persist it, activate it (§7.5).
 *
 * Three things here are the difference between a model and a demo of one:
 *
 *  1. **The split is chronological by position, never random.** A random split
 *     lets the model learn a customer's later behaviour and be tested on their
 *     earlier behaviour; every metric improves and the model collapses in
 *     production. The generator assigned `split` by position and this reads it.
 *  2. **Standardisation and calibration come from train and val respectively,
 *     and the reported metrics from test.** Fitting anything on the split you
 *     then score is the oldest way to lie with a model.
 *  3. **The feature vector is `encode()` from `domain/recovery-model.ts`** — the
 *     same function the case scorer calls. There is no second encoding to drift
 *     from this one.
 */

export interface ModelCard {
  id: string;
  trainedAt: string;
  featureNames: readonly string[];
  weights: number[];
  intercept: number;
  rows: { train: number; val: number; test: number };
  splitBoundaries: { trainEndsAt: string | null; valEndsAt: string | null; testEndsAt: string | null };
  metrics: {
    auc: number | null;
    brier: number | null;
    logLoss: number | null;
    /** The baseline's numbers on the same test split, so the lift is measurable. */
    baselineAuc: number | null;
    baselineBrier: number | null;
    positiveRate: number;
  };
  calibration: CalibrationBucket[];
  lossHistory: number[];
}

function toXY(rows: readonly TrainingRow[]): { X: number[][]; y: number[] } {
  return {
    X: rows.map((r) => encode(featuresOf(r))),
    y: rows.map((r) => (r.recoverable ? 1 : 0)),
  };
}

export async function train(opts = DEFAULT_FIT): Promise<ModelCard> {
  const startedAt = performance.now();
  const rows = await trainingRows();
  if (rows.length < 100) {
    throw new Error(`only ${rows.length} labelled rows — run bun seed or a replay first`);
  }

  const train = rows.filter((r) => r.split === 'train');
  const val = rows.filter((r) => r.split === 'val');
  const test = rows.filter((r) => r.split === 'test');
  log.info('training data', { total: rows.length, train: train.length, val: val.length, test: test.length });

  const tr = toXY(train);
  const va = toXY(val);
  const te = toXY(test);

  const scaler = standardisation(tr.X);
  const fitted = fitLogistic(standardise(tr.X, scaler), tr.y, opts);

  // Calibration from val, never from test.
  const valRaw = predictProba(standardise(va.X, scaler), fitted);
  const curve = calibrationCurve(valRaw, va.y);
  const map = calibrationMap(curve);
  const calibrate = (p: number) => {
    const i = Math.min(9, Math.max(0, Math.floor(p * 10)));
    const m = map[i];
    return m === undefined || Number.isNaN(m) ? p : m;
  };

  // Reported metrics from test, through the same calibration serving will use.
  const testScores = predictProba(standardise(te.X, scaler), fitted).map(calibrate);

  // The baseline's score on the same rows, so "the model is better" is a
  // measured claim with a number beside it.
  const { baselineProbability } = await import('../domain/recovery-model.ts');
  const baselineScores = test.map((r) => baselineProbability(featuresOf(r)));

  const card: ModelCard = {
    id: `model_${randomUUID().slice(0, 12)}`,
    trainedAt: new Date().toISOString(),
    featureNames: FEATURE_NAMES,
    weights: fitted.weights,
    intercept: fitted.intercept,
    rows: { train: train.length, val: val.length, test: test.length },
    splitBoundaries: {
      trainEndsAt: train.at(-1)?.created_at ?? null,
      valEndsAt: val.at(-1)?.created_at ?? null,
      testEndsAt: test.at(-1)?.created_at ?? null,
    },
    metrics: {
      auc: auc(testScores, te.y),
      brier: brier(testScores, te.y),
      logLoss: logLoss(testScores, te.y),
      baselineAuc: auc(baselineScores, te.y),
      baselineBrier: brier(baselineScores, te.y),
      positiveRate: te.y.length === 0 ? 0 : te.y.reduce((a, b) => a + b, 0) / te.y.length,
    },
    calibration: calibrationCurve(testScores, te.y),
    lossHistory: fitted.lossHistory,
  };

  await sql.begin(async (tx) => {
    // At most one active model, by constraint (`model_one_active`). Deactivate
    // in the same transaction so there is never a moment with zero or two.
    await tx`UPDATE model_versions SET is_active = FALSE WHERE is_active`;
    await tx`
      INSERT INTO model_versions (id, kind, coefficients, calibration, metrics, trained_at, is_active)
      VALUES (
        ${card.id}, 'logistic',
        ${tx.json({
          weights: card.weights,
          intercept: card.intercept,
          means: scaler.means,
          std_devs: scaler.stdDevs,
          feature_names: [...FEATURE_NAMES],
        } as never)},
        ${tx.json({ buckets: map.map((m) => (Number.isNaN(m) ? null : m)), curve } as never)},
        ${tx.json({
          ...card.metrics,
          rows: card.rows,
          split_boundaries: card.splitBoundaries,
          calibration_curve: card.calibration,
          loss_history: card.lossHistory.filter((_, i) => i % 10 === 0),
          fit: opts,
        } as never)},
        ${card.trainedAt}, TRUE
      )`;
  });

  log.info('model trained and activated', {
    id: card.id,
    auc: card.metrics.auc,
    brier: card.metrics.brier,
    logLoss: card.metrics.logLoss,
    baselineAuc: card.metrics.baselineAuc,
    ms: Math.round(performance.now() - startedAt),
  });

  // Open cases were priced by the baseline; re-price them now so the badges
  // flip. New cases pick the model up on their own.
  const rescored = await rescoreOpenCases();
  log.info('open cases rescored', rescored);

  return card;
}

function report(c: ModelCard): void {
  const f = (v: number | null, d = 3) => (v === null ? '—' : v.toFixed(d));
  const lines = [
    '',
    '  ── Model card ──────────────────────────────────────────',
    `  id             ${c.id}`,
    `  rows           train ${c.rows.train} · val ${c.rows.val} · test ${c.rows.test}  (chronological)`,
    `  positive rate  ${(c.metrics.positiveRate * 100).toFixed(1)}% of test rows recoverable`,
    '',
    '  ── On the held-out test split ──────────────────────────',
    `  AUC            ${f(c.metrics.auc)}   (baseline ${f(c.metrics.baselineAuc)})`,
    `  Brier          ${f(c.metrics.brier)}   (baseline ${f(c.metrics.baselineBrier)})`,
    `  log loss       ${f(c.metrics.logLoss)}`,
    '',
    '  ── Calibration (predicted → observed) ──────────────────',
    ...c.calibration
      .filter((b) => b.count > 0)
      .map(
        (b) =>
          `  ${(b.lower * 100).toFixed(0).padStart(3)}–${(b.upper * 100).toFixed(0).padEnd(3)}%  predicted ${((b.meanPredicted ?? 0) * 100).toFixed(1).padStart(5)}%  observed ${((b.observedRate ?? 0) * 100).toFixed(1).padStart(5)}%  n=${b.count}`,
      ),
    '',
    '  ── Largest weights (standardised) ──────────────────────',
    ...c.weights
      .map((w, i) => ({ w, name: c.featureNames[i]! }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
      .slice(0, 8)
      .map((x) => `  ${x.w >= 0 ? '+' : ''}${x.w.toFixed(3).padStart(7)}  ${x.name}`),
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (import.meta.main) {
  try {
    report(await train());
  } catch (err) {
    log.error('training failed', { err });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
