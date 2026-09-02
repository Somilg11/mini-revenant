/**
 * Money — integer paise, and the amount bands shared across the system.
 *
 * PURE. No database, no clock, no network (§5).
 *
 * Invariant 5: money is integer paise. **No float arithmetic touches an
 * amount.** Rates are computed from two integers at the moment of display, and
 * never carried around as a rounded scalar that later gets multiplied by
 * something else. Every function here that can produce a fraction either
 * rounds to whole paise explicitly, or returns the two integers and lets the
 * caller divide.
 */

/**
 * Whole paise. ₹1 = 100 paise.
 *
 * A nominal type, so a rupee value cannot be passed where paise are expected —
 * that mistake is a factor-of-100 money bug and it is silent otherwise.
 */
export type Paise = number & { readonly __paise?: unique symbol };

export const PAISE_PER_RUPEE = 100;

/** True when `n` is a whole, finite, non-negative number of paise. */
export function isPaise(n: unknown): n is Paise {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Asserts a value really is whole paise.
 *
 * Called at the boundaries — anything arriving from the database, a webhook
 * payload or a generated dataset. A fractional amount reaching the arithmetic
 * below would violate invariant 5 quietly, so it fails loudly here instead.
 */
export function assertPaise(n: number, label = 'amount'): Paise {
  if (!isPaise(n)) {
    throw new RangeError(`${label} must be whole non-negative paise, got ${n}`);
  }
  return n;
}

/** Rupees → paise. Rounds, because a rupee input may carry two decimal places. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) throw new RangeError(`rupees must be finite, got ${rupees}`);
  return assertPaise(Math.round(rupees * PAISE_PER_RUPEE), 'rupees');
}

/**
 * Paise → rupees, as a float.
 *
 * **Display only.** The result must never be fed back into an amount
 * calculation; that is exactly the round-trip invariant 5 exists to prevent.
 */
export function paiseToRupees(paise: Paise): number {
  return paise / PAISE_PER_RUPEE;
}

/**
 * Scale an amount by a probability or a multiplier, returning whole paise.
 *
 * The single place a float is allowed near money, because expected value is
 * `probability × amount` and the result has to land back on an integer. Rounds
 * half away from zero, once, at the end.
 */
export function scalePaise(paise: Paise, factor: number): Paise {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new RangeError(`factor must be a finite non-negative number, got ${factor}`);
  }
  return Math.round(paise * factor);
}

/** Sum, staying in integer paise throughout. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const a of amounts) total += a;
  return assertPaise(total, 'sum');
}

/**
 * A rate computed from its two integers, at the moment of display.
 *
 * Returns `null` when the denominator is zero. Invariant 6: "not measured" and
 * "zero" are different claims, and a rate over no observations is the former.
 * Callers render `null` as `—` with a label, never as `0`.
 */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

// ── Amount bands ─────────────────────────────────────────────────────────────

/**
 * One definition, shared by analytics, RCA and the model (§8.1).
 *
 * Duplicating this is how a slice means one thing on the dashboard and another
 * in the root-cause apportionment, which makes both untrustworthy.
 */
export const AMOUNT_BANDS = ['<500', '500-2k', '2k-10k', '10k-50k', '>50k'] as const;

export type AmountBand = (typeof AMOUNT_BANDS)[number];

/**
 * Lower bound inclusive, upper bound exclusive, so every amount is in exactly
 * one band. Boundaries in paise; the labels are in rupees.
 *
 * Note the edge: ₹50,000 exactly falls in `>50k`, because the lower bound is
 * the inclusive one.
 */
const BAND_LOWER_BOUNDS_PAISE: readonly [AmountBand, number][] = [
  ['>50k', 50_000 * PAISE_PER_RUPEE],
  ['10k-50k', 10_000 * PAISE_PER_RUPEE],
  ['2k-10k', 2_000 * PAISE_PER_RUPEE],
  ['500-2k', 500 * PAISE_PER_RUPEE],
  ['<500', 0],
];

export function amountBand(paise: Paise): AmountBand {
  assertPaise(paise);
  for (const [band, lower] of BAND_LOWER_BOUNDS_PAISE) {
    if (paise >= lower) return band;
  }
  // Unreachable: the last bound is 0 and paise is non-negative.
  return '<500';
}

// ── Formatting ───────────────────────────────────────────────────────────────

const INR_GROUPING = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * `₹1,24,500` — Indian digit grouping, whole rupees (§11.1).
 *
 * Truncates rather than rounds, so a displayed figure is never larger than the
 * amount it represents. The exact paise value belongs in a `title` attribute
 * beside it, which is what makes every printed number checkable.
 */
export function formatInr(paise: Paise): string {
  assertPaise(paise);
  return `₹${INR_GROUPING.format(Math.trunc(paise / PAISE_PER_RUPEE))}`;
}

/**
 * `₹1.2L` / `₹4.8Cr` — for chart axes and tiles, where the exact figure is one
 * hover away. §11.4: money axes in ₹k / ₹L, never raw paise.
 */
export function formatInrCompact(paise: Paise): string {
  assertPaise(paise);
  const rupees = paise / PAISE_PER_RUPEE;
  const [divisor, suffix] =
    rupees >= 10_000_000 ? [10_000_000, 'Cr']
    : rupees >= 100_000 ? [100_000, 'L']
    : rupees >= 1_000 ? [1_000, 'k']
    : [1, ''];
  const scaled = rupees / divisor;
  // One decimal below 100 of a unit, none above — "₹4.8L" but "₹124k".
  const text = scaled < 100 && suffix !== '' ? scaled.toFixed(1) : Math.round(scaled).toString();
  // Trim a trailing ".0" so "₹5.0L" reads "₹5L".
  return `₹${text.replace(/\.0$/, '')}${suffix}`;
}

/** `20.7%` from its two integers, or `—` when there is nothing to divide. */
export function formatRate(numerator: number, denominator: number, digits = 1): string {
  const r = rate(numerator, denominator);
  return r === null ? '—' : `${(r * 100).toFixed(digits)}%`;
}
