'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { simApi, formatIst, type SimState } from '@/lib/sim';

const SPEEDS = [1, 10, 60, 300];

/**
 * The simulator control bar (§11.2), pinned to the top of the Command Center.
 *
 * The clock it shows is **simulated** time, and it is deliberately held back
 * whenever the replay cannot keep up: progress here always reflects data that
 * actually exists, never a clock that has run ahead of it.
 */
export function SimControlBar({ initial }: { initial: SimState | null }) {
  const [state, setState] = useState<SimState | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [, startTransition] = useTransition();

  const running = state?.clock.running ?? false;

  // Poll while running; idle otherwise. The clock is the one thing SSE does not
  // carry, because it changes continuously rather than on an event.
  useEffect(() => {
    const period = running ? 500 : 3000;
    const id = setInterval(() => {
      simApi
        .state()
        .then(setState)
        .catch(() => setError('cannot reach the API'));
    }, period);
    return () => clearInterval(id);
  }, [running]);

  // Refresh the server-rendered metrics as simulated days go by.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => startTransition(() => router.refresh()), 4000);
    return () => clearInterval(id);
  }, [running, router]);

  const act = useCallback(
    async (name: string, fn: () => Promise<SimState>) => {
      setBusy(name);
      setError(null);
      try {
        setState(await fn());
        startTransition(() => router.refresh());
      } catch {
        setError(`${name} failed`);
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const clock = state?.clock;
  const pct = (clock?.progress ?? 0) * 100;

  return (
    <section
      className="card"
      style={{ padding: 0, marginBottom: 12, position: 'sticky', top: 0, zIndex: 10 }}
      aria-label="Simulator controls"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
        <button
          onClick={() => act(running ? 'pause' : 'start', running ? simApi.pause : simApi.start)}
          disabled={busy !== null}
          style={primaryButton(running)}
          title={running ? 'Pause the replay' : 'Replay seven days of payments'}
        >
          {busy === 'start' || busy === 'pause' ? '…' : running ? '❙❙ Pause' : '▶ Play'}
        </button>

        <button
          onClick={() => {
            if (confirm('Reset clears every payment, incident and case, then reloads the ground truth. Continue?')) {
              void act('reset', simApi.reset);
            }
          }}
          disabled={busy !== null}
          style={ghostButton}
          title="Clears all projected state and starts over"
        >
          {busy === 'reset' ? '…' : '↺ Reset'}
        </button>

        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="label" style={{ marginRight: 2 }}>
            Speed
          </span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => act('speed', () => simApi.speed(s))}
              disabled={busy !== null}
              style={chip(clock?.speed === s)}
              title={`${s} simulated minutes per real second`}
            >
              {s}×
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
            {clock ? formatIst(clock.now) : '—'} <span style={{ color: 'var(--text-tertiary)' }}>IST</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {pct.toFixed(1)}% of 7 days
            {state?.dataset ? ` · ${state.emitted.toLocaleString('en-IN')} / ${state.dataset.events.toLocaleString('en-IN')} events` : ''}
            {clock?.etaSeconds != null ? ` · ~${clock.etaSeconds}s left` : ''}
          </div>
        </div>
      </div>

      {/* Progress, with the injected incident windows marked on it. */}
      <div style={{ position: 'relative', height: 4, background: 'var(--bg-hover)' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: 'var(--accent)',
            transition: 'width 400ms linear',
          }}
        />
        {(state?.incidents ?? []).map((i) => {
          const left = fraction(i.startedAt, clock) * 100;
          const width = Math.max(0.4, (fraction(i.endedAt, clock) - fraction(i.startedAt, clock)) * 100);
          return (
            <div
              key={i.id}
              title={`${i.kind} · ${i.affectedPayments} payments`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${left}%`,
                width: `${width}%`,
                background: 'var(--warning)',
                opacity: 0.75,
              }}
            />
          );
        })}
      </div>

      {(state?.incidents.length ?? 0) > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span className="label">Jump to</span>
          {state!.incidents.map((i) => (
            <button
              key={i.id}
              onClick={() => act('jump', () => simApi.jump(i.id))}
              disabled={busy !== null}
              style={chip(false)}
              title={`${i.affectedPayments} payments affected · ${formatIst(i.startedAt)} IST`}
            >
              {i.kind.replace(/_/g, ' ').toLowerCase()}
            </button>
          ))}
          {error && (
            <span style={{ fontSize: 11, color: 'var(--danger)', marginLeft: 'auto' }}>{error}</span>
          )}
        </div>
      )}
    </section>
  );
}

function fraction(iso: string, clock: { startsAt: string; endsAt: string } | undefined): number {
  if (!clock) return 0;
  const start = Date.parse(clock.startsAt);
  const end = Date.parse(clock.endsAt);
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (Date.parse(iso) - start) / (end - start)));
}

const baseButton: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12,
  padding: '5px 10px',
  borderRadius: 'var(--radius)',
  cursor: 'pointer',
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-elevated)',
  color: 'var(--text)',
};

const primaryButton = (running: boolean): React.CSSProperties => ({
  ...baseButton,
  minWidth: 84,
  fontWeight: 510,
  background: running ? 'var(--bg-elevated)' : 'var(--accent)',
  borderColor: running ? 'var(--border-strong)' : 'var(--accent)',
  color: running ? 'var(--text)' : '#fff',
});

const ghostButton: React.CSSProperties = { ...baseButton, color: 'var(--text-secondary)' };

const chip = (active: boolean): React.CSSProperties => ({
  ...baseButton,
  padding: '3px 8px',
  fontSize: 11,
  background: active ? 'var(--accent-subtle)' : 'transparent',
  borderColor: active ? 'var(--accent)' : 'var(--border)',
  color: active ? 'var(--accent)' : 'var(--text-secondary)',
});
