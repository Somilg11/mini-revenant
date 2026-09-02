'use client';

/**
 * Last-resort boundary: catches failures in the root layout itself, where the
 * normal error boundary has no shell left to render into. It must therefore
 * supply its own <html> and <body>, and cannot rely on globals.css having
 * loaded — hence the inline colours.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          background: '#08090a',
          color: '#f7f8f8',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          fontSize: 13,
          lineHeight: 1.6,
          margin: 0,
          padding: '96px 24px',
        }}
      >
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: '#eb5757',
            }}
          >
            Application error
          </div>
          <h1 style={{ fontSize: 15, fontWeight: 510, margin: '6px 0 16px' }}>
            The application shell failed to load
          </h1>
          <pre
            style={{
              background: '#0f1011',
              border: '1px solid #1f2023',
              borderRadius: 8,
              padding: 14,
              fontSize: 12,
              color: '#8a8f98',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
            {error.digest ? `\n\ndigest ${error.digest}` : ''}
          </pre>
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '6px 12px',
              fontSize: 13,
              color: '#f7f8f8',
              background: '#0f1011',
              border: '1px solid #2a2c31',
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
