/**
 * `direct` / `assisted` / `organic` / `lost` / `unattributed` (§11.3).
 *
 * Organic is rendered as plainly as the credited kinds, because "the money
 * came back and it was not us" is a result worth showing, not hiding. Where
 * verification has not run the badge says so rather than implying credit.
 */
export type AttributionKind = 'direct' | 'assisted' | 'organic' | 'lost' | 'unattributed';

const STYLE: Record<AttributionKind, { colour: string; label: string; title: string }> = {
  direct: { colour: 'var(--success)', label: 'direct', title: 'captured within 30 simulated minutes of our action, with our gateway reference — credited in full' },
  assisted: { colour: 'var(--accent)', label: 'assisted', title: 'captured within 6 simulated hours of our action, different reference — credited in full' },
  organic: { colour: 'var(--text-tertiary)', label: 'organic', title: 'came back on its own — credits zero' },
  lost: { colour: 'var(--danger)', label: 'lost', title: 'the assist window passed with no capture' },
  unattributed: { colour: 'var(--text-tertiary)', label: 'unattributed', title: 'verification has not run — no credit is implied' },
};

export function AttributionBadge({ kind }: { kind: AttributionKind }) {
  const s = STYLE[kind];
  return (
    <span
      className="mono"
      title={s.title}
      style={{ fontSize: 10, color: s.colour, border: `1px solid ${s.colour}`, borderRadius: 4, padding: '1px 6px', letterSpacing: 0.3 }}
    >
      {s.label}
    </span>
  );
}
