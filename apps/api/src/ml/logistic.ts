/**
 * Logistic regression, calibration and the evaluation metrics (§7.5).
 *
 * PURE. Takes arrays, returns arrays. Deliberately no dependency on the
 * feature encoding: that lives in `domain/recovery-model.ts` and is shared with
 * serving, which is the whole point — a second encoding here would be the skew
 * §7.5 warns about, and it would be silent.
 */

export interface FitOptions {
  epochs: number;
  learningRate: number;
  l2: number;
}

export const DEFAULT_FIT: FitOptions = { epochs: 400, learningRate: 0.1, l2: 1e-4 };

export interface Standardisation {
  means: number[];
  stdDevs: number[];
}

/**
 * Means and standard deviations, from the **training split only**.
 *
 * Computing them over everything leaks the test distribution into the model
 * — mildly, but it is the kind of leak that makes every reported metric a
 * little better than the truth. A zero standard deviation (a constant column)
 * is left at 1 so the column standardises to 0 rather than NaN.
 */
export function standardisation(X: readonly (readonly number[])[]): Standardisation {
  const d = X[0]?.length ?? 0;
  const means = new Array<number>(d).fill(0);
  const stdDevs = new Array<number>(d).fill(0);
  if (X.length === 0) return { means, stdDevs: stdDevs.fill(1) };

  for (const row of X) for (let j = 0; j < d; j += 1) means[j]! += row[j]!;
  for (let j = 0; j < d; j += 1) means[j]! /= X.length;

  for (const row of X) {
    for (let j = 0; j < d; j += 1) {
      const diff = row[j]! - means[j]!;
      stdDevs[j]! += diff * diff;
    }
  }
  for (let j = 0; j < d; j += 1) {
    const sd = Math.sqrt(stdDevs[j]! / X.length);
    stdDevs[j] = sd === 0 || !Number.isFinite(sd) ? 1 : sd;
  }
  return { means, stdDevs };
}

export function standardise(
  X: readonly (readonly number[])[],
  s: Standardisation,
): number[][] {
  return X.map((row) => row.map((v, j) => (v - s.means[j]!) / s.stdDevs[j]!));
}

function sigmoid(z: number): number {
  // Clamp so exp() never overflows to Infinity and the gradient stays finite.
  const c = Math.max(-35, Math.min(35, z));
  return 1 / (1 + Math.exp(-c));
}

export interface Fitted {
  weights: number[];
  intercept: number;
  /** Training loss per epoch, so a divergent fit is visible rather than silent. */
  lossHistory: number[];
}

/**
 * Batch gradient descent with L2 on the weights (not the intercept).
 *
 * Four hundred epochs at lr 0.1 on standardised inputs is enough for a convex
 * problem this size to converge; the loss history is returned so a caller can
 * see that it did, rather than trusting that it must have.
 */
export function fitLogistic(
  X: readonly (readonly number[])[],
  y: readonly number[],
  opts: FitOptions = DEFAULT_FIT,
): Fitted {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (n === 0 || n !== y.length) {
    throw new RangeError(`fitLogistic: ${n} rows against ${y.length} labels`);
  }

  const w = new Array<number>(d).fill(0);
  let b = 0;
  const lossHistory: number[] = [];

  for (let epoch = 0; epoch < opts.epochs; epoch += 1) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    let loss = 0;

    for (let i = 0; i < n; i += 1) {
      const row = X[i]!;
      let z = b;
      for (let j = 0; j < d; j += 1) z += w[j]! * row[j]!;
      const p = sigmoid(z);
      const err = p - y[i]!;
      for (let j = 0; j < d; j += 1) gw[j]! += err * row[j]!;
      gb += err;
      const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
      loss -= y[i]! * Math.log(pc) + (1 - y[i]!) * Math.log(1 - pc);
    }

    for (let j = 0; j < d; j += 1) {
      w[j] = w[j]! - opts.learningRate * (gw[j]! / n + opts.l2 * w[j]!);
    }
    b -= opts.learningRate * (gb / n);
    lossHistory.push(loss / n);
  }

  return { weights: w, intercept: b, lossHistory };
}

export function predictProba(
  X: readonly (readonly number[])[],
  model: { weights: readonly number[]; intercept: number },
): number[] {
  return X.map((row) => {
    let z = model.intercept;
    for (let j = 0; j < row.length; j += 1) z += model.weights[j]! * row[j]!;
    return sigmoid(z);
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * AUC by the Mann–Whitney statistic: the probability that a random positive
 * outranks a random negative, ties counting half. Rank-based, so it does not
 * care about calibration — which is why Brier is reported beside it.
 */
export function auc(scores: readonly number[], labels: readonly number[]): number | null {
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i += 1) (labels[i] === 1 ? pos : neg).push(scores[i]!);
  if (pos.length === 0 || neg.length === 0) return null;

  const sortedNeg = [...neg].sort((a, b) => a - b);
  let sum = 0;
  for (const p of pos) {
    // Count negatives strictly below, and ties at half.
    const below = lowerBound(sortedNeg, p);
    const upTo = upperBound(sortedNeg, p);
    sum += below + (upTo - below) * 0.5;
  }
  return sum / (pos.length * neg.length);
}

function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mean squared error between probability and outcome. Lower is better; 0.25 is a coin. */
export function brier(scores: readonly number[], labels: readonly number[]): number | null {
  if (scores.length === 0) return null;
  let s = 0;
  for (let i = 0; i < scores.length; i += 1) s += (scores[i]! - labels[i]!) ** 2;
  return s / scores.length;
}

export function logLoss(scores: readonly number[], labels: readonly number[]): number | null {
  if (scores.length === 0) return null;
  let s = 0;
  for (let i = 0; i < scores.length; i += 1) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, scores[i]!));
    s -= labels[i]! * Math.log(p) + (1 - labels[i]!) * Math.log(1 - p);
  }
  return s / scores.length;
}

// ── Calibration ──────────────────────────────────────────────────────────────

export interface CalibrationBucket {
  /** Bucket bounds on the predicted axis. */
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

/**
 * Ten equal-width buckets on the predicted probability, each mapping to the
 * rate actually observed in it (§7.5). Rendered as the calibration curve, and
 * used as a lookup at serve time to pull a raw score toward what scores like it
 * actually delivered.
 */
export function calibrationCurve(
  scores: readonly number[],
  labels: readonly number[],
  buckets = 10,
): CalibrationBucket[] {
  const out: CalibrationBucket[] = Array.from({ length: buckets }, (_, i) => ({
    lower: i / buckets,
    upper: (i + 1) / buckets,
    count: 0,
    meanPredicted: null,
    observedRate: null,
  }));
  const sumPred = new Array<number>(buckets).fill(0);
  const sumObs = new Array<number>(buckets).fill(0);

  for (let i = 0; i < scores.length; i += 1) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(scores[i]! * buckets)));
    out[idx]!.count += 1;
    sumPred[idx]! += scores[i]!;
    sumObs[idx]! += labels[i]!;
  }
  for (let i = 0; i < buckets; i += 1) {
    const b = out[i]!;
    if (b.count > 0) {
      b.meanPredicted = sumPred[i]! / b.count;
      b.observedRate = sumObs[i]! / b.count;
    }
  }
  return out;
}

/**
 * The serve-time lookup: one observed rate per bucket.
 *
 * An empty bucket is left as NaN so `applyCalibration` falls through to the
 * raw score rather than mapping every prediction in that range to a number
 * nobody observed.
 */
export function calibrationMap(curve: readonly CalibrationBucket[]): number[] {
  return curve.map((b) => (b.observedRate === null ? Number.NaN : b.observedRate));
}
