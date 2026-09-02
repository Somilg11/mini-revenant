import { exactPaise } from '@/lib/format';

/**
 * One metric, its value, and the inputs it was computed from.
 *
 * `inputs` is the point of this component: §10 requires every figure to carry
 * the two integers it came from, so any number on screen can be checked
 * against them rather than taken on trust. `measured: false` renders an em
 * dash with a label — "not measured" and "zero" are different claims
 * (invariant 6).
 */
export function MetricTile({
  label,
  value,
  measured = true,
  unmeasuredNote = 'not measured',
  inputs,
  titlePaise,
  tone,
}: {
  label: string;
  value: string;
  measured?: boolean;
  unmeasuredNote?: string;
  inputs?: string;
  // `| undefined` explicitly: with `exactOptionalPropertyTypes`, "absent" and
  // "present but undefined" are different types, and callers pass the latter.
  titlePaise?: number | undefined;
  tone?: 'danger' | 'success' | 'accent' | undefined;
}) {
  const colour =
    !measured ? 'var(--text-tertiary)'
    : tone === 'danger' ? 'var(--danger)'
    : tone === 'success' ? 'var(--success)'
    : tone === 'accent' ? 'var(--accent)'
    : 'var(--text)';

  return (
    <div className="card">
      <div className="label">{label}</div>
      <div
        className="metric"
        style={{ color: colour, marginTop: 2 }}
        title={titlePaise !== undefined ? exactPaise(titlePaise) : undefined}
      >
        {measured ? value : '—'}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
        {measured ? (inputs ?? ' ') : unmeasuredNote}
      </div>
    </div>
  );
}
