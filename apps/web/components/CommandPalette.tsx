'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { simApi } from '@/lib/sim';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8090';

interface Item {
  id: string;
  label: string;
  hint: string;
  href?: string;
  run?: () => Promise<void>;
}

const PAGES: Item[] = [
  { id: 'page:/', label: 'Command Center', hint: 'g h', href: '/' },
  { id: 'page:/incidents', label: 'Incidents', hint: 'g i', href: '/incidents' },
  { id: 'page:/recovery', label: 'Recovery', hint: 'g r', href: '/recovery' },
  { id: 'page:/policy', label: 'Policy', hint: 'g p', href: '/policy' },
  { id: 'page:/model', label: 'Model card', hint: 'g m', href: '/model' },
  { id: 'page:/whatif', label: 'What-if', hint: 'g w', href: '/whatif' },
  { id: 'page:/simulator', label: 'Simulator', hint: 'g s', href: '/simulator' },
];

const CHORDS: Record<string, string> = { h: '/', i: '/incidents', r: '/recovery', p: '/policy', m: '/model', w: '/whatif', s: '/simulator' };

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/**
 * ⌘K palette and the keyboard chords (§11.1): `g i` incidents, `g r`
 * recovery, `g p` policy (and h/m/w/s), `Space` toggles the simulator.
 * The palette searches pages, open incidents, recent cases and — for any
 * `pay_` id typed in — the audit trail.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [dynamic, setDynamic] = useState<Item[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const chord = useRef<{ key: string; at: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [inc, cases] = await Promise.all([
        fetch(`${BASE}/api/v1/incidents?status=ALL`, { cache: 'no-store' }).then((r) => r.json() as Promise<{ incidents: { id: string; dimension: string; dimension_value: string; status: string; z_score: number }[] }>),
        fetch(`${BASE}/api/v1/cases?limit=100`, { cache: 'no-store' }).then((r) => r.json() as Promise<{ cases: { id: string; payment_id: string; status: string; chosen_strategy: string | null; amount_paise: number }[] }>),
      ]);
      setDynamic([
        ...inc.incidents.slice(0, 50).map((i) => ({ id: `inc:${i.id}`, label: `${i.dimension}=${i.dimension_value} · z ${i.z_score.toFixed(1)}`, hint: `incident · ${i.status}`, href: `/incidents/${i.id}` })),
        ...cases.cases.map((c) => ({ id: `case:${c.id}`, label: `${c.payment_id} · ${c.chosen_strategy ?? '—'} · ₹${Math.round(c.amount_paise / 100).toLocaleString('en-IN')}`, hint: `case · ${c.status}`, href: `/recovery/${c.id}` })),
      ]);
    } catch {
      setDynamic([]);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open) {
        if (e.key === 'Escape') setOpen(false);
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') {
        e.preventDefault();
        void simApi.state().then((s) => (s.clock.running ? simApi.pause() : simApi.start())).then(() => {
          setNote('simulator toggled');
          router.refresh();
          setTimeout(() => setNote(null), 1200);
        }).catch(() => setNote('cannot reach the API'));
        return;
      }
      const now = Date.now();
      if (e.key === 'g') {
        chord.current = { key: 'g', at: now };
        return;
      }
      if (chord.current && now - chord.current.at < 1200 && CHORDS[e.key]) {
        chord.current = null;
        router.push(CHORDS[e.key]!);
        return;
      }
      chord.current = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, router]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    void load();
    setTimeout(() => input.current?.focus(), 0);
  }, [open, load]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...PAGES, ...dynamic];
    const matched = q ? all.filter((i) => i.label.toLowerCase().includes(q) || i.hint.toLowerCase().includes(q)) : all.slice(0, 12);
    if (q.startsWith('pay_') && !matched.some((i) => i.id === `audit:${q}`)) {
      matched.unshift({ id: `audit:${q}`, label: `Audit trail for ${q}`, hint: 'event → outcome', href: `/audit/${q}` });
    }
    return matched.slice(0, 14);
  }, [query, dynamic]);

  const go = (item: Item) => {
    setOpen(false);
    if (item.href) router.push(item.href);
    else void item.run?.();
  };

  return (
    <>
      {note && <div style={{ position: 'fixed', bottom: 16, right: 16, fontSize: 11, padding: '6px 10px', border: '1px solid var(--border-strong)', background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', zIndex: 60 }}>{note}</div>}
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '14vh' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 620, padding: 0, overflow: 'hidden' }} role="dialog" aria-label="Command palette">
            <input
              ref={input}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(items.length - 1, s + 1)); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)); }
                if (e.key === 'Enter' && items[selected]) go(items[selected]!);
              }}
              placeholder="Jump to a page, an incident, a case, or type a pay_ id for its audit trail…"
              style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', outline: 'none' }}
            />
            <ul style={{ listStyle: 'none', margin: 0, padding: 4, maxHeight: 380, overflow: 'auto' }}>
              {items.map((item, i) => (
                <li key={item.id} onMouseEnter={() => setSelected(i)} onClick={() => go(item)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: i === selected ? 'var(--bg-hover)' : 'transparent', fontSize: 12 }}>
                  <span className={item.id.startsWith('page:') ? '' : 'mono'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{item.hint}</span>
                </li>
              ))}
              {items.length === 0 && <li style={{ padding: '10px', fontSize: 12, color: 'var(--text-tertiary)' }}>Nothing matches.</li>}
            </ul>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
              ↑↓ move · ↵ open · esc close · g i / g r / g p / g s jump · space toggles the simulator
            </div>
          </div>
        </div>
      )}
    </>
  );
}
