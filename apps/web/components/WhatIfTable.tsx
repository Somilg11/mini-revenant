import type { WhatIfRun } from '@/lib/api';
import { formatInrCompact, formatCount, formatPct, exactPaise } from '@/lib/format';

/**
 * The BASELINE vs AGENT table (§8.7, §11.2). Every number is arithmetic over
 * the recorded counterfactuals; the columns are the same rows twice.
 */
export function WhatIfTable({ run }: { run: WhatIfRun }) {
  const { baseline: b, agent: a, acceptance } = run.comparison;
  const rows: { label: string; b: string; a: string; bTitle?: string; aTitle?: string; strong?: boolean }[] = [
    { label: 'Failed payments', b: formatCount(b.failed), a: formatCount(a.failed) },
    { label: 'Interventions attempted', b: formatCount(b.attempted), a: formatCount(a.attempted) },
    { label: 'Recovered', b: formatCount(b.recovered), a: formatCount(a.recovered) },
    { label: 'Recovery rate', b: formatPct(b.recoveryRate), a: formatPct(a.recoveryRate) },
    { label: 'Intervention cost', b: formatInrCompact(b.costPaise), a: formatInrCompact(a.costPaise), bTitle: exactPaise(b.costPaise), aTitle: exactPaise(a.costPaise) },
    { label: 'Revenue recovered', b: formatInrCompact(b.revenueRecoveredPaise), a: formatInrCompact(a.revenueRecoveredPaise), bTitle: exactPaise(b.revenueRecoveredPaise), aTitle: exactPaise(a.revenueRecoveredPaise), strong: true },
  ];
  const intl: typeof rows = [
    { label: 'Failed payments', b: formatCount(b.international.failed), a: formatCount(a.international.failed) },
    { label: 'Recovered', b: formatCount(b.international.recovered), a: formatCount(a.international.recovered) },
    { label: 'Acceptance after recovery', b: formatPct(acceptance.international.baseline), a: formatPct(acceptance.international.agent), strong: true },
    { label: 'Revenue recovered', b: formatInrCompact(b.international.revenueRecoveredPaise), a: formatInrCompact(a.international.revenueRecoveredPaise), bTitle: exactPaise(b.international.revenueRecoveredPaise), aTitle: exactPaise(a.international.revenueRecoveredPaise) },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <Block title="All failed payments on the held-out split" rows={rows} />
      <Block title="International only — the founder's row" rows={intl} note={`acceptance before any recovery ${formatPct(acceptance.international.before)} · ${formatCount(acceptance.international.totals.payments)} international payments in the window, ${formatCount(acceptance.international.totals.captured)} captured on the first try`} />
    </div>
  );
}

function Block({ title, rows, note }: { title: string; rows: { label: string; b: string; a: string; bTitle?: string; aTitle?: string; strong?: boolean }[]; note?: string }) {
  return (
    <div className="card">
      <div className="label">{title}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
            <th style={th}></th>
            <th style={thR}>BASELINE</th>
            <th style={thR}>AGENT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} style={{ height: 30 }}>
              <td style={{ ...td, color: r.strong ? 'var(--text)' : 'var(--text-secondary)', fontWeight: r.strong ? 510 : 400 }}>{r.label}</td>
              <td className="num mono" style={{ ...td, textAlign: 'right' }} title={r.bTitle}>{r.b}</td>
              <td className="num mono" style={{ ...td, textAlign: 'right', color: r.strong ? 'var(--success)' : 'var(--text)', fontWeight: r.strong ? 510 : 400 }} title={r.aTitle}>{r.a}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>{note}</div>}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', fontWeight: 510, padding: '0 8px 6px 0', borderBottom: '1px solid var(--border)' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 8px 4px 0', borderBottom: '1px solid var(--border)' };
