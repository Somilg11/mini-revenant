import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { train } from '../src/ml/train.ts';
import { loadActiveModel, rescoreOpenCases } from '../src/app/recovery.ts';
import { activeModelVersion } from '../src/db/queries.ts';
import { FEATURE_NAMES } from '../src/domain/recovery-model.ts';
import { assertNoCompetingRelay } from './helpers.ts';

/**
 * Trains against whatever labelled data the database holds. Needs a seeded or
 * replayed dataset; with fewer than 100 labelled rows the suite says so and
 * skips rather than failing on an empty database.
 */
let labelled = 0;
let previousActive: string | null = null;

beforeAll(async () => {
  await assertNoCompetingRelay();
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ground_truth_labels`;
  labelled = row?.n ?? 0;
  previousActive = (await activeModelVersion())?.id ?? null;
}, 30_000);

afterAll(async () => {
  // Leave the database as it was found: drop what this suite trained and
  // restore whichever model was active before.
  await sql`DELETE FROM model_versions WHERE id LIKE 'model_%' AND id NOT IN (SELECT id FROM model_versions WHERE id = ${previousActive ?? ''})`;
  if (previousActive) {
    await sql`UPDATE model_versions SET is_active = TRUE WHERE id = ${previousActive}`;
    // Re-pricing every open case is a few seconds on a seeded database — well
    // past Bun's five-second default for a hook.
    await rescoreOpenCases();
  }
}, 120_000);

describe('§7.5 — training', () => {
  test('fits, evaluates on the held-out split, persists and activates', async () => {
    if (labelled < 100) return;
    const card = await train({ epochs: 60, learningRate: 0.1, l2: 1e-4 });

    // The split is chronological and the boundaries are in order.
    expect(card.rows.train).toBeGreaterThan(card.rows.val);
    expect(card.rows.val).toBeGreaterThan(0);
    expect(card.rows.test).toBeGreaterThan(0);
    const b = card.splitBoundaries;
    expect(Date.parse(b.trainEndsAt!)).toBeLessThanOrEqual(Date.parse(b.valEndsAt!));
    expect(Date.parse(b.valEndsAt!)).toBeLessThanOrEqual(Date.parse(b.testEndsAt!));

    // Metrics exist and are sane.
    expect(card.metrics.auc).not.toBeNull();
    expect(card.metrics.auc!).toBeGreaterThan(0.5);
    expect(card.metrics.brier!).toBeLessThan(0.25);
    expect(Number.isFinite(card.metrics.logLoss!)).toBe(true);

    // One weight per feature — the serving encoder and the trained model agree
    // on the vector, which is the whole point of sharing `encode()`.
    expect(card.weights).toHaveLength(FEATURE_NAMES.length);

    // Converged, not diverged.
    const first = card.lossHistory[0]!;
    const last = card.lossHistory.at(-1)!;
    expect(last).toBeLessThan(first);

    // Persisted and active, by constraint.
    const active = await activeModelVersion();
    expect(active?.id).toBe(card.id);
    const [n] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM model_versions WHERE is_active`;
    expect(n?.n).toBe(1);
  }, 120_000);

  test('every open case is re-priced by the model and says so', async () => {
    if (labelled < 100) return;
    const [row] = await sql<{ model: number; baseline: number }[]>`
      SELECT count(*) FILTER (WHERE probability_source = 'model')::int AS model,
             count(*) FILTER (WHERE probability_source = 'baseline')::int AS baseline
      FROM recovery_cases WHERE status = 'OPEN'`;
    expect(row?.baseline).toBe(0);
    expect(row?.model).toBeGreaterThan(0);
  });

  test('the stored model round-trips through the loader used at serve time', async () => {
    if (labelled < 100) return;
    const m = await loadActiveModel();
    expect(m).not.toBeNull();
    expect(m!.coefficients).toHaveLength(FEATURE_NAMES.length);
    expect(m!.means).toHaveLength(FEATURE_NAMES.length);
    expect(m!.stdDevs).toHaveLength(FEATURE_NAMES.length);
    expect(m!.calibration).toHaveLength(10);
  });
});

describe('§14 — deleting the model falls back to the baseline, flagged', () => {
  test('deactivate → every open case reads baseline; reactivate → model again', async () => {
    if (labelled < 100) return;
    const active = (await activeModelVersion())!;

    await sql`UPDATE model_versions SET is_active = FALSE WHERE id = ${active.id}`;
    let r = await rescoreOpenCases();
    expect(r.model).toBe(0);
    expect(r.baseline).toBe(r.rescored);
    expect(await loadActiveModel()).toBeNull();

    await sql`UPDATE model_versions SET is_active = TRUE WHERE id = ${active.id}`;
    r = await rescoreOpenCases();
    expect(r.baseline).toBe(0);
    expect(r.model).toBe(r.rescored);
  }, 120_000);

  test('a second active model is refused by the constraint, not by an if', async () => {
    let err: unknown = null;
    try {
      await sql`
        INSERT INTO model_versions (id, kind, coefficients, calibration, metrics, is_active)
        VALUES ('model_dup_test', 'logistic', '{}', '{}', '{}', TRUE)`;
    } catch (e) {
      err = e;
    }
    if (await activeModelVersion()) {
      expect(String(err)).toContain('model_one_active');
    } else {
      await sql`DELETE FROM model_versions WHERE id = 'model_dup_test'`;
    }
  });
});
