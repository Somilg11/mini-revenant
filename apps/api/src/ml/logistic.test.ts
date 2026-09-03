import { describe, expect, test } from 'bun:test';
import {
  auc,
  brier,
  calibrationCurve,
  calibrationMap,
  fitLogistic,
  logLoss,
  predictProba,
  standardisation,
  standardise,
} from './logistic.ts';
import { Rng } from '../lib/rng.ts';

/** A linearly separable-ish problem with a known direction. */
function synthetic(n: number, seed = 7) {
  const rng = new Rng(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = rng.normal();
    const b = rng.normal();
    const noise = rng.normal() * 0.5;
    X.push([a, b, rng.normal() * 3 + 10]); // third column is pure noise, offset
    y.push(2 * a - b + noise > 0 ? 1 : 0);
  }
  return { X, y };
}

describe('standardisation', () => {
  test('is computed from the rows given, and a constant column does not divide by zero', () => {
    const s = standardisation([
      [1, 5, 9],
      [3, 5, 11],
    ]);
    expect(s.means).toEqual([2, 5, 10]);
    expect(s.stdDevs[1]).toBe(1); // constant column left at 1, not 0
    const z = standardise([[3, 5, 11]], s);
    expect(z[0]![0]).toBeCloseTo(1, 6);
    expect(z[0]![1]).toBe(0);
  });
});

describe('fitLogistic', () => {
  const { X, y } = synthetic(800);
  const s = standardisation(X);
  const model = fitLogistic(standardise(X, s), y);

  test('converges — the loss falls and stays down', () => {
    const first = model.lossHistory[0]!;
    const last = model.lossHistory[model.lossHistory.length - 1]!;
    expect(last).toBeLessThan(first * 0.6);
    // Monotone-ish: no late blow-up.
    const late = model.lossHistory.slice(-50);
    expect(Math.max(...late) - Math.min(...late)).toBeLessThan(0.02);
  });

  test('recovers the sign and rough proportion of the true weights', () => {
    // True direction is (2, -1, 0).
    expect(model.weights[0]).toBeGreaterThan(0);
    expect(model.weights[1]).toBeLessThan(0);
    expect(Math.abs(model.weights[0]!)).toBeGreaterThan(Math.abs(model.weights[1]!));
    expect(Math.abs(model.weights[2]!)).toBeLessThan(Math.abs(model.weights[0]!) * 0.25);
  });

  test('separates held-out data far better than chance', () => {
    const held = synthetic(400, 99);
    const p = predictProba(standardise(held.X, s), model);
    expect(auc(p, held.y)!).toBeGreaterThan(0.9);
    expect(brier(p, held.y)!).toBeLessThan(0.15);
  });

  test('refuses mismatched rows and labels', () => {
    expect(() => fitLogistic([[1, 2]], [1, 0])).toThrow(RangeError);
    expect(() => fitLogistic([], [])).toThrow(RangeError);
  });
});

describe('metrics', () => {
  test('AUC is 1 for perfect ranking, 0.5 for a coin, and null with one class', () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 1, 0, 0])).toBe(0.5);
    expect(auc([0.5, 0.6], [1, 1])).toBeNull();
  });

  test('AUC ignores calibration — the same ranking scores the same', () => {
    const a = auc([0.9, 0.8, 0.2, 0.1], [1, 0, 1, 0]);
    const b = auc([0.09, 0.08, 0.02, 0.01], [1, 0, 1, 0]);
    expect(a).toBe(b);
  });

  test('Brier is 0 for perfect probabilities and 0.25 for a confident coin', () => {
    expect(brier([1, 0], [1, 0])).toBe(0);
    expect(brier([0.5, 0.5], [1, 0])).toBe(0.25);
  });

  test('log loss is finite even at 0 and 1', () => {
    const v = logLoss([1, 0, 0], [1, 0, 1]);
    expect(Number.isFinite(v!)).toBe(true);
    expect(v!).toBeGreaterThan(5); // one confident wrong answer is expensive
  });
});

describe('calibration', () => {
  test('ten buckets, each reporting what scores like it actually delivered', () => {
    const scores = [0.05, 0.15, 0.15, 0.95, 0.95, 0.95];
    const labels = [0, 0, 1, 1, 1, 0];
    const curve = calibrationCurve(scores, labels);
    expect(curve).toHaveLength(10);
    expect(curve[0]!.count).toBe(1);
    expect(curve[0]!.observedRate).toBe(0);
    expect(curve[1]!.count).toBe(2);
    expect(curve[1]!.observedRate).toBeCloseTo(0.5, 6);
    expect(curve[9]!.count).toBe(3);
    expect(curve[9]!.observedRate).toBeCloseTo(2 / 3, 6);
  });

  test('an empty bucket maps to NaN so serving falls through to the raw score', () => {
    const map = calibrationMap(calibrationCurve([0.05], [1]));
    expect(map[0]).toBe(1);
    expect(Number.isNaN(map[5]!)).toBe(true);
  });

  test('a score of exactly 1 lands in the last bucket, not off the end', () => {
    const curve = calibrationCurve([1], [1]);
    expect(curve[9]!.count).toBe(1);
  });
});
