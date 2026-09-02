/**
 * Display formatting (§11.1, §11.4).
 *
 * Presentation only. The *semantic* definitions — amount bands, metric
 * formulas — live once in the API's domain layer and are never duplicated
 * here; a band that means one thing on the dashboard and another in the
 * root-cause apportionment makes both untrustworthy. Turning paise into
 * "₹1,24,500" carries no such meaning, so it lives where it is rendered.
 */

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** `₹1,24,500` — Indian grouping, whole rupees, truncated so it never overstates. */
export function formatInr(paise: number): string {
  return `₹${INR.format(Math.trunc(paise / 100))}`;
}

/** `₹4.8L` — for tiles and chart axes. Money axes in ₹k / ₹L, never raw paise. */
export function formatInrCompact(paise: number): string {
  const rupees = paise / 100;
  const [divisor, suffix] =
    rupees >= 1_00_00_000 ? [1_00_00_000, 'Cr']
    : rupees >= 1_00_000 ? [1_00_000, 'L']
    : rupees >= 1_000 ? [1_000, 'k']
    : [1, ''];
  const scaled = rupees / divisor;
  const text = scaled < 100 && suffix !== '' ? scaled.toFixed(1) : Math.round(scaled).toString();
  return `₹${text.replace(/\.0$/, '')}${suffix}`;
}

/** A rate that has not been measured renders as `—`, never as `0%`. */
export function formatPct(rate: number | null, digits = 1): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(digits)}%`;
}

export function formatCount(n: number): string {
  return INR.format(n);
}

/** Exact paise, for the `title` attribute beside every rounded figure. */
export function exactPaise(paise: number): string {
  return `${INR.format(paise)} paise`;
}
