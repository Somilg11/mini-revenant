import { describe, expect, test } from 'bun:test';
import {
  BACKOFF_CAP_MS,
  MAX_ATTEMPTS,
  backoffMs,
  classify,
  counterfactualFor,
  drawFault,
  nextStep,
  routeAccepts,
  routeFor,
  settleDelayMinutes,
} from './execution.ts';

describe('error classification reads the class, never the message', () => {
  test('a carried class is honoured', () => {
    expect(classify({ errorClass: 'RETRYABLE', message: 'fatal: do not retry' })).toBe('RETRYABLE');
    expect(classify({ errorClass: 'TERMINAL', message: '503 try again' })).toBe('TERMINAL');
  });
  test('unclassified defaults to NEEDS_HUMAN', () => {
    expect(classify(new Error('429 Too Many Requests'))).toBe('NEEDS_HUMAN');
    expect(classify({ errorClass: 'BOGUS' })).toBe('NEEDS_HUMAN');
    expect(classify(null)).toBe('NEEDS_HUMAN');
    expect(classify('timeout')).toBe('NEEDS_HUMAN');
  });
});

describe('retry policy', () => {
  test('RETRYABLE retries twice, then escalates rather than loops', () => {
    expect(nextStep('RETRYABLE', 1)).toBe('retry');
    expect(nextStep('RETRYABLE', 2)).toBe('retry');
    expect(nextStep('RETRYABLE', 3)).toBe('escalate');
    expect(nextStep('RETRYABLE', 99)).toBe('escalate');
    expect(MAX_ATTEMPTS).toBe(3);
  });
  test('TERMINAL fails at once, NEEDS_HUMAN escalates at once', () => {
    expect(nextStep('TERMINAL', 1)).toBe('fail');
    expect(nextStep('NEEDS_HUMAN', 1)).toBe('escalate');
  });
  test('backoff is capped and jittered, never zero', () => {
    expect(backoffMs(1, 0)).toBe(100);
    expect(backoffMs(1, 1)).toBe(200);
    expect(backoffMs(2, 0.5)).toBe(300);
    expect(backoffMs(10, 1)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(10, 0)).toBe(BACKOFF_CAP_MS / 2);
    for (let a = 1; a <= 5; a += 1) expect(backoffMs(a, 0)).toBeGreaterThan(0);
  });
});

describe('injected faults', () => {
  test('the draw lands on the §8.6 table: 5% retryable, 2% timeout, 1% terminal', () => {
    expect(drawFault(0)).toBe('retryable');
    expect(drawFault(0.0499)).toBe('retryable');
    expect(drawFault(0.05)).toBe('timeout');
    expect(drawFault(0.0699)).toBe('timeout');
    expect(drawFault(0.07)).toBe('terminal');
    expect(drawFault(0.0799)).toBe('terminal');
    expect(drawFault(0.08)).toBe('none');
    expect(drawFault(0.999)).toBe('none');
  });
  test('over a uniform grid the rates come out as stated', () => {
    const n = 100_000;
    const counts = { none: 0, retryable: 0, timeout: 0, terminal: 0 };
    for (let i = 0; i < n; i += 1) counts[drawFault(i / n)] += 1;
    expect(counts.retryable / n).toBeCloseTo(0.05, 3);
    expect(counts.timeout / n).toBeCloseTo(0.02, 3);
    expect(counts.terminal / n).toBeCloseTo(0.01, 3);
  });
});

describe('routes', () => {
  test('only the alternate-gateway action goes to the secondary route', () => {
    expect(routeFor('route_alternate_gateway')).toBe('secondary');
    expect(routeFor('retry_payment')).toBe('primary');
    expect(routeFor('create_payment_link')).toBe('primary');
  });
  test('secondary refuses INR-only instruments so alternate_gateway has to be earned', () => {
    expect(routeAccepts('secondary', { method: 'upi', cardNetwork: null })).toBe(false);
    expect(routeAccepts('secondary', { method: 'netbanking', cardNetwork: null })).toBe(false);
    expect(routeAccepts('secondary', { method: 'card', cardNetwork: 'rupay' })).toBe(false);
    expect(routeAccepts('secondary', { method: 'card', cardNetwork: 'RuPay' })).toBe(false);
    expect(routeAccepts('secondary', { method: 'card', cardNetwork: 'visa' })).toBe(true);
    expect(routeAccepts('secondary', { method: 'card', cardNetwork: 'mastercard' })).toBe(true);
    expect(routeAccepts('secondary', { method: 'wallet', cardNetwork: null })).toBe(true);
  });
  test('primary accepts everything', () => {
    expect(routeAccepts('primary', { method: 'upi', cardNetwork: null })).toBe(true);
    expect(routeAccepts('primary', { method: 'card', cardNetwork: 'rupay' })).toBe(true);
  });
});

describe('counterfactuals', () => {
  test('each intervention reads its own label; escalate reads none', () => {
    expect(counterfactualFor('retry_payment')).toBe('recoverable_by_retry');
    expect(counterfactualFor('create_payment_link')).toBe('recoverable_by_link');
    expect(counterfactualFor('notify_customer')).toBe('recoverable_by_alternate');
    expect(counterfactualFor('route_alternate_gateway')).toBe('recoverable_by_gateway');
    expect(counterfactualFor('escalate')).toBeNull();
  });
  test('every kind settles inside the 30-minute direct-attribution window', () => {
    for (const kind of ['retry_payment', 'create_payment_link', 'notify_customer', 'route_alternate_gateway'] as const) {
      for (const u of [0, 0.5, 0.999]) {
        const d = settleDelayMinutes(kind, u);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThan(30);
      }
    }
    expect(settleDelayMinutes('create_payment_link', 0.999)).toBeGreaterThan(settleDelayMinutes('retry_payment', 0.999));
  });
});
