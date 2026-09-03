/**
 * Root cause analysis — excess-failure apportionment (§7.4).
 *
 * PURE. No database, no clock, no network (§5).
 *
 * **Apportion excess failures, never total failures.** When a bank goes down,
 * UPI failures rise too, because UPI carries most of that bank's traffic. Total
 * failures name the *busiest* slice; excess failures name the slice that
 * *changed*. The naive answer to the cross-border incident is "cards are
 * failing", because cards carry the excess — apportioning excess is what turns
 * that into `international × card × THREEDS_FAILED`.
 */

/** One payment: whether it failed, and the slice it belongs to. */
export interface Observation {
  failed: boolean;
  dims: Readonly<Record<string, string | null>>;
}

export interface RcaConfig {
  /** Candidate dimensions, drawn 1 to 3 at a time. */
  dimensions: readonly string[];
  /**
   * Dimensions that only exist on a *failure*.
   *
   * `failure_code` is the case that matters: a successful payment has no code,
   * so counting attempts by code would make every such slice 100% failing.
   * Attempts are counted on the tuple's other dimensions, and the code narrows
   * only the numerator — which is exactly the claim being made, "the rate of
   * THREEDS_FAILED among international card attempts".
   */
  failureOnlyDimensions: readonly string[];
  maxTupleSize: number;
  /** Shrinkage toward the pooled rate. */
  shrinkK: number;
  /** Attempts at which the volume score saturates. */
  volumeSaturation: number;
  /** Tuples thinner than this are not worth a hypothesis. */
  minAttempts: number;
  maxHypotheses: number;
  /**
   * Values meaning "this dimension does not apply", not a real slice.
   *
   * International payments carry no bank, so `bank=none` identifies them
   * perfectly — and says nothing a human can act on. When two tuples cover the
   * same payments, the one without absence markers is the answer.
   */
  absenceValues: readonly string[];
  /**
   * A containing slice is dropped when a slice inside it already explains this
   * much of its excess. See the note on containment pruning below.
   */
  containmentThreshold: number;
}

export const DEFAULT_RCA_CONFIG: RcaConfig = {
  dimensions: [
    'bank',
    'method',
    'amount_band',
    'is_international',
    'card_network',
    'card_country',
    'failure_code',
  ],
  failureOnlyDimensions: ['failure_code'],
  maxTupleSize: 3,
  shrinkK: 30,
  volumeSaturation: 50,
  minAttempts: 8,
  maxHypotheses: 3,
  absenceValues: ['none', 'false'],
  containmentThreshold: 0.8,
};

export interface Hypothesis {
  /** The tuple itself, e.g. `{ is_international: 'true', method: 'card' }`. */
  tuple: Record<string, string>;
  label: string;

  attempts: number;
  failures: number;
  observedRate: number;
  /** The **shrunk** baseline — the same arithmetic the share came from (§7.4). */
  expectedRate: number;
  baselineAttempts: number;
  baselineFailures: number;

  excess: number;
  excessShare: number;
  specificity: number;
  zScore: number;
  volumeScore: number;
  confidence: number;

  /** Everything in the window that is *not* this tuple — the comparison group. */
  restAttempts: number;
  restFailures: number;
  restRate: number;
}

export interface RcaResult {
  hypotheses: Hypothesis[];
  incidentExcess: number;
  windowAttempts: number;
  windowFailures: number;
  pooledRate: number;
  /** True when no slice had history and the window compared against itself. */
  usedWindowAsReference: boolean;
}

function rate(failures: number, attempts: number): number {
  return attempts === 0 ? 0 : failures / attempts;
}

/** All combinations of `dims` of size 1..max, as arrays of dimension names. */
function combinations(dims: readonly string[], max: number): string[][] {
  const out: string[][] = [];
  const walk = (start: number, current: string[]) => {
    if (current.length > 0) out.push([...current]);
    if (current.length === max) return;
    for (let i = start; i < dims.length; i += 1) {
      current.push(dims[i]!);
      walk(i + 1, current);
      current.pop();
    }
  };
  walk(0, []);
  return out;
}

function keyOf(names: readonly string[], values: readonly (string | null)[]): string | null {
  const parts: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const v = values[i];
    if (v === null || v === undefined) return null;
    parts.push(`${names[i]}=${v}`);
  }
  return parts.join(' × ');
}

/**
 * Two-proportion z-test of a tuple against **the rest of the same window**.
 *
 * Not against its own history, and that is the whole trick: during a
 * gateway-wide outage every slice looks terrible against history, so comparing
 * slices to their own past ranks them all equally guilty. Comparing them to
 * each other finds the one that actually changed.
 */
function twoProportionZ(f1: number, n1: number, f2: number, n2: number): number {
  if (n1 === 0 || n2 === 0) return 0;
  const p1 = f1 / n1;
  const p2 = f2 / n2;
  const pooled = (f1 + f2) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (p1 - p2) / se;
}

export function analyse(
  window: readonly Observation[],
  baseline: readonly Observation[],
  cfg: RcaConfig = DEFAULT_RCA_CONFIG,
): RcaResult {
  const windowAttempts = window.length;
  const windowFailures = window.filter((o) => o.failed).length;

  const baselineAttemptsTotal = baseline.length;
  const baselineFailuresTotal = baseline.filter((o) => o.failed).length;

  // If nothing has history, the window's own failure rate is the reference
  // (§7.4). It is a weaker comparison and the result says so.
  const usedWindowAsReference = baselineAttemptsTotal === 0;
  const pooledRate = usedWindowAsReference
    ? rate(windowFailures, windowAttempts)
    : rate(baselineFailuresTotal, baselineAttemptsTotal);

  const failureOnly = new Set(cfg.failureOnlyDimensions);

  /** Counts a tuple across a set of observations. */
  function count(
    observations: readonly Observation[],
    names: readonly string[],
    values: readonly string[],
  ): { attempts: number; failures: number; signature: string; cover: Uint32Array } {
    const attemptNames: string[] = [];
    const attemptValues: string[] = [];
    for (let i = 0; i < names.length; i += 1) {
      if (!failureOnly.has(names[i]!)) {
        attemptNames.push(names[i]!);
        attemptValues.push(values[i]!);
      }
    }

    let attempts = 0;
    let failures = 0;
    // A cheap order-sensitive hash of exactly which observations matched, so
    // two differently-named tuples covering the same payments can be spotted.
    let hAttempts = 2166136261;
    let hFailures = 2166136261;
    // Which observations this tuple covers, as a bitset — needed for the
    // containment test below, which a hash cannot answer.
    const cover = new Uint32Array(Math.ceil(observations.length / 32) || 1);
    let index = -1;
    for (const o of observations) {
      index += 1;
      // Attempts ignore failure-only dimensions, which do not exist on a success.
      let inAttemptSlice = true;
      for (let i = 0; i < attemptNames.length; i += 1) {
        if (o.dims[attemptNames[i]!] !== attemptValues[i]) {
          inAttemptSlice = false;
          break;
        }
      }
      if (!inAttemptSlice) continue;
      attempts += 1;
      hAttempts = Math.imul(hAttempts ^ index, 16777619);
      cover[index >>> 5]! |= 1 << (index & 31);

      if (!o.failed) continue;
      let inFullSlice = true;
      for (let i = 0; i < names.length; i += 1) {
        if (o.dims[names[i]!] !== values[i]) {
          inFullSlice = false;
          break;
        }
      }
      if (inFullSlice) {
        failures += 1;
        hFailures = Math.imul(hFailures ^ index, 16777619);
      }
    }
    return { attempts, failures, signature: `${hAttempts >>> 0}:${hFailures >>> 0}`, cover };
  }

  /** `excess = observed − attempts × expected`, with the shrunk expected rate. */
  function excessOf(attempts: number, failures: number, bAttempts: number, bFailures: number) {
    const expectedRate = (bFailures + cfg.shrinkK * pooledRate) / (bAttempts + cfg.shrinkK);
    return { expectedRate, excess: failures - attempts * expectedRate };
  }

  const overall = excessOf(
    windowAttempts,
    windowFailures,
    baselineAttemptsTotal,
    baselineFailuresTotal,
  );
  const incidentExcess = overall.excess;

  // Enumerate only the tuples that actually occur in the window — the cross
  // product of every dimension's values would be mostly empty slices.
  const seen = new Set<string>();
  const candidates: {
    signature: string;
    absenceCount: number;
    size: number;
    cover: Uint32Array;
    hypothesis: Hypothesis;
  }[] = [];

  for (const names of combinations(cfg.dimensions, cfg.maxTupleSize)) {
    const values = new Set<string>();
    for (const o of window) {
      const k = keyOf(names, names.map((n) => o.dims[n] ?? null));
      if (k !== null) values.add(k);
    }

    for (const label of values) {
      if (seen.has(label)) continue;
      seen.add(label);

      const tupleValues = label.split(' × ').map((p) => p.slice(p.indexOf('=') + 1));
      const w = count(window, names, tupleValues);
      if (w.attempts < cfg.minAttempts || w.failures === 0) continue;
      // A tuple covering the whole window explains nothing about *which* slice.
      if (w.attempts === windowAttempts && names.length === 1 && values.size === 1) continue;

      const b = count(baseline, names, tupleValues);
      const { expectedRate, excess } = excessOf(w.attempts, w.failures, b.attempts, b.failures);
      if (excess <= 0) continue;

      const restAttempts = windowAttempts - w.attempts;
      const restFailures = windowFailures - w.failures;
      const observedRate = rate(w.failures, w.attempts);
      const restRate = rate(restFailures, restAttempts);

      // How clean is everything else? A tuple that is bad while the rest is
      // fine scores near 1; one that is bad along with everything else scores 0.
      const specificity =
        observedRate <= 0 ? 0 : Math.max(0, Math.min(1, 1 - restRate / observedRate));

      const z = twoProportionZ(w.failures, w.attempts, restFailures, restAttempts);
      const volumeScore = Math.min(1, w.attempts / cfg.volumeSaturation);
      const excessShare =
        incidentExcess <= 0 ? 0 : Math.max(0, Math.min(1, excess / incidentExcess));

      const confidence =
        0.4 * excessShare + 0.25 * specificity + 0.2 * Math.min(1, Math.max(0, z) / 6) + 0.15 * volumeScore;

      const tuple: Record<string, string> = {};
      names.forEach((n, i) => (tuple[n] = tupleValues[i]!));

      const absent = new Set(cfg.absenceValues);
      const absenceCount = tupleValues.filter((v) => absent.has(v)).length;

      candidates.push({
        signature: w.signature,
        absenceCount,
        size: names.length,
        cover: w.cover,
        hypothesis: {
        tuple,
        label,
        attempts: w.attempts,
        failures: w.failures,
        observedRate,
        expectedRate,
        baselineAttempts: b.attempts,
        baselineFailures: b.failures,
        excess,
        excessShare,
        specificity,
        zScore: z,
        volumeScore,
        confidence,
          restAttempts,
          restFailures,
          restRate,
        },
      });
    }
  }

  /**
   * Collapse tuples covering identical payments.
   *
   * Several names describe one slice — `bank=none`, `method=card × bank=none`,
   * `bank=none × card_country=US` — and they tie on every score because they
   * are the same payments. Offering three of them as "the top three
   * hypotheses" tells a reader nothing. Keep the one a human can act on:
   * fewest absence markers first, then the fewest dimensions needed to say it.
   */
  const bySet = new Map<string, (typeof candidates)[number]>();
  for (const c of candidates) {
    const existing = bySet.get(c.signature);
    if (
      !existing ||
      c.absenceCount < existing.absenceCount ||
      (c.absenceCount === existing.absenceCount && c.size < existing.size)
    ) {
      bySet.set(c.signature, c);
    }
  }

  /**
   * Containment pruning — the step that stops RCA naming the region rather than
   * the cause.
   *
   * `is_international=false` contains every HDFC payment, so during a bank
   * outage its 24% failure rate *is* HDFC's 76% diluted across five times the
   * traffic. It scores identically on excess share and better on volume — which
   * saturates at 50 attempts and therefore only ever penalises small slices —
   * so the broad region outranks the thing that actually broke. That is
   * precisely the failure §7.4 opens by describing: "total failures name the
   * busiest slice; excess failures name the slice that changed".
   *
   * A containing slice is dropped when a slice inside it already accounts for
   * most of its excess on less traffic: it explains nothing the narrower one
   * does not, and it points at the wrong thing.
   */
  const kept = [...bySet.values()];
  const covers = (outer: Uint32Array, inner: Uint32Array): boolean => {
    for (let i = 0; i < outer.length; i += 1) {
      if ((inner[i]! & ~outer[i]!) !== 0) return false;
    }
    return true;
  };

  const surviving = kept.filter((broad) =>
    !kept.some(
      (narrow) =>
        narrow !== broad &&
        narrow.hypothesis.attempts < broad.hypothesis.attempts &&
        narrow.hypothesis.excess >= broad.hypothesis.excess * cfg.containmentThreshold &&
        covers(broad.cover, narrow.cover),
    ),
  );

  const hypotheses = surviving
    .map((c) => c.hypothesis)
    .sort((a, b) => b.confidence - a.confidence || b.excess - a.excess);

  return {
    hypotheses: hypotheses.slice(0, cfg.maxHypotheses),
    incidentExcess,
    windowAttempts,
    windowFailures,
    pooledRate,
    usedWindowAsReference,
  };
}
