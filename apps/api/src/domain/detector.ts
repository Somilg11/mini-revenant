/**
 * Anomaly detection — EWMA + z-score behind five gates (§7.3).
 *
 * PURE. No database, no clock, no network (§5).
 *
 * **Five gates instead of one threshold is the whole design.** A single
 * "failure rate above X" alarm fires on every quiet Tuesday morning when eight
 * attempts produce two failures, and on every unlabelled wobble in the data. The
 * gates are what keep precision up on the noise windows of §8.4, and precision
 * is what makes an alert worth reading.
 */

export interface Bucket {
  start: string;
  attempts: number;
  failures: number;
}

export interface DetectorConfig {
  /** 24 h of 5-minute buckets. */
  baselineBuckets: number;
  /** 30 min of separation, so the degradation cannot contaminate its own baseline. */
  baselineGapBuckets: number;
  evaluationBuckets: number;
  /** Must be bad for 2 of the last 3 buckets. */
  sustainedBuckets: number;
  /** Volume floor for the evaluation window. */
  minAttempts: number;
  minBaselineAttempts: number;
  /** +8 percentage points. */
  minAbsoluteLift: number;
  /** Nearly double the baseline. */
  minRelativeLift: number;
  minZScore: number;
  /** A bucket counts as "bad" at this fraction of the firing z-score. */
  sustainedZRatio: number;
  ewmaAlpha: number;
  /** 3 clean buckets closes the incident. */
  resolveBuckets: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  baselineBuckets: 288,
  baselineGapBuckets: 6,
  evaluationBuckets: 3,
  sustainedBuckets: 2,
  minAttempts: 20,
  minBaselineAttempts: 200,
  minAbsoluteLift: 0.08,
  minRelativeLift: 1.8,
  minZScore: 5.0,
  sustainedZRatio: 0.4,
  ewmaAlpha: 0.3,
  resolveBuckets: 3,
};

/** How many buckets of history `evaluate` needs before it can say anything. */
export function requiredBuckets(cfg: DetectorConfig): number {
  return cfg.baselineBuckets + cfg.baselineGapBuckets + cfg.evaluationBuckets;
}

export type GateName =
  | 'volume'
  | 'absolute_lift'
  | 'relative_lift'
  | 'z_score'
  | 'sustained';

export interface Gate {
  gate: GateName;
  passed: boolean;
  /** The measured value, and the threshold it was compared against. */
  value: number;
  threshold: number;
  detail: string;
}

export interface Verdict {
  anomalous: boolean;
  /** Every gate is evaluated; none short-circuits. A user needs the full picture. */
  gates: Gate[];
  reasons: string[];
  baselineRate: number;
  currentRate: number;
  smoothedRate: number;
  zScore: number;
  absoluteLift: number;
  relativeLift: number;
  attempts: number;
  failures: number;
  baselineAttempts: number;
  /** False when there is not yet enough history to judge — not the same as "fine". */
  evaluated: boolean;
}

function sum(buckets: readonly Bucket[]): { attempts: number; failures: number } {
  let attempts = 0;
  let failures = 0;
  for (const b of buckets) {
    attempts += b.attempts;
    failures += b.failures;
  }
  return { attempts, failures };
}

function rate(failures: number, attempts: number): number {
  return attempts === 0 ? 0 : failures / attempts;
}

/**
 * `z = (p̂ − p₀) / sqrt(p₀(1−p₀)/n)`
 *
 * A baseline of exactly zero would divide by zero, so it is floored at half an
 * observation over the baseline window — the smallest rate the data could have
 * distinguished from zero. Without that, one failure in a previously perfect
 * slice scores infinity and every gate below it becomes decoration.
 */
function zScore(observed: number, baseline: number, n: number, baselineAttempts: number): number {
  if (n === 0) return 0;
  const p0 = Math.max(baseline, baselineAttempts > 0 ? 0.5 / baselineAttempts : 1e-6);
  const variance = (p0 * (1 - p0)) / n;
  if (variance <= 0) return 0;
  return (observed - p0) / Math.sqrt(variance);
}

/** EWMA over the per-bucket rates, most recent weighted heaviest. */
function ewma(buckets: readonly Bucket[], alpha: number): number {
  let value = 0;
  let started = false;
  for (const b of buckets) {
    const r = rate(b.failures, b.attempts);
    if (!started) {
      value = r;
      started = true;
    } else {
      value = alpha * r + (1 - alpha) * value;
    }
  }
  return value;
}

/**
 * Evaluates the most recent window of a series.
 *
 * `series` is oldest-first. The layout is, reading backwards from the end:
 * `evaluationBuckets` of evaluation, then `baselineGapBuckets` of separation,
 * then `baselineBuckets` of baseline. The gap matters — without it the first
 * minutes of a degradation sit inside the baseline it is being compared to, and
 * the incident partly hides itself.
 */
export function evaluate(series: readonly Bucket[], cfg = DEFAULT_DETECTOR_CONFIG): Verdict {
  const need = requiredBuckets(cfg);
  const empty: Verdict = {
    anomalous: false,
    gates: [],
    reasons: ['insufficient history'],
    baselineRate: 0,
    currentRate: 0,
    smoothedRate: 0,
    zScore: 0,
    absoluteLift: 0,
    relativeLift: 0,
    attempts: 0,
    failures: 0,
    baselineAttempts: 0,
    evaluated: false,
  };
  if (series.length < need) return empty;

  const evalStart = series.length - cfg.evaluationBuckets;
  const evaluation = series.slice(evalStart);
  const baselineEnd = evalStart - cfg.baselineGapBuckets;
  const baseline = series.slice(Math.max(0, baselineEnd - cfg.baselineBuckets), baselineEnd);

  const e = sum(evaluation);
  const b = sum(baseline);

  const currentRate = rate(e.failures, e.attempts);
  const baselineRate = rate(b.failures, b.attempts);
  const smoothedRate = ewma(evaluation, cfg.ewmaAlpha);

  const absoluteLift = currentRate - baselineRate;
  const relativeLift = baselineRate === 0 ? (currentRate > 0 ? Infinity : 0) : currentRate / baselineRate;
  const z = zScore(currentRate, baselineRate, e.attempts, b.attempts);

  // Sustained-ness: a spike confined to one bucket is a blip. Each evaluation
  // bucket is scored on its own, and enough of them must be bad.
  const badBuckets = evaluation.filter((bucket) => {
    const r = rate(bucket.failures, bucket.attempts);
    return (
      bucket.attempts > 0 &&
      zScore(r, baselineRate, bucket.attempts, b.attempts) >= cfg.minZScore * cfg.sustainedZRatio
    );
  }).length;

  const gates: Gate[] = [
    {
      gate: 'volume',
      passed: e.attempts >= cfg.minAttempts && b.attempts >= cfg.minBaselineAttempts,
      value: e.attempts,
      threshold: cfg.minAttempts,
      detail: `${e.attempts} attempts in the window (need ${cfg.minAttempts}), ${b.attempts} in the baseline (need ${cfg.minBaselineAttempts})`,
    },
    {
      gate: 'absolute_lift',
      passed: absoluteLift >= cfg.minAbsoluteLift,
      value: absoluteLift,
      threshold: cfg.minAbsoluteLift,
      detail: `${(currentRate * 100).toFixed(1)}% against a ${(baselineRate * 100).toFixed(1)}% baseline — ${(absoluteLift * 100).toFixed(1)} points`,
    },
    {
      gate: 'relative_lift',
      passed: relativeLift >= cfg.minRelativeLift,
      value: Number.isFinite(relativeLift) ? relativeLift : 999,
      threshold: cfg.minRelativeLift,
      detail: `${Number.isFinite(relativeLift) ? relativeLift.toFixed(2) : '∞'}× the baseline`,
    },
    {
      gate: 'z_score',
      passed: z >= cfg.minZScore,
      value: z,
      threshold: cfg.minZScore,
      detail: `z = ${z.toFixed(1)} over ${e.attempts} attempts`,
    },
    {
      gate: 'sustained',
      passed: badBuckets >= cfg.sustainedBuckets,
      value: badBuckets,
      threshold: cfg.sustainedBuckets,
      detail: `bad in ${badBuckets} of the last ${cfg.evaluationBuckets} buckets`,
    },
  ];

  // Fire only if **every** gate passes.
  const anomalous = gates.every((g) => g.passed);

  return {
    anomalous,
    gates,
    reasons: gates.filter((g) => !g.passed).map((g) => `${g.gate}: ${g.detail}`),
    baselineRate,
    currentRate,
    smoothedRate,
    zScore: z,
    absoluteLift,
    relativeLift,
    attempts: e.attempts,
    failures: e.failures,
    baselineAttempts: b.attempts,
    evaluated: true,
  };
}

/**
 * An incident closes when the most recent buckets are back near the baseline it
 * opened against — not near the *current* baseline, which the incident itself
 * has already dragged upwards.
 */
export function isResolved(
  series: readonly Bucket[],
  baselineRate: number,
  cfg = DEFAULT_DETECTOR_CONFIG,
): boolean {
  if (series.length < cfg.resolveBuckets) return false;
  const recent = series.slice(-cfg.resolveBuckets);

  // A slice with no traffic at all is not evidence of recovery.
  const { attempts } = sum(recent);
  if (attempts === 0) return false;

  return recent.every((b) => {
    if (b.attempts === 0) return true;
    const r = rate(b.failures, b.attempts);
    return r - baselineRate < cfg.minAbsoluteLift;
  });
}
