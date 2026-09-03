import Link from 'next/link';
import { fetchIncidents, fetchEvaluation } from '@/lib/api';
import { formatInrCompact, formatPct, formatCount, exactPaise } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * `/incidents` — the diagnosis story (§11.2).
 *
 * The scoreboard sits above the list on purpose. "We detected all six" means
 * nothing on its own: a detector that fires on everything detects all six too.
 * Precision against the unlabelled noise windows is the half of the claim that
 * costs something, so it is shown first and it is measured, not asserted.
 */
export default async function IncidentsPage() {
  const [{ incidents }, evaluation] = await Promise.all([fetchIncidents(), fetchEvaluation()]);
  const det = evaluation?.detection;
  const noise = evaluation?.noise_windows;
  const rca = evaluation?.rca;
  const rcaByKind = new Map((rca?.results ?? []).map((r) => [r.kind, r]));

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>
          ← Command Center
        </Link>
        <h1 className="section-title" style={{ margin: '6px 0 0' }}>
          Incidents
        </h1>
      </header>

      {det && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          <Tile
            label="Precision"
            value={formatPct(det.precision)}
            note={`${det.incidents_opened - det.false_positives} of ${det.incidents_opened} alerts landed in a real window`}
            tone={det.precision === 1 ? 'success' : undefined}
          />
          <Tile
            label="Recall"
            value={formatPct(det.recall)}
            note={`${det.true_positives} of ${det.true_positives + det.false_negatives} injected incidents found`}
          />
          <Tile
            label="False positives"
            value={formatCount(det.false_positives)}
            note="alerts matching no labelled window"
            tone={det.false_positives === 0 ? 'success' : 'danger'}
          />
          <Tile
            label="Noise windows"
            value={noise?.clean ? 'clean' : 'fired'}
            note="two unlabelled windows — firing here is wrong"
            tone={noise?.clean ? 'success' : 'danger'}
          />
          <Tile
            label="RCA top-1"
            value={rca?.top1_accuracy === null || rca === null || rca === undefined ? '—' : formatPct(rca.top1_accuracy)}
            note={
              rca && rca.scored > 0
                ? `${rca.top1_correct} of ${rca.scored} diagnosed incidents named the labelled tuple`
                : 'no incident diagnosed yet'
            }
            tone={rca && rca.scored > 0 && rca.top1_correct === rca.scored ? 'success' : undefined}
          />
        </section>
      )}

      {det && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">Against the answer key</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                <th style={th}>Injected incident</th>
                <th style={thR}>Payments</th>
                <th style={th}>Found on</th>
                <th style={th}>Diagnosed as</th>
              </tr>
            </thead>
            <tbody>
              {det.matches.map((m) => (
                <tr key={m.groundTruthId} style={{ verticalAlign: 'top' }}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    <span style={{ color: m.detected ? 'var(--success)' : 'var(--warning)' }}>
                      {m.detected ? '✓' : '—'}
                    </span>{' '}
                    {m.kind.replace(/_/g, ' ').toLowerCase()}
                  </td>
                  <td className="num" style={td}>
                    {formatCount(m.affectedPayments)}
                  </td>
                  <td style={td}>
                    {m.detected ? (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {m.allDimensions.slice(0, 4).join(', ')}
                        {m.allDimensions.length > 4 ? ` +${m.allDimensions.length - 4}` : ''}
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                        {m.missReason ?? 'not detected'}
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {(() => {
                      const r = rcaByKind.get(m.kind);
                      if (!r) return <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>;
                      return (
                        <span className="mono" style={{ fontSize: 11 }}>
                          <span style={{ color: r.top1Correct ? 'var(--success)' : 'var(--warning)' }}>
                            {r.top1Correct ? '✓' : '≠'}
                          </span>{' '}
                          <span style={{ color: 'var(--text-secondary)' }}>{r.top1}</span>
                        </span>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card" style={{ marginTop: 8 }}>
        <div className="label">Detected incidents ({incidents.length})</div>
        {incidents.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 10 }}>
            None yet. Press Play on the Command Center — the detector needs 24 simulated hours of
            baseline before it can judge anything.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                <th style={th}>Slice</th>
                <th style={th}>Status</th>
                <th style={th}>Opened</th>
                <th style={thR}>Baseline</th>
                <th style={thR}>Current</th>
                <th style={thR}>z</th>
                <th style={thR}>Payments</th>
                <th style={thR}>At risk</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.id} style={{ height: 32 }}>
                  <td style={td}>
                    <Link
                      href={`/incidents/${i.id}`}
                      className="mono"
                      style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 12 }}
                    >
                      {i.dimension}={i.dimension_value}
                    </Link>
                  </td>
                  <td style={{ ...td, color: i.status === 'OPEN' ? 'var(--info)' : 'var(--text-tertiary)' }}>
                    {i.status.toLowerCase()}
                  </td>
                  <td className="mono" style={{ ...td, color: 'var(--text-tertiary)', fontSize: 11 }}>
                    {i.opened_at.slice(5, 16).replace('T', ' ')}
                  </td>
                  <td className="num" style={td}>{formatPct(i.baseline_rate)}</td>
                  <td className="num" style={{ ...td, color: 'var(--danger)' }}>
                    {formatPct(i.current_rate)}
                  </td>
                  <td className="num" style={td}>{i.z_score.toFixed(1)}</td>
                  <td className="num" style={td}>{formatCount(i.affected_payments)}</td>
                  <td className="num" style={td} title={exactPaise(i.revenue_at_risk_paise)}>
                    <span title={exactPaise(i.revenue_at_risk_paise)}>{formatInrCompact(i.revenue_at_risk_paise)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
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
const td: React.CSSProperties = { fontSize: 12, padding: '6px 8px 6px 0' };

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone?: 'success' | 'danger' | undefined;
}) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div
        className="metric"
        style={{
          marginTop: 2,
          color:
            tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text)',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>
        {note}
      </div>
    </div>
  );
}
