import type { RecoveryAction } from '@/lib/api';
import { formatInrCompact } from '@/lib/format';

const KIND_LABELS: Record<string, string> = {
  retry_payment: 'Retry on the primary route',
  route_alternate_gateway: 'Route through the secondary processor',
  create_payment_link: 'Send a payment link',
  notify_customer: 'Ask for another method',
  escalate: 'Escalate to a person',
};

const STATUS_COLOUR: Record<RecoveryAction['status'], string> = {
  RESERVED: 'var(--text-tertiary)',
  SENT: 'var(--warning)',
  SUCCEEDED: 'var(--success)',
  FAILED: 'var(--danger)',
  ESCALATED: 'var(--warning)',
};

/**
 * The action with its idempotency key and attempts (§11.2).
 *
 * The key is on the page because it is the claim: it was reserved in the
 * database before the gateway was called, so the same approval can never be
 * sent twice. Attempts above one mean the gateway misbehaved and the retry
 * policy did its job; an error class says what kind of misbehaviour.
 */
export function ActionList({ actions }: { actions: RecoveryAction[] }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {actions.map((a) => (
        <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 12px', fontSize: 12, alignItems: 'baseline' }}>
          <span className="mono" style={{ color: STATUS_COLOUR[a.status], fontSize: 13, fontWeight: 510 }}>{a.status}</span>
          <span>
            {KIND_LABELS[a.kind] ?? a.kind}
            {a.error_class && <span className="mono" style={{ marginLeft: 8, fontSize: 10, color: a.error_class === 'TERMINAL' ? 'var(--danger)' : 'var(--warning)' }}>{a.error_class}</span>}
          </span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>idempotency key</span>
          <span className="mono" style={{ fontSize: 11 }}>{a.idempotency_key}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>attempts</span>
          <span className="mono" style={{ fontSize: 11 }}>
            {a.attempts}
            {a.attempts > 1 && <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>— the gateway misbehaved; capped backoff with jitter, then {a.status === 'ESCALATED' ? 'escalated rather than looped' : 'succeeded'}</span>}
          </span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>gateway reference</span>
          <span className="mono" style={{ fontSize: 11 }}>{a.gateway_reference ?? <span style={{ color: 'var(--text-tertiary)' }}>none — nothing reached the gateway</span>}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>cost</span>
          <span className="mono" style={{ fontSize: 11 }} title={`${a.cost_paise.toLocaleString('en-IN')} paise`}>{formatInrCompact(a.cost_paise)}</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>when</span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            reserved {a.created_at.replace('T', ' ').slice(0, 16)}
            {a.completed_at && ` · completed ${a.completed_at.replace('T', ' ').slice(0, 16)}`}
          </span>
        </div>
      ))}
    </div>
  );
}
