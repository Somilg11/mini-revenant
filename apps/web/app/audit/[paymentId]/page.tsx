import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchAudit, type AuditTrail } from '@/lib/api';
import { formatInrCompact, formatCount, exactPaise } from '@/lib/format';
import { AuditTimeline } from '@/components/AuditTimeline';

export const dynamic = 'force-dynamic';

/**
 * `/audit/[paymentId]` — the chain of custody (§11.2).
 *
 *   EVENT → DETECTION → DIAGNOSIS → AGENT DECISION → POLICY → ACTION → OUTCOME
 *
 * Every number on this page is reproducible from stored inputs. The header
 * says how many stages stored their inputs and how many reproduced on this
 * request — a count, not a promise.
 */
export default async function AuditPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await params;
  let trail: AuditTrail;
  try {
    trail = await fetchAudit(paymentId);
  } catch {
    notFound();
  }
  const p = trail.payment;
  const stages = ['event', 'detection', 'diagnosis', 'case', 'agent', 'policy', 'action', 'outcome'] as const;

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Command Center</Link>
        <h1 className="section-title" style={{ margin: '6px 0 0', display: 'flex', gap: 10, alignItems: 'baseline' }}>
          Audit <span className="mono">{p.id}</span>
          <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: p.state === 'CAPTURED' ? 'var(--success)' : p.state === 'FAILED' ? 'var(--danger)' : 'var(--text-tertiary)' }}>{p.state}</span>
        </h1>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }} className="mono">
          <span title={exactPaise(p.amount_paise)}>{formatInrCompact(p.amount_paise)}</span> · {p.method}{p.bank ? ` / ${p.bank}` : ''}{p.card_network ? ` / ${p.card_network}` : ''}{p.is_international ? ' · international' : ' · domestic'} · {p.merchant_id} · attempt {p.attempt_index}{p.failure_code ? ` · ${p.failure_code}` : ''}{p.abandoned ? ' · abandoned' : ''} · created {p.created_at.replace('T', ' ').slice(0, 19)}
        </div>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 8 }}>
        {stages.map((s) => (
          <div key={s} className="card" style={{ padding: '8px 10px' }}>
            <div className="label" style={{ fontSize: 9 }}>{s}</div>
            <div className="metric" style={{ fontSize: 18, marginTop: 2, color: (trail.counts[s] ?? 0) > 0 ? 'var(--text)' : 'var(--text-tertiary)' }}>{formatCount(trail.counts[s] ?? 0)}</div>
          </div>
        ))}
        <div className="card" style={{ padding: '8px 10px', borderColor: trail.reproduced.checked > 0 && trail.reproduced.ok === trail.reproduced.checked ? 'var(--success)' : 'var(--border)' }}>
          <div className="label" style={{ fontSize: 9 }}>reproduced</div>
          <div className="metric" style={{ fontSize: 18, marginTop: 2, color: trail.reproduced.checked === 0 ? 'var(--text-tertiary)' : trail.reproduced.ok === trail.reproduced.checked ? 'var(--success)' : 'var(--danger)' }}>
            {trail.reproduced.checked === 0 ? '—' : `${trail.reproduced.ok}/${trail.reproduced.checked}`}
          </div>
        </div>
      </section>

      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7, margin: '14px 0 10px' }}>
        Event, detection, diagnosis, decision, policy, action, outcome — in causal order, each with its inputs and the artefact it produced.
        Stages that stored their inputs were recomputed for this request and say whether they reproduced; the policy verdicts are re-evaluated from the stored input and their hash compared. Nothing here is a cached number.
      </p>

      <section className="card" style={{ marginTop: 8 }}>
        {trail.nodes.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No events recorded for this payment.</div>
        ) : (
          <AuditTimeline nodes={trail.nodes} />
        )}
      </section>
    </main>
  );
}
