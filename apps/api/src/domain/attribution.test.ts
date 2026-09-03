import { describe, expect, test } from 'bun:test';
import { ASSIST_WINDOW_MINUTES, DIRECT_WINDOW_MINUTES, attribute, creditedPaise, isLost } from './attribution.ts';

const T0 = '2026-07-28T10:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const ours = { actedAt: T0, reference: 'gw_s_abc' };

describe('direct — our reference, inside 30 simulated minutes', () => {
  test('matching reference at 1 and at exactly 30 minutes', () => {
    expect(attribute({ capturedAt: at(1), reference: 'gw_s_abc' }, ours)).toBe('direct');
    expect(attribute({ capturedAt: at(DIRECT_WINDOW_MINUTES), reference: 'gw_s_abc' }, ours)).toBe('direct');
  });
  test('matching reference at 31 minutes is only assisted', () => {
    expect(attribute({ capturedAt: at(DIRECT_WINDOW_MINUTES + 1), reference: 'gw_s_abc' }, ours)).toBe('assisted');
  });
});

describe('assisted — a different reference inside 6 simulated hours', () => {
  test('different reference at 5 minutes, at 3 hours, at exactly 6 hours', () => {
    expect(attribute({ capturedAt: at(5), reference: 'other' }, ours)).toBe('assisted');
    expect(attribute({ capturedAt: at(180), reference: 'other' }, ours)).toBe('assisted');
    expect(attribute({ capturedAt: at(ASSIST_WINDOW_MINUTES), reference: null }, ours)).toBe('assisted');
  });
  test('a missing reference on either side is never direct', () => {
    expect(attribute({ capturedAt: at(1), reference: null }, ours)).toBe('assisted');
    expect(attribute({ capturedAt: at(1), reference: 'gw_s_abc' }, { actedAt: T0, reference: null })).toBe('assisted');
  });
});

describe('organic — credits zero', () => {
  test('no action at all', () => {
    expect(attribute({ capturedAt: at(1), reference: 'gw_s_abc' }, null)).toBe('organic');
  });
  test('captured before we acted, even with a matching reference', () => {
    expect(attribute({ capturedAt: at(-1), reference: 'gw_s_abc' }, ours)).toBe('organic');
  });
  test('beyond the assist window', () => {
    expect(attribute({ capturedAt: at(ASSIST_WINDOW_MINUTES + 1), reference: 'gw_s_abc' }, ours)).toBe('organic');
  });
  test('credit is the full amount for direct and assisted, zero for organic', () => {
    expect(creditedPaise('direct', 480_000)).toBe(480_000);
    expect(creditedPaise('assisted', 480_000)).toBe(480_000);
    expect(creditedPaise('organic', 480_000)).toBe(0);
  });
});

describe('lost', () => {
  test('not before the assist window has fully elapsed', () => {
    expect(isLost(T0, at(ASSIST_WINDOW_MINUTES - 1))).toBe(false);
    expect(isLost(T0, at(ASSIST_WINDOW_MINUTES))).toBe(true);
    expect(isLost(T0, at(24 * 60))).toBe(true);
  });
});
