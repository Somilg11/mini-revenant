'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { simApi, formatIst, type SimState } from '@/lib/sim';
import type { Evaluation } from '@/lib/api';
import { formatCount, formatPct } from '@/lib/format';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

/**
 * `/simulator` (§11.2): the answer key beside the detector's answers.
 *
 * Seed, parameters, checksum and progress; the five injected incidents with
 * their detected / missed status; the two unlabelled noise windows with
 * fired / clean; and the live scoreboard — detection precision, recall, RCA
 * top-1 — recomputed against `ground_truth_incidents` as the replay runs.
 * Plus the two levers the demo pulls: jump to an incident, inject a gateway
 * fault.
 */
export function SimulatorPanel({ initial, evaluation: initialEval }: { initial: SimState | null; evaluation: Evaluation | null }) {
  const [state, setState] = useState<SimState | null>(initial);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(initialEval);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const [, start] = useTransition();
  const running = state?.clock.running ?? false;

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        simApi.state(),
        fetch(`${BASE}/api/v1/evaluation`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<Evaluation>) : null)),
      ]);
      setState(s);
      if (e) setEvaluation(e);
    } catch {
      setMessage('cannot reach the API');
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void refresh(), running ? 2000 : 8000);
    return () => clearInterval(id);
  }, [running, refresh]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setMessage(null);
    try {
      await fn();
      await refresh();
      start(() => router.refresh());
    } catch {
      setMessage(`${name} failed`);
    } finally {
      setBusy(null);
    }
  };

  const clock = state?.clock;
  const d = state?.dataset ?? null;
  const matches = new Map((evaluation?.detection.matches ?? []).map((m) => [m.groundTruthId, m]));
  const rcaByKind = new Map((evaluation?.rca?.results ?? []).map((r) => [r.kind, r]));
  const g = state?.gateway;

  return (
    <>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
        <Tile label="Seed" value={d ? String(d.seed) : '—'} note="same seed ⇒ same checksum, on any machine" mono />
        <Tile label="Checksum" value={d ? d.checksum.slice(0, 12) : '—'} note={d ? d.checksum : 'no dataset loaded — press Play or run bun seed'} mono />
        <Tile label="Payments · events" value={d ? `${formatCount(d.payments)} · ${formatCount(d.events)}` : '—'} note={d ? `${formatCount(state?.emitted ?? 0)} events emitted so far` : 'not generated'} />
        <Tile label="Progress" value={clock ? `${(clock.progress * 100).toFixed(1)}%` : '—'} note={clock ? `${formatIst(clock.startsAt)} → ${formatIst(clock.endsAt)} IST · ${clock.speed}× · ${clock.running ? 'running' : 'paused'}` : ''} />
        <Tile label="Simulated clock" value={clock ? formatIst(clock.now) : '—'} note="IST in the browser only; UTC everywhere in code" mono />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 8 }}>
        <Score label="Detection precision" value={evaluation?.detection.precision ?? null} note={evaluation ? `${evaluation.detection.true_positives} true · ${evaluation.detection.false_positives} false positives` : 'not measured'} />
        <Score label="Detection recall" value={evaluation?.detection.recall ?? null} note={evaluation ? `${evaluation.detection.true_positives} of ${evaluation.detection.true_positives + evaluation.detection.false_negatives} injected incidents found` : 'not measured'} />
        <Score label="RCA top-1 accuracy" value={evaluation?.rca?.top1_accuracy ?? null} note={evaluation?.rca ? `${evaluation.rca.top1_correct} of ${evaluation.rca.scored} diagnosed against the labelled tuple` : 'no incident diagnosed yet'} />
        <Tile label="Noise windows" value={evaluation ? (evaluation.noise_windows.clean ? 'clean' : 'fired') : '—'} note="two mild fluctuations, deliberately unlabelled — a detector that fires on them is wrong" tone={evaluation ? (evaluation.noise_windows.clean ? 'success' : 'danger') : undefined} />
      </section>

      <section className="card" style={{ marginTop: 8 }}>
        <div className="label">The five injected incidents — the answer key, and whether the detector found each</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}><th style={th}>Incident</th><th style={th}>Window (IST)</th><th style={thR}>Affected</th><th style={th}>Status</th><th style={th}>Detected as</th><th style={th}></th></tr></thead>
          <tbody>
            {(state?.incidents ?? []).map((i) => {
              const m = matches.get(i.id);
              const rca = rcaByKind.get(i.kind);
              const passed = clock ? Date.parse(clock.now) >= Date.parse(i.startedAt) : false;
              const found = m?.detected ?? false;
              return (
                <tr key={i.id} style={{ height: 32 }}>
                  <td style={td}><span className="mono" style={{ fontSize: 11 }}>{i.kind}</span></td>
                  <td style={td} className="mono">{formatIst(i.startedAt)} → {formatIst(i.endedAt)}</td>
                  <td className="num" style={td}>{formatCount(i.affectedPayments)}</td>
                  <td style={td}>
                    <span className="mono" style={{ fontSize: 11, color: found ? 'var(--success)' : passed ? 'var(--danger)' : 'var(--text-tertiary)' }} title={m?.missReason ?? undefined}>
                      {found ? (m?.onCorrectDimension ? 'DETECTED' : 'DETECTED (other dimension)') : passed ? `MISSED${m?.missReason ? ` — ${m.missReason}` : ''}` : 'not yet reached'}
                    </span>
                  </td>
                  <td style={td}>
                    {found ? (
                      rca?.incidentId ? (
                        <a href={`/incidents/${rca.incidentId}`} className="mono" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                          {m?.detectedDimension ?? '—'}{m && m.corroboratingDetections > 0 ? ` · +${m.corroboratingDetections} corroborating` : ''}{rca.top1 ? ` · RCA ${rca.top1Correct ? '✓' : '✗'}` : ''}
                        </a>
                      ) : (
                        <span className="mono" style={{ fontSize: 11 }}>{m?.detectedDimension ?? '—'}</span>
                      )
                    ) : (
                      <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}><button onClick={() => act('jump', () => simApi.jump(i.id))} disabled={busy !== null} style={chip}>{busy === 'jump' ? '…' : 'jump here'}</button></td>
                </tr>
              );
            })}
            {(state?.incidents.length ?? 0) === 0 && <tr><td colSpan={6} style={{ ...td, color: 'var(--text-tertiary)' }}>No dataset loaded.</td></tr>}
          </tbody>
        </table>
        {(evaluation?.detection.unmatched.length ?? 0) > 0 && (
          <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 8 }}>
            {evaluation!.detection.unmatched.length} incident{evaluation!.detection.unmatched.length === 1 ? '' : 's'} opened outside any injected window — false positives: {evaluation!.detection.unmatched.map((u) => `${u.dimension}=${u.dimensionValue}`).join(', ')}
          </div>
        )}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <div className="card">
          <div className="label">The two noise windows — must stay clean</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead><tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}><th style={th}>Window (IST)</th><th style={th}>Verdict</th></tr></thead>
            <tbody>
              {(evaluation?.noise_windows.windows ?? state?.noiseWindows.map((w) => ({ ...w, firedIncidents: 0 })) ?? []).map((w) => (
                <tr key={w.startedAt} style={{ height: 32 }}>
                  <td style={td} className="mono">{formatIst(w.startedAt)} → {formatIst(w.endedAt)}</td>
                  <td style={td}><span className="mono" style={{ fontSize: 11, color: w.firedIncidents > 0 ? 'var(--danger)' : 'var(--success)' }}>{w.firedIncidents > 0 ? `FIRED ×${w.firedIncidents}` : 'clean'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="label">Simulated gateway — inject a fault (§13 step 9)</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 6 }}>
            The next calls answer with the fault you pick instead of the seeded 5 / 2 / 1% draw. Then approve a pending case, or let the replay act, and watch the executor: 429s back off and retry twice then escalate; a timeout is reconciled by reference, never blind-retried; a rejection fails at once.
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
            <button onClick={() => act('429', () => simApi.injectFault('retryable', 3))} disabled={busy !== null} style={chip}>3 × 429/503</button>
            <button onClick={() => act('timeout', () => simApi.injectFault('timeout', 2))} disabled={busy !== null} style={chip}>2 × timeout (unknown outcome)</button>
            <button onClick={() => act('terminal', () => simApi.injectFault('terminal', 1))} disabled={busy !== null} style={chip}>1 × hard rejection</button>
          </div>
          {g && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 10, lineHeight: 1.6 }}>
              calls {formatCount(g.calls)} · effects {formatCount(g.effects)} · faults {g.faults.retryable} retryable / {g.faults.timeout} timeout / {g.faults.terminal} terminal · queued {g.queuedFaults.length > 0 ? g.queuedFaults.join(', ') : 'none'}{g.unlabelled > 0 ? ` · ${g.unlabelled} unlabelled` : ''}
            </div>
          )}
          {message && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 8 }}>{message}</div>}
        </div>
      </section>
    </>
  );
}

function Tile({ label, value, note, mono, tone }: { label: string; value: string; note: string; mono?: boolean; tone?: 'success' | 'danger' | undefined }) {
  const colour = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)';
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={mono ? 'metric mono' : 'metric'} style={{ marginTop: 2, fontSize: mono ? 16 : undefined, color: colour, wordBreak: 'break-all' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5, wordBreak: 'break-all' }}>{note}</div>
    </div>
  );
}

function Score({ label, value, note }: { label: string; value: number | null; note: string }) {
  const colour = value === null ? 'var(--text-tertiary)' : value >= 0.99 ? 'var(--success)' : value >= 0.8 ? 'var(--text)' : 'var(--warning)';
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="metric" style={{ marginTop: 2, color: colour }}>{formatPct(value, 0)}</div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', fontWeight: 510, padding: '0 8px 6px 0', borderBottom: '1px solid var(--border)' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 8px 4px 0', borderBottom: '1px solid var(--border)' };
const chip: React.CSSProperties = { fontFamily: 'inherit', fontSize: 11, padding: '3px 10px', borderRadius: 'var(--radius)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--bg-elevated)', color: 'var(--text)' };
