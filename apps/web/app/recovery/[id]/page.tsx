import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchCase } from '@/lib/api';
import { formatInrCompact, formatPct, exactPaise } from '@/lib/format';
import { SourceBadge } from '@/components/SourceBadge';
import { StrategyComparison } from '@/components/StrategyComparison';
import { PolicyRuleList } from '@/components/PolicyRuleList';
import { ApprovalBar } from '@/components/ApprovalBar';

export const dynamic = 'force-dynamic';

const STRATEGY_LABELS: Record<string, string> = {
  retry: 'Retry — same route, later',
  payment_link: 'Payment link — ask the customer again',
  alternate_method: 'Alternate method — a different instrument',
  alternate_gateway: 'Alternate gateway — same card, second processor',
};

/**
 * `/recovery/[id]` — one case, its probability, and the odds behind it.
 *
 * P9 shows what each intervention is worth. The expected-value comparison with
 * costs, the winner, and the twelve policy rules land in P11–P12.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail;
  try {
    detail = await fetchCase(id);
  } catch {
    notFound();
  }
  const { case: c, odds, features, decision, policy } = detail;
  const latest = policy.at(-1) ?? null;
  const awaiting = latest?.verdict === 'REQUIRE_APPROVAL' && c.status === 'OPEN';
  const code = c.failure_code ?? (c.abandoned ? 'CHECKOUT_ABANDONED' : '—');
  const ev = c.recovery_probability === null ? null : Math.round(c.recovery_probability * c.amount_paise);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/recovery" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Recovery</Link>
        <h1 className="section-title" style={{ margin: '6px 0 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span className="mono">{c.payment_id}</span>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: c.status === 'OPEN' ? 'var(--info)' : 'var(--text-tertiary)' }}>{c.status}</span>
        </h1>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          case <span className="mono">{c.id}</span> · opened <span className="mono">{c.opened_at.replace('T', ' ').slice(0, 19)}</span> UTC
        </div>
      </header>

      {awaiting && <ApprovalBar caseId={c.id} amount={formatInrCompact(c.amount_paise)} />}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <Tile label="Amount" value={formatInrCompact(c.amount_paise)} note={`${c.method}${c.is_international ? ' · international' : ''}${c.card_network ? ` · ${c.card_network}` : ''}`} titlePaise={c.amount_paise} />
        <Tile label="Failure" value={code} note={`payment is ${c.payment_state.toLowerCase()}${c.abandoned ? ', abandoned' : ''}`} mono tone="danger" />
        <div className="card">
          <div className="label">P(recovery)</div>
          <div className="metric" style={{ marginTop: 2, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {formatPct(c.recovery_probability, 0)}
            <SourceBadge source={c.probability_source} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            {c.probability_source === 'baseline' ? 'from the measured §7.5 family rates — no model active' : 'from the trained model'}
          </div>
        </div>
        <Tile label="Expected value" value={ev === null ? '—' : formatInrCompact(ev)} note="amount × P(recovery) — an expectation, not a promise" titlePaise={ev ?? undefined} tone="accent" />
      </section>

      {decision && (
        <section style={{ marginTop: 8 }}>
          <StrategyComparison options={decision.options} chosen={decision.chosen} multiplier={decision.customer_multiplier} />
        </section>
      )}

      {latest && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">Policy gate</div>
          <div style={{ marginTop: 8 }}>
            {latest.reasons.rules?.length ? (
              <PolicyRuleList rules={latest.reasons.rules} verdict={latest.verdict} version={latest.policy_version} inputHash={latest.input_hash} />
            ) : (
              <div style={{ fontSize: 12, color: 'var(--danger)' }}>
                <span className="mono" style={{ fontSize: 15, fontWeight: 510 }}>{latest.verdict}</span>
                <span style={{ marginLeft: 10, color: 'var(--text-tertiary)' }}>rejected by a human — no rules evaluated</span>
              </div>
            )}
          </div>
          {policy.length > 1 && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 8 }}>{policy.length} decisions on this case — every one persisted.</div>}
        </section>
      )}

      {odds && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">Probability behind each intervention, before costs</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            From the measured §7.5 table, before the cost and friction applied above.
          </div>
          <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
            {(Object.entries(odds) as [keyof typeof odds, number][])
              .sort((a, b) => b[1] - a[1])
              .map(([name, p], i) => (
                <div key={name} style={{ display: 'grid', gridTemplateColumns: '260px 1fr 56px', alignItems: 'center', gap: 12, fontSize: 12 }}>
                  <span style={{ color: i === 0 ? 'var(--text)' : 'var(--text-secondary)' }}>{STRATEGY_LABELS[name] ?? name}</span>
                  <div style={{ height: 6, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${p * 100}%`, height: '100%', background: i === 0 ? 'var(--accent)' : 'var(--border-strong)' }} />
                  </div>
                  <span className="num mono" style={{ color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)' }}>{formatPct(p, 0)}</span>
                </div>
              ))}
          </div>
          {c.is_international && odds.alternate_gateway === Math.max(...Object.values(odds)) && (
            <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              The route failed, not the card. Retrying the same route re-runs the same challenge and
              fails identically; sending the same card through a second processor is the one
              intervention meaningfully above the floor (§1.1).
            </p>
          )}
        </section>
      )}

      {features && (
        <section className="card" style={{ marginTop: 8 }}>
          <div className="label">Features the probability was computed from</div>
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto 1fr)', gap: '4px 12px', margin: '10px 0 0', fontSize: 11 }}>
            {Object.entries(features).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--text-tertiary)' }}>{k}</dt>
                <dd className="mono" style={{ margin: 0, color: 'var(--text-secondary)' }}>{typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </main>
  );
}

function Tile({ label, value, note, tone, titlePaise, mono }: { label: string; value: string; note: string; tone?: 'danger' | 'accent' | undefined; titlePaise?: number | undefined; mono?: boolean | undefined }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className={mono ? 'mono' : 'metric'} style={{ marginTop: 2, fontSize: mono ? 15 : undefined, color: tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--text)' }} title={titlePaise !== undefined ? exactPaise(titlePaise) : undefined}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
