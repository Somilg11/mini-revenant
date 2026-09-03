import Link from 'next/link';
import { api } from '@/lib/api';
import { formatInrCompact, formatCount, exactPaise } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Rules { policy_version: string; rules: { rule: number; name: string; verdict: string; description: string }[]; brand_snippet: string }
interface Decisions { decisions: { id: string; case_id: string; payment_id: string; proposed_action: string; verdict: string; amount_paise: number; decided_at: string; reasons: { rules?: { passed: boolean; rule: number }[]; deferred?: boolean } }[]; counts: Record<string, number>; policy_version: string }

/**
 * `/policy` — the twelve rules, the version, and the append-only decision log
 * with ALLOW, DENY and REQUIRE_APPROVAL together (§11.2).
 *
 * The `PolicyApprovedAction` snippet is on the page on purpose: the guardrail
 * is a compile error, and a screenshot of the type says it faster than prose.
 */
export default async function PolicyPage() {
  const [rules, log] = await Promise.all([
    api<Rules>('/api/v1/policy/rules').catch((): Rules | null => null),
    api<Decisions>('/api/v1/policy/decisions?limit=80').catch((): Decisions | null => null),
  ]);
  const counts = log?.counts ?? { ALLOW: 0, DENY: 0, REQUIRE_APPROVAL: 0 };
  const total = (counts.ALLOW ?? 0) + (counts.DENY ?? 0) + (counts.REQUIRE_APPROVAL ?? 0);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Command Center</Link>
        <h1 className="section-title" style={{ margin: '6px 0 0' }}>Policy <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>{rules?.policy_version}</span></h1>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Tile label="Decisions" value={formatCount(total)} note="every one persisted, ALLOWs included" />
        <Tile label="Allowed" value={formatCount(counts.ALLOW ?? 0)} note="cleared by all twelve rules" tone="success" />
        <Tile label="Denied" value={formatCount(counts.DENY ?? 0)} note="refused — on the payment the case closes; on capacity alone it waits" tone="danger" />
        <Tile label="Awaiting approval" value={formatCount(counts.REQUIRE_APPROVAL ?? 0)} note="a human signs for large money, or for a retry into a live outage" tone="warning" />
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
        <div className="card">
          <div className="label">The twelve rules, in order — all evaluated, always</div>
          <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
            {(rules?.rules ?? []).map((r) => (
              <li key={r.rule} style={{ display: 'grid', gridTemplateColumns: '48px 190px 1fr', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12, alignItems: 'baseline' }}>
                <span className="mono" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>{r.rule}</span>
                <span>{r.name} <span className="mono" style={{ fontSize: 10, color: r.verdict === 'DENY' ? 'var(--danger)' : 'var(--warning)' }}>{r.verdict}</span></span>
                <span style={{ color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{r.description}</span>
              </li>
            ))}
          </ol>
        </div>
        <div className="card">
          <div className="label">The guardrail is a compile error</div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '6px 0 10px' }}>
            The executor&apos;s signature accepts only <span className="mono">PolicyApprovedAction</span>, a branded
            type whose constructor is not exported. <span className="mono">approve()</span> returns one only for an
            ALLOW, or a REQUIRE_APPROVAL a human has resolved. Bypassing the gate is a type error, not a review comment.
          </p>
          <pre className="mono" style={{ fontSize: 11, color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 12, margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{rules?.brand_snippet}</pre>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '10px 0 0' }}>
            A test asserts that a plain object cannot be assigned to the type. Delete the brand and the build fails.
          </p>
        </div>
      </section>

      <section className="card" style={{ marginTop: 8 }}>
        <div className="label">Decision log (newest first)</div>
        {(log?.decisions.length ?? 0) === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 10 }}>No decisions yet — the gate runs once cases have a strategy.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead><tr style={{ color: 'var(--text-secondary)', fontSize: 11 }}><th style={th}>Verdict</th><th style={th}>Proposed</th><th style={th}>Case</th><th style={thR}>Amount</th><th style={th}>Failed rules</th><th style={th}>At</th></tr></thead>
            <tbody>
              {log!.decisions.map((d) => {
                const failed = (d.reasons.rules ?? []).filter((r) => !r.passed).map((r) => r.rule);
                const colour = d.verdict === 'ALLOW' ? 'var(--success)' : d.verdict === 'DENY' ? 'var(--danger)' : 'var(--warning)';
                return (
                  <tr key={d.id} style={{ height: 30 }}>
                    <td style={td}><span className="mono" style={{ color: colour, fontSize: 11 }}>{d.verdict}</span>{d.reasons.deferred && <span className="mono" style={{ fontSize: 9, color: 'var(--text-tertiary)', marginLeft: 6 }}>deferred</span>}</td>
                    <td style={td}><span className="mono" style={{ fontSize: 11 }}>{d.proposed_action}</span></td>
                    <td style={td}><Link href={`/recovery/${d.case_id}`} className="mono" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 11 }}>{d.payment_id}</Link> <Link href={`/audit/${d.payment_id}`} style={{ fontSize: 10, color: 'var(--text-tertiary)', textDecoration: 'none' }}>audit</Link></td>
                    <td className="num" style={td} title={exactPaise(d.amount_paise)}>{formatInrCompact(d.amount_paise)}</td>
                    <td style={{ ...td, color: 'var(--text-tertiary)' }} className="mono">{failed.length ? failed.map((r) => `#${r}`).join(' ') : '—'}</td>
                    <td className="mono" style={{ ...td, color: 'var(--text-tertiary)', fontSize: 11 }}>{d.decided_at.replace('T', ' ').slice(5, 16)}</td>
                  </tr>
                );
              })}
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

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'success' | 'danger' | 'warning' | undefined }) {
  const c = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--text)';
  return (<div className="card"><div className="label">{label}</div><div className="metric" style={{ marginTop: 2, color: c }}>{value}</div><div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div></div>);
}
