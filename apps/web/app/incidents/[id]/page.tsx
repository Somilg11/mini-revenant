import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchIncident, fetchIncidentSeries } from '@/lib/api';
import { formatInrCompact, formatPct, formatCount, exactPaise } from '@/lib/format';
import { GateChecklist } from '@/components/GateChecklist';
import { HypothesisCard } from '@/components/HypothesisCard';

export const dynamic = 'force-dynamic';

/**
 * `/incidents/[id]` — the verdict and its evidence (§11.2).
 *
 * The five gates are shown in full, passed ones included. The claim is that
 * five gates are why the detector ignored two unlabelled noise windows, and
 * that is only checkable if every gate is on screen with the number it was
 * compared against.
 */
export default async function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let incident;
  try {
    ({ incident } = await fetchIncident(id));
  } catch {
    notFound();
  }
  const series = await fetchIncidentSeries(id);

  const lift = (incident.current_rate - incident.baseline_rate) * 100;
  const relative = incident.baseline_rate > 0 ? incident.current_rate / incident.baseline_rate : null;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/incidents" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>
          ← Incidents
        </Link>
        <h1 className="section-title" style={{ margin: '6px 0 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span className="mono">
            {incident.dimension}={incident.dimension_value}
          </span>
          <span
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: incident.status === 'OPEN' ? 'var(--info)' : 'var(--text-tertiary)',
            }}
          >
            {incident.status}
          </span>
        </h1>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          opened <span className="mono">{incident.opened_at.replace('T', ' ').slice(0, 19)}</span> UTC
          {incident.resolved_at && (
            <> · resolved <span className="mono">{incident.resolved_at.replace('T', ' ').slice(0, 19)}</span></>
          )}
          {' · '}infrastructure-wide
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Tile label="Failure rate" value={formatPct(incident.current_rate)} note={`against a ${formatPct(incident.baseline_rate)} baseline`} tone="danger" />
        <Tile label="Lift" value={`${lift.toFixed(1)} pts`} note={relative ? `${relative.toFixed(2)}× the baseline` : 'no baseline'} />
        <Tile label="z-score" value={incident.z_score.toFixed(1)} note="against the same slice's own history" />
        <Tile
          label="Revenue at risk"
          value={formatInrCompact(incident.revenue_at_risk_paise)}
          note={`${formatCount(incident.affected_payments)} payments in the slice`}
          titlePaise={incident.revenue_at_risk_paise}
        />
      </section>

      {incident.root_cause && incident.root_cause.hypotheses.length > 0 && (
        <section style={{ marginTop: 8 }}>
          <div className="card" style={{ marginBottom: 8 }}>
            <div className="label">Root cause</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.7 }}>
              Ranked by <strong style={{ fontWeight: 510 }}>excess</strong> failures, never total
              ones. Total failures name the busiest slice — during a bank outage that is whichever
              method carries its traffic. Excess names the slice that <em>changed</em>.
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
              {incident.root_cause.window_failures} failures in{' '}
              {incident.root_cause.window_attempts} attempts ·{' '}
              {incident.root_cause.incident_excess.toFixed(1)} of them beyond expectation ·
              expectations shrunk toward a {formatPct(incident.root_cause.pooled_rate)} pooled rate
              {incident.root_cause.used_window_as_reference &&
                ' · no history available, so the window is its own reference'}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            {incident.root_cause.hypotheses.map((h, i) => (
              <HypothesisCard key={h.label} h={h} rank={i} />
            ))}
          </div>
        </section>
      )}

      <section className="card" style={{ marginTop: 8 }}>
        <div className="label">The five gates</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          Every gate must pass. One threshold fires on everything; five is why the two unlabelled
          noise windows stayed quiet.
        </div>
        <GateChecklist gates={incident.gates} />
      </section>

      {series && series.points.length > 0 && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">This slice, around the detection moment</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                <th style={th}>Bucket (UTC)</th>
                <th style={thR}>Attempts</th>
                <th style={thR}>Failures</th>
                <th style={thR}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {series.points
                .filter((p) => p.attempts > 0)
                .slice(-24)
                .map((p) => {
                  const opened = Date.parse(p.start) >= Date.parse(series.opened_at);
                  return (
                    <tr key={p.start} style={{ height: 26, background: opened ? 'var(--accent-subtle)' : undefined }}>
                      <td className="mono" style={{ ...td, fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {p.start.replace('T', ' ').slice(0, 16)}
                      </td>
                      <td className="num" style={td}>{p.attempts}</td>
                      <td className="num" style={td}>{p.failures}</td>
                      <td
                        className="num"
                        style={{
                          ...td,
                          color:
                            (p.failure_rate ?? 0) - series.baseline_rate > 0.08
                              ? 'var(--danger)'
                              : 'var(--text)',
                        }}
                      >
                        {formatPct(p.failure_rate)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>
            Highlighted rows are at or after the detection moment. Root-cause apportionment and the
            narrative arrive in P8 and P15.
          </div>
        </section>
      )}
    </main>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left',
  fontWeight: 510,
  padding: '0 8px 6px 0',
  borderBottom: '1px solid var(--border)',
};
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 8px 4px 0' };

function Tile({
  label,
  value,
  note,
  tone,
  titlePaise,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'danger' | undefined;
  titlePaise?: number | undefined;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div
        className="metric"
        style={{ marginTop: 2, color: tone === 'danger' ? 'var(--danger)' : 'var(--text)' }}
        title={titlePaise !== undefined ? exactPaise(titlePaise) : undefined}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{note}</div>
    </div>
  );
}
