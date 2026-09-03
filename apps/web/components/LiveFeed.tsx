'use client';

import { useEventStream } from '@/lib/stream';
import { formatInrCompact } from '@/lib/format';

/**
 * The live activity feed (§11.2), newest first, one line per event.
 *
 * Fed by Server-Sent Events, which the API pushes only after the writing
 * transaction commits — so a row here has definitely happened. New rows fade
 * in over 150 ms and never slide (§11.1).
 */
const TONE: Record<string, string> = {
  CAPTURED: 'var(--success)',
  FAILED: 'var(--danger)',
  ATTEMPTED: 'var(--text-secondary)',
  AUTHORIZED: 'var(--info)',
  CREATED: 'var(--text-tertiary)',
  REFUNDED: 'var(--warning)',
};

export function LiveFeed() {
  const { events, connected } = useEventStream(40);

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 320 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="label">Live activity</div>
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)' }}
          title={connected ? 'Server-Sent Events connected' : 'Not connected to the event stream'}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: connected ? 'var(--success)' : 'var(--text-tertiary)',
            }}
          />
          {connected ? 'streaming' : 'idle'}
        </span>
      </div>

      <div style={{ marginTop: 10, flex: 1, overflow: 'hidden' }}>
        {events.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', paddingTop: 8, lineHeight: 1.8 }}>
            Nothing yet. Press <span className="mono">▶ Play</span> to replay seven days of
            payments through the real ingest path.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((e) => {
              const to = String(e.data.to ?? '');
              const amount = typeof e.data.amount_paise === 'number' ? e.data.amount_paise : null;
              return (
                <li
                  key={e.id}
                  className="row-enter"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    height: 22,
                    fontSize: 12,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span
                    className="mono"
                    style={{ color: TONE[to] ?? 'var(--text-secondary)', width: 78, flexShrink: 0 }}
                  >
                    {to || e.topic}
                  </span>
                  <span
                    className="mono"
                    style={{ color: 'var(--text-tertiary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {typeof e.data.payment_id === 'string' ? (
                      <a href={`/audit/${e.data.payment_id}`} title="audit trail" style={{ color: 'inherit', textDecoration: 'none' }}>{e.data.payment_id}</a>
                    ) : ''}
                  </span>
                  {typeof e.data.failure_code === 'string' && (
                    <span style={{ color: 'var(--danger)', fontSize: 11 }}>{e.data.failure_code}</span>
                  )}
                  {amount !== null && (
                    <span className="num mono" style={{ color: 'var(--text-secondary)', width: 64 }} title={`${amount.toLocaleString('en-IN')} paise`}>
                      {formatInrCompact(amount)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
