import { closeDb, sql } from '../db/client.ts';
import { log } from '../lib/logger.ts';

/**
 * `bun sim:clear` — empty everything derived from events.
 *
 * The same truncation the simulator's reset performs, without regenerating the
 * dataset. Useful after pausing a replay part-way: a half-finished run leaves a
 * deep outbox backlog that makes integration tests fail for reasons unrelated
 * to the code under test.
 */
if (import.meta.main) {
  try {
    await sql`TRUNCATE
      outcome_verifications, recovery_actions, policy_decisions, agent_decisions,
      recovery_cases, incidents, ground_truth_labels, ground_truth_incidents,
      metrics_rollup, payment_state_transitions, payment_events, processed_events,
      outbox, payments, customers, simulations, dataset_runs
      RESTART IDENTITY CASCADE`;
    log.info('simulator state cleared — run bun seed or press Play to refill');
  } catch (err) {
    log.error('clear failed', { err });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
