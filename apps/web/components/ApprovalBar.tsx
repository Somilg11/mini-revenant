'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

/**
 * Approve / Reject for a REQUIRE_APPROVAL (§11.2).
 *
 * Clicking Approve in front of a judge is the demo: the policy is re-evaluated
 * against current state, a human signs, and the action executes. A DENY at
 * re-evaluation still denies — a human can sign for large money, not override
 * a kill switch — and the reason comes back here.
 */
export function ApprovalBar({ caseId, amount }: { caseId: string; amount: string }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const [, start] = useTransition();

  const act = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/v1/cases/${caseId}/${kind}`, { method: 'POST' });
      const body = (await res.json()) as { error?: { message?: string; detail?: { failedRules?: string[] } }; action?: { kind: string } };
      if (!res.ok) {
        setMessage(`${body.error?.message ?? 'failed'}${body.error?.detail?.failedRules ? ' — ' + body.error.detail.failedRules.join('; ') : ''}`);
      } else {
        setMessage(kind === 'approve' ? `approved — ${body.action?.kind} will execute` : 'rejected');
        start(() => router.refresh());
      }
    } catch {
      setMessage('cannot reach the API');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
      <div style={{ flex: 1 }}>
        <div className="label" style={{ color: 'var(--warning)' }}>Requires approval</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
          {amount} is above the auto-approval limit. A human signs for large money.
          {message && <span style={{ marginLeft: 10, color: message.startsWith('approved') ? 'var(--success)' : 'var(--danger)' }}>{message}</span>}
        </div>
      </div>
      <button onClick={() => act('reject')} disabled={busy !== null} style={btn(false)}>{busy === 'reject' ? '…' : 'Reject'}</button>
      <button onClick={() => act('approve')} disabled={busy !== null} style={btn(true)}>{busy === 'approve' ? '…' : 'Approve'}</button>
    </div>
  );
}

const btn = (primary: boolean): React.CSSProperties => ({
  fontFamily: 'inherit', fontSize: 12, padding: '6px 14px', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 510,
  border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-strong)'}`,
  background: primary ? 'var(--accent)' : 'var(--bg-elevated)', color: primary ? '#fff' : 'var(--text)',
});
