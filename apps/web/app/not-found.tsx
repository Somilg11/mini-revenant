import Link from 'next/link';

export default function NotFound() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '96px 24px' }}>
      <div className="label">404</div>
      <h1 className="section-title" style={{ margin: '6px 0 16px' }}>
        No such page
      </h1>
      <Link href="/" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
        Back to the Command Center
      </Link>
    </main>
  );
}
