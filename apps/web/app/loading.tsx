export default function Loading() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 24px' }}>
      <div className="label">Revenant Mini</div>
      <h1 className="section-title" style={{ margin: '6px 0 24px' }}>
        Command Center
      </h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card">
            <div className="label" style={{ color: 'var(--text-tertiary)' }}>
              Loading
            </div>
            <div className="metric" style={{ color: 'var(--text-tertiary)' }}>
              —
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
