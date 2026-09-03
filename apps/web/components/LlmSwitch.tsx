'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { LlmStatus } from '@/lib/api';
import { SourceBadge } from '@/components/SourceBadge';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

/**
 * The §14 resilience demonstration, live: switch the language model off in
 * front of whoever is watching, and every new narrative reads `template`,
 * every new proposal `fallback` — with identical choices. Switching it back
 * on only lifts the runtime override; it cannot invent a key.
 */
export function LlmSwitch({ initial }: { initial: LlmStatus }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const [, start] = useTransition();

  const runtimeOff = status.reason === 'switched off at runtime';
  const canToggle = status.enabled || runtimeOff;

  const flip = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/v1/llm/${status.enabled ? 'off' : 'on'}`, { method: 'POST' });
      if (res.ok) {
        setStatus((await res.json()) as LlmStatus);
        start(() => router.refresh());
      }
    } catch {
      // The API is unreachable; the banner on the page already says so.
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }} title={status.reason ?? `${status.provider} · ${status.model}`}>
      <SourceBadge source={status.enabled ? 'llm' : 'template'} />
      <span className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        {status.enabled ? `${status.provider} · ${status.model}` : (status.reason ?? 'off')}
      </span>
      {canToggle && (
        <button
          onClick={flip}
          disabled={busy}
          style={{ fontFamily: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 'var(--radius)', cursor: 'pointer', border: '1px solid var(--border-strong)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
        >
          {busy ? '…' : status.enabled ? 'switch LLM off' : 'switch LLM on'}
        </button>
      )}
    </span>
  );
}
