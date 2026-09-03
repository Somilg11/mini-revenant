import Link from 'next/link';
import { fetchEvaluation } from '@/lib/api';
import { simApi, type SimState } from '@/lib/sim';
import { SimControlBar } from '@/components/SimControlBar';
import { SimulatorPanel } from '@/components/SimulatorPanel';

export const dynamic = 'force-dynamic';

/** `/simulator` — the answer key, the scoreboard and the two demo levers (§11.2). */
export default async function SimulatorPage() {
  const [sim, evaluation] = await Promise.all([
    simApi.state().catch((): SimState | null => null),
    fetchEvaluation(),
  ]);
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: '40px 24px 64px' }}>
      <header style={{ marginBottom: 20 }}>
        <Link href="/" style={{ color: 'var(--text-tertiary)', fontSize: 11, textDecoration: 'none' }}>← Command Center</Link>
        <h1 className="section-title" style={{ margin: '6px 0 0' }}>Simulator</h1>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          The dataset is generated from one seed with five incidents and two noise windows injected; the detector never sees this page&apos;s answer key. Precision, recall and RCA accuracy are measured against it — a detector that fires on everything scores badly here.
        </div>
      </header>
      <SimControlBar initial={sim} />
      <SimulatorPanel initial={sim} evaluation={evaluation} />
    </main>
  );
}
