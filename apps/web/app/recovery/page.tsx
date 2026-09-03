import Link from 'next/link';
import { fetchCases } from '@/lib/api';
import { formatInrCompact, formatPct, formatCount, exactPaise } from '@/lib/format';
import { SourceBadge } from '@/components/SourceBadge';

export const dynamic = 'force-dynamic';

/**
 * `/recovery` — the decision story (§11.2).
 *
 * Every row carries `P(recovery)` **with its source badge**. Until a model is
 * trained (P10) every badge reads `baseline`; when the model is deleted live on
 * stage they flip back. The strategy choice, the EV and the policy verdict
 * arrive in P11–P12.
 */
export default async function RecoveryPage() {
  const { cases, stats } = await fetchCases(undefined, 150);
  const mix = stats.probability_source_mix;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>
          ← Command Center
        </Link>
        <h1 className="section-title" style={{ margin: '6px 0 0' }}>
          Recovery
        </h1>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Tile label="Open cases" value={formatCount(stats.open)} note={`${formatCount(stats.total)} opened in total`} />
        <Tile
          label="Recoverable (EV)"
          value={stats.open > 0 ? formatInrCompact(stats.expected_recoverable_paise) : '—'}
          note={stats.open > 0 ? 'Σ amount × P(recovery), over open cases — an expectation, not a promise' : 'not measured — no open cases'}
          titlePaise={stats.expected_recoverable_paise}
          tone="accent"
        />
        <Tile
          label="Scored by model"
          value={formatCount(mix.model)}
          note={mix.model === 0 ? 'no model trained yet — every case is priced from the measured baseline' : 'predictions from the trained model'}
        />
        <Tile
          label="Scored by baseline"
          value={formatCount(mix.baseline)}
          note="from the §7.5 family-rate table — a measured fallback, not a constant"
        />
      </section>

      <section className="card" style={{ marginTop: 8 }}>
        <div className="label">Cases ({cases.length} most recent)</div>
        {cases.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 10 }}>
            None yet. Cases open for every unresolved failure once the replay is running.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                <th style={th}>Payment</th>
                <th style={thR}>Amount</th>
                <th style={th}>Failure</th>
                <th style={thR}>P(recovery)</th>
                <th style={th}>Source</th>
                <th style={th}>Strategy</th>
                <th style={thR}>EV</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} style={{ height: 32 }}>
                  <td style={td}>
                    <Link href={`/recovery/${c.id}`} className="mono" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 11 }}>
                      {c.payment_id}
                    </Link>
                    {c.is_international && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--warning)' }}>intl</span>
                    )}
                    <Link href={`/audit/${c.payment_id}`} title="audit trail" style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-tertiary)', textDecoration: 'none' }}>audit</Link>
                  </td>
                  <td className="num" style={td} title={exactPaise(c.amount_paise)}>
                    {formatInrCompact(c.amount_paise)}
                  </td>
                  <td style={td}>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--danger)' }}>
                      {c.failure_code ?? (c.abandoned ? 'CHECKOUT_ABANDONED' : '—')}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 6 }}>{c.method}</span>
                  </td>
                  <td className="num" style={td}>{formatPct(c.recovery_probability, 0)}</td>
                  <td style={td}><SourceBadge source={c.probability_source} /></td>
                  <td style={{ ...td, color: c.chosen_strategy === 'do_nothing' ? 'var(--text-tertiary)' : c.chosen_strategy === 'alternate_gateway' ? 'var(--accent)' : 'var(--text)' }}>
                    <span className="mono" style={{ fontSize: 11 }}>{c.chosen_strategy ?? '—'}</span>
                  </td>
                  <td className="num" style={{ ...td, color: (c.expected_value_paise ?? 0) > 0 ? 'var(--text)' : 'var(--text-tertiary)' }} title={c.expected_value_paise === null ? undefined : exactPaise(c.expected_value_paise)}>
                    {c.expected_value_paise === null ? '—' : formatInrCompact(c.expected_value_paise)}
                  </td>
                  <td style={{ ...td, color: c.status === 'OPEN' ? 'var(--info)' : 'var(--text-tertiary)' }}>
                    {c.status.toLowerCase()}
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

const th: React.CSSProperties = { textAlign: 'left', fontWeight: 510, padding: '0 8px 6px 0', borderBottom: '1px solid var(--border)' };
const thR: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 8px 4px 0' };

function Tile({ label, value, note, tone, titlePaise }: { label: string; value: string; note: string; tone?: 'accent' | undefined; titlePaise?: number | undefined }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="metric" style={{ marginTop: 2, color: tone === 'accent' ? 'var(--accent)' : 'var(--text)' }} title={titlePaise !== undefined ? exactPaise(titlePaise) : undefined}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
