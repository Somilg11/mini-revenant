import { describe, expect, test } from 'bun:test';
import {
  FAILURE_FAMILIES,
  KNOWN_FAILURE_CODES,
  failureFamily,
  isRouteFailure,
  isUnactionable,
  type FailureFamily,
} from './failure-codes.ts';

/** §7.2, transcribed from the spec table rather than from the implementation. */
const SPEC_TABLE: Record<Exclude<FailureFamily, 'UNKNOWN'>, string[]> = {
  TRANSIENT: ['GATEWAY_ERROR', 'BANK_DOWN', 'PAYMENT_TIMEOUT', 'NETWORK_ERROR'],
  CUSTOMER: [
    'INSUFFICIENT_FUNDS',
    'CARD_EXPIRED',
    'CARD_DECLINED',
    'INCORRECT_OTP',
    'PAYMENT_LIMIT_EXCEEDED',
  ],
  TERMINAL: ['FRAUD_SUSPECTED', 'INVALID_ACCOUNT'],
  ABANDONMENT: ['CHECKOUT_ABANDONED'],
  CROSS_BORDER: [
    'THREEDS_FAILED',
    'THREEDS_NOT_SUPPORTED',
    'INTERNATIONAL_CARD_BLOCKED',
    'ISSUER_DECLINED_CROSS_BORDER',
    'CURRENCY_NOT_SUPPORTED',
  ],
};

describe('failureFamily — every code in the §7.2 table', () => {
  for (const [family, codes] of Object.entries(SPEC_TABLE)) {
    for (const code of codes) {
      test(`${code} → ${family}`, () => {
        expect(failureFamily(code)).toBe(family as FailureFamily);
      });
    }
  }

  test('the implementation knows exactly the codes the spec lists', () => {
    expect([...KNOWN_FAILURE_CODES].sort()).toEqual(Object.values(SPEC_TABLE).flat().sort());
  });
});

describe('UNKNOWN means ask a human, never retry', () => {
  test('an unrecognised code is UNKNOWN', () => {
    expect(failureFamily('SOMETHING_NEW')).toBe('UNKNOWN');
  });

  test('null and undefined are UNKNOWN, not a crash', () => {
    expect(failureFamily(null)).toBe('UNKNOWN');
    expect(failureFamily(undefined)).toBe('UNKNOWN');
    expect(failureFamily('')).toBe('UNKNOWN');
  });

  test('UNKNOWN is unactionable — we do not act on a failure we cannot name', () => {
    expect(isUnactionable('UNKNOWN')).toBe(true);
  });
});

describe('CROSS_BORDER is its own family, not a subset of CUSTOMER', () => {
  test('every cross-border code classifies as CROSS_BORDER', () => {
    for (const code of SPEC_TABLE.CROSS_BORDER) {
      expect(failureFamily(code)).toBe('CROSS_BORDER');
    }
  });

  test('no cross-border code leaks into CUSTOMER', () => {
    // Folding these into CUSTOMER teaches the model that an international 3DS
    // failure behaves like an insufficient-funds decline — the single most
    // expensive mistake available in this dataset (§7.2).
    for (const code of SPEC_TABLE.CROSS_BORDER) {
      expect(failureFamily(code)).not.toBe('CUSTOMER');
    }
  });

  test('CROSS_BORDER is the only family where a second route is a candidate', () => {
    const routeFamilies = FAILURE_FAMILIES.filter(isRouteFailure);
    expect(routeFamilies).toEqual(['CROSS_BORDER']);
  });

  test('and it is actionable — the route is the problem, not the card', () => {
    expect(isUnactionable('CROSS_BORDER')).toBe(false);
  });
});

describe('isUnactionable', () => {
  test('exactly TERMINAL and UNKNOWN', () => {
    expect(FAILURE_FAMILIES.filter(isUnactionable)).toEqual(['TERMINAL', 'UNKNOWN']);
  });

  test('fraud recovers under nothing', () => {
    expect(isUnactionable(failureFamily('FRAUD_SUSPECTED'))).toBe(true);
    expect(isUnactionable(failureFamily('INVALID_ACCOUNT'))).toBe(true);
  });
});

describe('case handling', () => {
  test('codes classify regardless of case', () => {
    expect(failureFamily('threeds_failed')).toBe('CROSS_BORDER');
    expect(failureFamily('Insufficient_Funds')).toBe('CUSTOMER');
  });
});
