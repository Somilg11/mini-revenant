/**
 * `model` / `baseline` and `llm` / `template` (§11.3).
 *
 * Every probability carries the scorer that produced it and every narrative the
 * author that wrote it, and the UI shows both (§14). A number with no
 * provenance is a number nobody can weigh — and the demo proves the fallback
 * path live by watching these flip.
 */
export function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const strong = source === 'model' || source === 'llm';
  return (
    <span
      className="mono"
      title={
        strong
          ? source === 'model'
            ? 'Scored by the trained logistic model'
            : 'Written by the language model'
          : source === 'baseline'
            ? 'Scored from the measured family rates — no model active'
            : 'Deterministic template — no language model active'
      }
      style={{
        display: 'inline-block',
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 4,
        border: `1px solid ${strong ? 'var(--accent)' : 'var(--border-strong)'}`,
        color: strong ? 'var(--accent)' : 'var(--text-secondary)',
        background: strong ? 'var(--accent-subtle)' : 'transparent',
        letterSpacing: '0.02em',
        verticalAlign: 'middle',
      }}
    >
      {source}
    </span>
  );
}
