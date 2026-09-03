import Link from 'next/link';
import type { AuditNode } from '@/lib/api';
import { SourceBadge } from '@/components/SourceBadge';
import { AttributionBadge } from '@/components/AttributionBadge';

const STAGE_LABEL: Record<AuditNode['stage'], string> = {
  event: 'EVENT',
  transition: 'TRANSITION',
  detection: 'DETECTION',
  diagnosis: 'DIAGNOSIS',
  case: 'CASE',
  agent: 'AGENT DECISION',
  policy: 'POLICY',
  action: 'ACTION',
  outcome: 'OUTCOME',
};

const STAGE_COLOUR: Record<AuditNode['stage'], string> = {
  event: 'var(--text-secondary)',
  transition: 'var(--text-secondary)',
  detection: 'var(--danger)',
  diagnosis: 'var(--warning)',
  case: 'var(--info)',
  agent: 'var(--accent)',
  policy: 'var(--warning)',
  action: 'var(--accent)',
  outcome: 'var(--success)',
};

/**
 * One vertical timeline, event → outcome, in causal order (§11.2).
 *
 * Every node shows its timestamp, its inputs and the artefact it produced.
 * Where a stage stored its inputs, the API recomputed it on this request and
 * the node says whether it reproduced — that is the claim the page makes.
 */
export function AuditTimeline({ nodes }: { nodes: AuditNode[] }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, position: 'relative' }}>
      <div style={{ position: 'absolute', left: 119, top: 8, bottom: 8, width: 1, background: 'var(--border)' }} aria-hidden />
      {nodes.map((n) => (
        <li key={`${n.stage}:${n.id}`} style={{ display: 'grid', gridTemplateColumns: '104px 32px 1fr', gap: 0, padding: '10px 0', alignItems: 'start' }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', paddingTop: 3, textAlign: 'right', paddingRight: 8 }}>
            {n.at.replace('T', ' ').slice(5, 19)}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 5, background: STAGE_COLOUR[n.stage], border: '2px solid var(--bg)', boxShadow: `0 0 0 1px ${STAGE_COLOUR[n.stage]}` }} />
          </div>
          <div className="card" style={{ padding: '8px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span className="mono" style={{ fontSize: 10, letterSpacing: '0.06em', color: STAGE_COLOUR[n.stage], fontWeight: 510 }}>{STAGE_LABEL[n.stage]}</span>
              <span style={{ fontSize: 12, color: 'var(--text)' }}>{n.title}</span>
              {n.stage === 'agent' && typeof n.artefact.source === 'string' && <SourceBadge source={n.artefact.source} />}
              {n.stage === 'diagnosis' && typeof n.artefact.narrative_source === 'string' && <SourceBadge source={n.artefact.narrative_source} />}
              {n.stage === 'case' && typeof n.inputs.probability_source === 'string' && <SourceBadge source={n.inputs.probability_source} />}
              {n.stage === 'outcome' && <AttributionBadge kind={n.artefact.actual_recovered ? (n.artefact.attribution as 'direct' | 'assisted' | 'organic') : 'lost'} />}
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{n.id}</span>
              {n.href && <Link href={n.href} style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>open →</Link>}
            </div>
            {n.reproduced && (
              <div style={{ marginTop: 6, fontSize: 11, color: n.reproduced.ok ? 'var(--success)' : 'var(--danger)' }}>
                {n.reproduced.ok ? '✓ reproduced' : '✗ did not reproduce'} — {n.reproduced.detail}
              </div>
            )}
            {(n.stage === 'agent' || n.stage === 'diagnosis') && typeof n.artefact.narrative === 'string' && (
              <p style={{ margin: '6px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)' }}>{n.artefact.narrative}</p>
            )}
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 11, color: 'var(--text-tertiary)', cursor: 'pointer' }}>inputs and artefact</summary>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 6 }}>
                <Json label="inputs" value={n.inputs} />
                <Json label="artefact" value={n.artefact} />
              </div>
            </details>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="label" style={{ fontSize: 10 }}>{label}</div>
      <pre className="mono" style={{ fontSize: 10, lineHeight: 1.5, margin: '4px 0 0', padding: 8, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto' }}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
