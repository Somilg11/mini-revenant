import { describe, expect, test } from 'bun:test';
import { SimClock, SPEED_PRESETS } from './clock.ts';

const START = '2026-07-25T00:00:00.000Z';
const END = '2026-08-01T00:00:00.000Z';
const R0 = 1_000_000; // an arbitrary real-time origin, in ms

const clock = (speed = 60) => new SimClock(START, END, speed);

describe('simulated time advances with real time', () => {
  test('paused, it does not move', () => {
    const c = clock();
    expect(c.now(R0)).toBe(START);
    expect(c.now(R0 + 60_000)).toBe(START);
  });

  test('at 60 sim-minutes per real second, one real second is one simulated hour', () => {
    const c = clock(60);
    c.start(R0);
    expect(c.now(R0 + 1_000)).toBe('2026-07-25T01:00:00.000Z');
    expect(c.now(R0 + 10_000)).toBe('2026-07-25T10:00:00.000Z');
  });

  test('at the spec default of 30, seven days take ~5.6 real minutes', () => {
    const c = clock(30);
    c.start(R0);
    const realSeconds = (7 * 24 * 60) / 30;
    expect(realSeconds).toBeCloseTo(336, 0);
    expect(c.now(R0 + realSeconds * 1000)).toBe(END);
  });

  test('time is derived from the anchor, not accumulated — a late tick cannot drift', () => {
    // Accumulating per tick drifts whenever a tick is late, and every tick is
    // late under load, which is exactly when the demo is running.
    const c = clock(60);
    c.start(R0);
    const afterOneLongGap = c.now(R0 + 5_000);
    const c2 = clock(60);
    c2.start(R0);
    for (let i = 1; i <= 5; i += 1) c2.now(R0 + i * 1_000);
    expect(c2.now(R0 + 5_000)).toBe(afterOneLongGap);
  });
});

describe('pause and resume', () => {
  test('pausing freezes simulated time', () => {
    const c = clock(60);
    c.start(R0);
    c.pause(R0 + 2_000);
    expect(c.now(R0 + 2_000)).toBe('2026-07-25T02:00:00.000Z');
    expect(c.now(R0 + 99_000)).toBe('2026-07-25T02:00:00.000Z');
  });

  test('resuming continues from where it stopped, not from where it would have been', () => {
    const c = clock(60);
    c.start(R0);
    c.pause(R0 + 2_000);
    c.start(R0 + 100_000); // 98 real seconds spent paused
    expect(c.now(R0 + 101_000)).toBe('2026-07-25T03:00:00.000Z');
  });
});

describe('speed changes', () => {
  test('changing speed does not retroactively move simulated time', () => {
    const c = clock(60);
    c.start(R0);
    const at2s = c.now(R0 + 2_000);
    c.setSpeed(300, R0 + 2_000);
    expect(c.now(R0 + 2_000)).toBe(at2s);
    // One more real second, now at 300 sim-minutes per second = 5 sim hours.
    expect(c.now(R0 + 3_000)).toBe('2026-07-25T07:00:00.000Z');
  });

  test('every preset is a positive number of simulated minutes per real second', () => {
    for (const s of SPEED_PRESETS) expect(s).toBeGreaterThan(0);
    expect([...SPEED_PRESETS]).toEqual([1, 10, 60, 300]);
  });

  test('a non-positive speed is refused', () => {
    expect(() => clock().setSpeed(0)).toThrow(RangeError);
    expect(() => clock().setSpeed(-5)).toThrow(RangeError);
  });
});

describe('bounds', () => {
  test('simulated time never runs past the end of the window', () => {
    const c = clock(300);
    c.start(R0);
    expect(c.now(R0 + 10_000_000)).toBe(END);
    expect(c.isFinished(R0 + 10_000_000)).toBe(true);
  });

  test('jumpTo clamps to the window', () => {
    const c = clock();
    c.jumpTo('2020-01-01T00:00:00.000Z', R0);
    expect(c.now(R0)).toBe(START);
    c.jumpTo('2099-01-01T00:00:00.000Z', R0);
    expect(c.now(R0)).toBe(END);
  });

  test('jumpTo lands on the requested instant inside the window', () => {
    const c = clock();
    c.jumpTo('2026-07-28T12:00:00.000Z', R0);
    expect(c.now(R0)).toBe('2026-07-28T12:00:00.000Z');
  });

  test('a finished clock does not restart without a reset', () => {
    const c = clock(300);
    c.start(R0);
    c.pause(R0 + 10_000_000);
    c.start(R0 + 10_000_001);
    expect(c.state(R0 + 10_000_002).running).toBe(false);
  });

  test('reset returns to the start, paused', () => {
    const c = clock(60);
    c.start(R0);
    c.reset(R0 + 5_000);
    const s = c.state(R0 + 6_000);
    expect(s.now).toBe(START);
    expect(s.running).toBe(false);
    expect(s.progress).toBe(0);
  });

  test('an invalid window is refused', () => {
    expect(() => new SimClock(END, START)).toThrow(RangeError);
    expect(() => new SimClock('nope', END)).toThrow(RangeError);
  });
});

describe('state reporting', () => {
  test('progress and eta track the window', () => {
    const c = clock(60);
    c.start(R0);
    // Half of seven days is 84 simulated hours = 84 real seconds at 60×.
    const s = c.state(R0 + 84_000);
    expect(s.progress).toBeCloseTo(0.5, 2);
    expect(s.etaSeconds).toBeCloseTo(84, 0);
  });

  test('eta is null while paused — not zero, which would read as "done"', () => {
    expect(clock().state(R0).etaSeconds).toBeNull();
  });
});
