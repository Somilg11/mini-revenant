'use client';

import { useEffect } from 'react';

/**
 * Route-level error boundary. Catches anything a page throws during render.
 *
 * The demo runs live, so a boundary that says "something went wrong" is worth
 * nothing on stage. This one shows the actual message and the digest, which is
 * what ties the screen to a line in the API log.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[boundary]', error);
  }, [error]);

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '96px 24px' }}>
      <div className="label" style={{ color: 'var(--danger)' }}>
        Render failed
      </div>
      <h1 className="section-title" style={{ margin: '6px 0 16px' }}>
        This page could not be rendered
      </h1>

      <div className="card">
        <pre
          className="mono"
          style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {error.message}
        </pre>
        {error.digest && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
            digest <span className="mono">{error.digest}</span>
          </div>
        )}
      </div>

      <button
        onClick={reset}
        style={{
          marginTop: 16,
          padding: '6px 12px',
          fontSize: 13,
          fontFamily: 'inherit',
          color: 'var(--text)',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
        }}
      >
        Try again
      </button>

      <p style={{ marginTop: 24, fontSize: 12, color: 'var(--text-tertiary)' }}>
        If the API is not running: <span className="mono">bun dev</span>. If Postgres is
        not running: <span className="mono">bun db:up</span>.
      </p>
    </main>
  );
}
