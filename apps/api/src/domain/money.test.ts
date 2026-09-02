import { describe, expect, test } from 'bun:test';
import {
  AMOUNT_BANDS,
  PAISE_PER_RUPEE,
  amountBand,
  assertPaise,
  formatInr,
  formatInrCompact,
  formatRate,
  isPaise,
  paiseToRupees,
  rate,
  rupeesToPaise,
  scalePaise,
  sumPaise,
  type Paise,
} from './money.ts';

const rupees = (r: number): Paise => r * PAISE_PER_RUPEE;

describe('paise are whole, non-negative integers', () => {
  test('isPaise accepts whole non-negative numbers', () => {
    expect(isPaise(0)).toBe(true);
    expect(isPaise(124500)).toBe(true);
  });

  test('isPaise rejects fractions, negatives and non-numbers', () => {
    expect(isPaise(1.5)).toBe(false);
    expect(isPaise(-1)).toBe(false);
    expect(isPaise(NaN)).toBe(false);
    expect(isPaise(Infinity)).toBe(false);
    expect(isPaise('100')).toBe(false);
  });

  test('assertPaise throws on a fractional amount rather than rounding silently', () => {
    expect(() => assertPaise(1.5)).toThrow(RangeError);
    expect(() => assertPaise(-100)).toThrow(RangeError);
  });

  test('a value past the safe integer range is refused', () => {
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe('conversion', () => {
  test('₹1 is 100 paise', () => {
    expect(rupeesToPaise(1)).toBe(100);
    expect(paiseToRupees(100)).toBe(1);
  });

  test('two decimal places round-trip', () => {
    expect(rupeesToPaise(1245.67)).toBe(124567);
  });

  test('float noise in the input is rounded away, not accumulated', () => {
    expect(rupeesToPaise(0.1 + 0.2)).toBe(30);
  });
});

describe('scalePaise — the only float allowed near money', () => {
  test('expected value lands back on whole paise', () => {
    const ev = scalePaise(rupees(4800), 0.359);
    expect(Number.isInteger(ev)).toBe(true);
    expect(ev).toBe(Math.round(480000 * 0.359));
  });

  test('a zero probability is zero, not a fraction', () => {
    expect(scalePaise(rupees(1000), 0)).toBe(0);
  });

  test('a negative factor is refused — money does not scale below zero here', () => {
    expect(() => scalePaise(rupees(100), -0.5)).toThrow(RangeError);
  });
});

describe('sumPaise stays in integers', () => {
  test('sums exactly', () => {
    expect(sumPaise([100, 250, 33])).toBe(383);
  });

  test('an empty sum is zero', () => {
    expect(sumPaise([])).toBe(0);
  });
});

describe('rate — computed from two integers, null when unmeasured', () => {
  test('divides its two integers', () => {
    expect(rate(280, 2140)).toBeCloseTo(0.1308, 4);
  });

  test('a zero denominator is null, not zero (invariant 6)', () => {
    // "Not measured" and "zero" are different claims. A rate over no
    // observations is the former, and printing 0 asserts the latter.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, 0)).toBeNull();
  });

  test('a zero numerator over real observations IS zero', () => {
    expect(rate(0, 100)).toBe(0);
  });

  test('formatRate renders an unmeasured rate as a dash', () => {
    expect(formatRate(0, 0)).toBe('—');
    expect(formatRate(280, 2140)).toBe('13.1%');
  });
});

describe('amount bands — §8.1, lower bound inclusive, exactly one band each', () => {
  const cases: [number, string][] = [
    [0, '<500'],
    [499_99, '<500'],
    [500_00, '500-2k'],
    [1_999_99, '500-2k'],
    [2_000_00, '2k-10k'],
    [9_999_99, '2k-10k'],
    [10_000_00, '10k-50k'],
    [49_999_99, '10k-50k'],
    [50_000_00, '>50k'],
    [1_00_000_00, '>50k'],
  ];

  for (const [paise, band] of cases) {
    test(`${paise} paise → ${band}`, () => {
      expect(amountBand(paise)).toBe(band as (typeof AMOUNT_BANDS)[number]);
    });
  }

  test('every band boundary is inclusive at its lower edge', () => {
    // ₹500 is the first amount in '500-2k', not the last in '<500'.
    expect(amountBand(rupees(500))).toBe('500-2k');
    expect(amountBand(rupees(500) - 1)).toBe('<500');
  });

  test('a sweep of amounts always lands in exactly one known band', () => {
    for (let r = 0; r <= 200_000; r += 137) {
      expect(AMOUNT_BANDS).toContain(amountBand(rupees(r)));
    }
  });

  test('there are exactly five bands', () => {
    expect(AMOUNT_BANDS).toEqual(['<500', '500-2k', '2k-10k', '10k-50k', '>50k']);
  });
});

describe('formatting — Indian grouping (§11.1)', () => {
  test('groups the Indian way: ₹1,24,500', () => {
    expect(formatInr(rupees(124500))).toBe('₹1,24,500');
  });

  test('small amounts need no grouping', () => {
    expect(formatInr(rupees(500))).toBe('₹500');
    expect(formatInr(0)).toBe('₹0');
  });

  test('truncates rather than rounds, so display never overstates the amount', () => {
    expect(formatInr(199)).toBe('₹1');
  });

  test('compact forms for chart axes: ₹k / ₹L / ₹Cr, never raw paise', () => {
    expect(formatInrCompact(rupees(999))).toBe('₹999');
    expect(formatInrCompact(rupees(4_800))).toBe('₹4.8k');
    expect(formatInrCompact(rupees(4_80_000))).toBe('₹4.8L');
    expect(formatInrCompact(rupees(18_40_000))).toBe('₹18.4L');
    expect(formatInrCompact(rupees(4_20_00_000))).toBe('₹4.2Cr');
  });

  test('a trailing .0 is trimmed', () => {
    expect(formatInrCompact(rupees(5_00_000))).toBe('₹5L');
  });
});
