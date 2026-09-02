/**
 * Simulated clock (§8.5).
 *
 * PURE with respect to the world except for `Date.now()`, which is injected so
 * the clock can be tested without waiting. Speed is expressed as **simulated
 * minutes per real second**, which is what `SIM_SPEED` means and what the demo
 * script quotes ("simulator at 60×").
 *
 * The whole system reads time from here rather than the wall clock, because a
 * detection sweep on a 30-simulated-minute cadence would never fire during a
 * three-minute demo if it were counting real minutes.
 */

/** Simulated minutes per real second. */
export const SPEED_PRESETS = [1, 10, 60, 300] as const;
export type Speed = number;

export interface ClockState {
  /** Simulated time, ISO-8601 UTC (invariant 7). */
  now: string;
  running: boolean;
  speed: Speed;
  startsAt: string;
  endsAt: string;
  /** 0–1 through the simulated window. */
  progress: number;
  /** Real seconds remaining at the current speed, or null when paused. */
  etaSeconds: number | null;
}

export class SimClock {
  private simMs: number;
  private readonly startMs: number;
  private readonly endMs: number;
  private speedValue: Speed;
  private running = false;
  /** Real-time anchor: `Date.now()` when the clock last started or changed speed. */
  private anchorRealMs = 0;
  private anchorSimMs = 0;

  constructor(startsAt: string, endsAt: string, speed: Speed = 60) {
    this.startMs = Date.parse(startsAt);
    this.endMs = Date.parse(endsAt);
    if (Number.isNaN(this.startMs) || Number.isNaN(this.endMs)) {
      throw new RangeError('SimClock needs parseable ISO timestamps');
    }
    if (this.endMs <= this.startMs) {
      throw new RangeError('SimClock: endsAt must be after startsAt');
    }
    this.simMs = this.startMs;
    this.anchorSimMs = this.startMs;
    this.speedValue = speed;
  }

  /**
   * Simulated time is derived from the real elapsed time since the anchor, not
   * accumulated tick by tick. Accumulating drifts whenever a tick is late, and
   * every tick is late under load — which is exactly when the demo is running.
   */
  nowMs(realNowMs = Date.now()): number {
    if (!this.running) return this.simMs;
    const elapsedRealMs = realNowMs - this.anchorRealMs;
    const simElapsedMs = elapsedRealMs * this.speedValue * 60;
    return Math.min(this.endMs, this.anchorSimMs + simElapsedMs);
  }

  now(realNowMs = Date.now()): string {
    return new Date(this.nowMs(realNowMs)).toISOString();
  }

  start(realNowMs = Date.now()): void {
    if (this.running) return;
    if (this.nowMs(realNowMs) >= this.endMs) return; // finished; reset to replay
    this.anchorRealMs = realNowMs;
    this.anchorSimMs = this.simMs;
    this.running = true;
  }

  pause(realNowMs = Date.now()): void {
    if (!this.running) return;
    this.simMs = this.nowMs(realNowMs);
    this.running = false;
  }

  /** Re-anchors so a speed change does not retroactively move simulated time. */
  setSpeed(speed: Speed, realNowMs = Date.now()): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`speed must be a positive number, got ${speed}`);
    }
    const current = this.nowMs(realNowMs);
    this.simMs = current;
    this.anchorSimMs = current;
    this.anchorRealMs = realNowMs;
    this.speedValue = speed;
  }

  /** Jumps to a simulated instant, clamped to the window. Does not change running state. */
  jumpTo(iso: string, realNowMs = Date.now()): void {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new RangeError(`jumpTo: unparseable timestamp ${iso}`);
    const clamped = Math.min(this.endMs, Math.max(this.startMs, ms));
    this.simMs = clamped;
    this.anchorSimMs = clamped;
    this.anchorRealMs = realNowMs;
  }

  reset(realNowMs = Date.now()): void {
    this.running = false;
    this.simMs = this.startMs;
    this.anchorSimMs = this.startMs;
    this.anchorRealMs = realNowMs;
  }

  isFinished(realNowMs = Date.now()): boolean {
    return this.nowMs(realNowMs) >= this.endMs;
  }

  get speed(): Speed {
    return this.speedValue;
  }

  state(realNowMs = Date.now()): ClockState {
    const nowMs = this.nowMs(realNowMs);
    const span = this.endMs - this.startMs;
    const remainingSimMs = this.endMs - nowMs;
    return {
      now: new Date(nowMs).toISOString(),
      running: this.running,
      speed: this.speedValue,
      startsAt: new Date(this.startMs).toISOString(),
      endsAt: new Date(this.endMs).toISOString(),
      progress: span === 0 ? 1 : Math.min(1, Math.max(0, (nowMs - this.startMs) / span)),
      etaSeconds: this.running
        ? Math.max(0, Math.round(remainingSimMs / (this.speedValue * 60 * 1000)))
        : null,
    };
  }
}
