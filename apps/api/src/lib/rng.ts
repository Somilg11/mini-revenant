/**
 * Seeded PRNG — mulberry32.
 *
 * The whole demo is reproducible from one integer: same seed ⇒ same dataset ⇒
 * same checksum, on any machine (§8.1). That is what makes "we detected 5 of 5
 * incidents" a claim somebody else can check rather than a screenshot.
 *
 * Determinism depends on the *order* draws are taken in, not just the seed, so
 * generator code must never reorder its calls to these methods without
 * expecting the checksum to change.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Picks by weight. Weights need not sum to 1. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, w] of items) total += w;
    let roll = this.next() * total;
    for (const [item, w] of items) {
      roll -= w;
      if (roll < 0) return item;
    }
    return items[items.length - 1]![0];
  }

  /** Standard normal, Box–Muller. */
  normal(): number {
    // u must be non-zero for the log.
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal with the given median and shape.
   *
   * Amounts are log-normal because payment amounts are (§8.1): a symmetric
   * distribution would make the high-value incident pattern meaningless, since
   * there would be no tail for it to live in.
   */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }
}
