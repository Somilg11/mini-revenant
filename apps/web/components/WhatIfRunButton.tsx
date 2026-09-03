'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

/** Re-runs both arms on the current labels and model, then refreshes the page. */
export function WhatIfRunButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const [, start] = useTransition();
  const run = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${BASE}/api/v1/simulation/whatif`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setMessage(body.error?.message ?? `failed (${res.status})`);
      } else {
        start(() => router.refresh());
      }
    } catch {
      setMessage('cannot reach the API');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <button onClick={run} disabled={busy} style={{ fontFamily: 'inherit', fontSize: 12, padding: '6px 14px', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 510, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' }}>
        {busy ? 'running…' : label}
      </button>
      {message && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{message}</span>}
    </span>
  );
}
