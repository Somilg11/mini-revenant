import { describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { lastWhatIf, runWhatIf } from '../src/sim/whatif.ts';

/**
 * §8.7 against whatever dataset is loaded: both arms operate on an identical
 * set of failed payments, the run is stored as a pair, and the last run reads
 * back as it was written. Skipped on a database with no held-out rows — the
 * comparison needs a seed or a replay, and says so rather than failing.
 */

const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ground_truth_labels WHERE split = 'test'`;

describe('the what-if comparison', () => {
  test.skipIf(n === 0)('both arms see the same rows; the pair is stored and reads back', async () => {
    const run = await runWhatIf();
    const c = run.comparison;
    expect(c.baseline.failed).toBe(n);
    expect(c.agent.failed).toBe(n);
    expect(c.rows).toBe(n);
    expect(c.baseline.attempted).toBe(n);
    expect(c.agent.attempted + c.agent.declined.doNothing + c.agent.declined.denied + c.agent.declined.deferred).toBe(n);
    expect(c.baseline.international.failed + c.baseline.domestic.failed).toBe(n);
    expect(c.incrementalRevenuePaise).toBe(c.agent.revenueRecoveredPaise - c.baseline.revenueRecoveredPaise);
    expect(c.acceptance.international.totals.payments).toBeGreaterThanOrEqual(c.baseline.international.failed);

    const pair = await sql<{ kind: string }[]>`SELECT kind FROM simulations WHERE params->>'run_id' = ${run.run_id} ORDER BY kind`;
    expect(pair.map((p) => p.kind)).toEqual(['agent', 'baseline']);

    const back = await lastWhatIf();
    expect(back?.run_id).toBe(run.run_id);
    expect(back?.comparison.agent.recovered).toBe(c.agent.recovered);
    expect(back?.comparison.incrementalRevenuePaise).toBe(c.incrementalRevenuePaise);

    await sql`DELETE FROM simulations WHERE params->>'run_id' = ${run.run_id}`;
  });

  test.skipIf(n > 0)('with no held-out rows the run refuses rather than printing zeros', async () => {
    await expect(runWhatIf()).rejects.toThrow(/no held-out rows/);
  });
});
