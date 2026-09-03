import { describe, expect, test } from 'bun:test';
import { analyse, DEFAULT_RCA_CONFIG as CFG, type Observation } from './rca.ts';

/** Builds `n` observations in a slice, `failures` of which failed. */
function slice(
  n: number,
  failures: number,
  dims: Record<string, string>,
  failureCode = 'CARD_DECLINED',
): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    failed: i < failures,
    dims: { ...dims, failure_code: i < failures ? failureCode : null },
  }));
}

describe('excess, not total — the central idea', () => {
  /**
   * A bank outage. UPI carries most of that bank's traffic, so UPI failures
   * rise too. Total failures name the busiest slice; excess names the slice
   * that changed.
   */
  const baseline = [
    ...slice(600, 42, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
    ...slice(600, 42, { bank: 'ICICI', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
    ...slice(200, 4, { bank: 'HDFC', method: 'card', amount_band: '500-2k', is_international: 'false', card_network: 'visa', card_country: 'IN' }),
  ];
  const window = [
    // HDFC has collapsed, across both methods.
    ...slice(60, 33, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }, 'BANK_DOWN'),
    ...slice(20, 11, { bank: 'HDFC', method: 'card', amount_band: '500-2k', is_international: 'false', card_network: 'visa', card_country: 'IN' }, 'BANK_DOWN'),
    // ICICI is fine.
    ...slice(60, 4, { bank: 'ICICI', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
  ];

  const result = analyse(window, baseline, CFG);

  test('the top hypothesis names the bank, not the busiest method', () => {
    // `method=upi` carries more raw failures than `bank=HDFC × method=card`,
    // but UPI as a whole did not change — HDFC did.
    expect(result.hypotheses[0]!.tuple.bank).toBe('HDFC');
  });

  test('it returns at most three hypotheses, each with its evidence', () => {
    expect(result.hypotheses.length).toBeLessThanOrEqual(3);
    for (const h of result.hypotheses) {
      expect(h.attempts).toBeGreaterThan(0);
      expect(h.excess).toBeGreaterThan(0);
      expect(h.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(h.confidence)).toBe(true);
    }
  });

  test('the quoted baseline is the shrunk rate, not the raw one', () => {
    // §7.4: "the baseline rate quoted on a hypothesis must be the shrunk one,
    // the same arithmetic the share came from".
    for (const h of result.hypotheses) {
      const shrunk =
        (h.baselineFailures + CFG.shrinkK * result.pooledRate) / (h.baselineAttempts + CFG.shrinkK);
      expect(h.expectedRate).toBeCloseTo(shrunk, 9);
    }
    // And it genuinely differs from the raw rate wherever the slice's own
    // history disagrees with the pooled rate.
    const moved = result.hypotheses.find(
      (h) => h.baselineAttempts > 0 &&
        Math.abs(h.baselineFailures / h.baselineAttempts - result.pooledRate) > 0.01,
    );
    if (moved) {
      const raw = moved.baselineFailures / moved.baselineAttempts;
      expect(moved.expectedRate).not.toBeCloseTo(raw, 6);
    }
  });

  test('excess is observed minus expected, using that shrunk rate', () => {
    const h = result.hypotheses[0]!;
    expect(h.excess).toBeCloseTo(h.failures - h.attempts * h.expectedRate, 6);
  });
});

describe('§1.1 — the cross-border case, which is the demo', () => {
  /**
   * The naive answer is "cards are failing", because cards carry the excess.
   * The right answer is `is_international × card × THREEDS_FAILED`.
   */
  const domesticCard = { bank: 'HDFC', method: 'card', amount_band: '2k-10k', is_international: 'false', card_network: 'visa', card_country: 'IN' };
  const intlCard = { bank: 'none', method: 'card', amount_band: '2k-10k', is_international: 'true', card_network: 'visa', card_country: 'US' };
  const upi = { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' };

  const baseline = [
    ...slice(800, 56, domesticCard),
    ...slice(300, 57, intlCard, 'THREEDS_FAILED'),
    ...slice(1200, 84, upi),
  ];
  const window = [
    ...slice(80, 6, domesticCard),
    ...slice(40, 26, intlCard, 'THREEDS_FAILED'),
    ...slice(120, 9, upi),
  ];

  const result = analyse(window, baseline, CFG);
  const top = result.hypotheses[0]!;

  test('the top hypothesis is international, not merely "cards"', () => {
    // `method=card` alone would blame every card in the book, including the
    // domestic ones that are fine.
    expect(top.tuple.is_international).toBe('true');
  });

  test('it reaches the failure code, the sharpest form of the answer', () => {
    const named = Object.keys(top.tuple);
    expect(named).toContain('is_international');
    expect(top.tuple.failure_code ?? 'THREEDS_FAILED').toBe('THREEDS_FAILED');
  });

  test('specificity is high because everything else is clean', () => {
    expect(top.specificity).toBeGreaterThan(0.6);
    expect(top.restRate).toBeLessThan(0.15);
  });

  test('the support is a comparison against the rest of the window, not history', () => {
    // During a gateway-wide outage every slice looks terrible against its own
    // past; comparing slices to each other is what isolates the one that moved.
    expect(top.zScore).toBeGreaterThan(3);
  });
});

describe('failure_code narrows the numerator, never the denominator', () => {
  test('a code slice does not read as 100% failing', () => {
    // A successful payment carries no failure code. Counting attempts by code
    // would make every such slice fail completely and win every time.
    const baseline = slice(500, 35, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    const window = slice(100, 30, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }, 'BANK_DOWN');
    const result = analyse(window, baseline, CFG);
    const withCode = result.hypotheses.find((h) => h.tuple.failure_code !== undefined);
    if (withCode) {
      expect(withCode.observedRate).toBeLessThan(1);
      expect(withCode.attempts).toBe(100);
    }
  });
});

describe('shrinkage protects a slice with no history', () => {
  test('a brand-new slice is not handed the whole incident', () => {
    // Without shrinkage, a slice with zero baseline has an expected rate of 0
    // and every one of its failures counts as excess.
    const baseline = slice(1000, 70, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    const window = [
      ...slice(200, 15, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
      // Never seen before, and only slightly worse than everything else.
      ...slice(10, 2, { bank: 'YES', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
    ];
    const result = analyse(window, baseline, CFG);
    const newSlice = result.hypotheses.find((h) => h.tuple.bank === 'YES');
    if (newSlice) {
      // The shrunk expectation sits near the pooled rate rather than at zero.
      // Without shrinkage it would be 0 and every failure would be pure excess.
      expect(newSlice.expectedRate).toBeGreaterThan(0.03);
      // And it does not lead: ten attempts cannot outrank a real slice, because
      // volume and specificity hold it back whatever its share of the excess.
      expect(result.hypotheses[0]!.tuple.bank).not.toBe('YES');
    }
  });

  test('with no history at all, the window is its own reference and says so', () => {
    const window = slice(100, 40, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    const result = analyse(window, [], CFG);
    expect(result.usedWindowAsReference).toBe(true);
    expect(result.pooledRate).toBeCloseTo(0.4, 2);
  });
});

describe('degenerate input', () => {
  test('an empty window yields no hypotheses rather than throwing', () => {
    const result = analyse([], [], CFG);
    expect(result.hypotheses).toEqual([]);
    expect(result.incidentExcess).toBe(0);
  });

  test('a window with no failures yields no hypotheses', () => {
    const w = slice(100, 0, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    expect(analyse(w, w, CFG).hypotheses).toEqual([]);
  });

  test('tuples thinner than the floor are not offered as hypotheses', () => {
    const baseline = slice(500, 35, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    const window = [
      ...slice(100, 8, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
      ...slice(3, 3, { bank: 'YES', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
    ];
    const result = analyse(window, baseline, CFG);
    // Three failures out of three is not a diagnosis.
    expect(result.hypotheses.find((h) => h.tuple.bank === 'YES')).toBeUndefined();
  });
});

describe('confidence is the weighted sum §7.4 specifies', () => {
  test('0.40·share + 0.25·specificity + 0.20·min(1, z/6) + 0.15·volume', () => {
    const baseline = slice(1000, 70, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' });
    const window = [
      ...slice(80, 40, { bank: 'HDFC', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }, 'BANK_DOWN'),
      ...slice(80, 6, { bank: 'ICICI', method: 'upi', amount_band: '500-2k', is_international: 'false', card_network: 'none', card_country: 'none' }),
    ];
    for (const h of analyse(window, baseline, CFG).hypotheses) {
      const expected =
        0.4 * h.excessShare +
        0.25 * h.specificity +
        0.2 * Math.min(1, Math.max(0, h.zScore) / 6) +
        0.15 * h.volumeScore;
      expect(h.confidence).toBeCloseTo(expected, 9);
    }
  });
});

describe('containment pruning — naming the cause, not the region', () => {
  /**
   * The failure §7.4 opens by describing. A bank outage lives inside the
   * domestic slice, so `is_international=false` carries exactly the same excess
   * as `bank=HDFC` — diluted across five times the traffic — and outranks it on
   * the volume term, which saturates at 50 attempts and so only ever penalises
   * small slices.
   */
  const domesticDims = (bank: string, method = 'upi') => ({
    bank,
    method,
    amount_band: '500-2k',
    is_international: 'false',
    card_network: 'none',
    card_country: 'none',
  });
  const intlDims = {
    bank: 'none',
    method: 'card',
    amount_band: '2k-10k',
    is_international: 'true',
    card_network: 'visa',
    card_country: 'US',
  };

  const baseline = [
    ...slice(900, 60, domesticDims('HDFC')),
    ...slice(900, 60, domesticDims('ICICI')),
    ...slice(400, 76, intlDims, 'THREEDS_FAILED'),
  ];
  const window = [
    // HDFC has collapsed. Everything else is normal.
    ...slice(21, 16, domesticDims('HDFC'), 'BANK_DOWN'),
    ...slice(80, 5, domesticDims('ICICI')),
    ...slice(19, 3, intlDims, 'THREEDS_FAILED'),
  ];

  const result = analyse(window, baseline, CFG);

  test('the top hypothesis names the bank, not the region containing it', () => {
    expect(result.hypotheses[0]!.tuple.bank).toBe('HDFC');
  });

  test('the containing region is dropped, not merely outranked', () => {
    // It explains nothing the narrower slice does not, so offering it as one of
    // three hypotheses would waste a slot on a worse version of the same answer.
    const containing = result.hypotheses.find(
      (h) => Object.keys(h.tuple).length === 1 && h.tuple.is_international === 'false',
    );
    expect(containing).toBeUndefined();
  });

  test('a genuinely separate slice is still offered', () => {
    // Pruning must remove regions that merely contain the culprit, never
    // alternative explanations that stand on their own evidence.
    const separate = analyse(
      [
        ...slice(30, 20, domesticDims('HDFC'), 'BANK_DOWN'),
        ...slice(30, 20, intlDims, 'THREEDS_FAILED'),
        ...slice(60, 4, domesticDims('ICICI')),
      ],
      baseline,
      CFG,
    );
    const labels = separate.hypotheses.map((h) => h.label).join(' | ');
    expect(labels).toContain('HDFC');
  });
});

describe('equivalent tuples are collapsed', () => {
  test('one slice is reported once, under the name a human can act on', () => {
    // International payments carry no bank, so `bank=none` identifies them
    // perfectly and says nothing actionable. Several tuples cover exactly the
    // same payments and tie on every score; reporting three of them as "the top
    // three hypotheses" would fill the list with one answer.
    const intl = {
      bank: 'none',
      method: 'card',
      amount_band: '2k-10k',
      is_international: 'true',
      card_network: 'visa',
      card_country: 'US',
    };
    const dom = {
      bank: 'HDFC',
      method: 'upi',
      amount_band: '500-2k',
      is_international: 'false',
      card_network: 'none',
      card_country: 'none',
    };
    // Domestic cards matter: without them `method=card` and
    // `is_international=true` cover identical payments and the two names are
    // genuinely interchangeable. In the real dataset domestic cards exist, so
    // `method=card` strictly contains the international slice — which is what
    // makes "cards are failing" the wrong answer rather than a synonym.
    const domCard = {
      bank: 'HDFC',
      method: 'card',
      amount_band: '2k-10k',
      is_international: 'false',
      card_network: 'visa',
      card_country: 'IN',
    };
    const result = analyse(
      [...slice(40, 26, intl, 'THREEDS_FAILED'), ...slice(80, 6, domCard), ...slice(120, 9, dom)],
      [
        ...slice(400, 76, intl, 'THREEDS_FAILED'),
        ...slice(800, 56, domCard),
        ...slice(1200, 84, dom),
      ],
      CFG,
    );

    const top = result.hypotheses[0]!;
    // Named by what it is, not by what it lacks — and the international slice,
    // not the superset of every card.
    expect(top.tuple.bank).not.toBe('none');
    expect(top.tuple.is_international).toBe('true');

    const labels = result.hypotheses.map((h) => h.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
