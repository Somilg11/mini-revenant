import { Hono } from 'hono';
import { z } from 'zod';
import { runner } from '../../sim/runner.ts';
import { lastWhatIf, runWhatIf } from '../../sim/whatif.ts';
import { gateway } from '../../sim/gateway.ts';
import { SPEED_PRESETS } from '../../sim/clock.ts';
import { NotFoundError, ValidationError } from '../../lib/errors.ts';
import type { AppEnv } from '../app.ts';

export const sim = new Hono<AppEnv>();

/**
 * Simulator controls (§8.5).
 *
 * These move money through the pipeline, so they are deliberately explicit
 * verbs rather than one overloaded endpoint — a demo driver should never have
 * to guess whether "toggle" is about to wipe the database.
 */

/**
 * Never generates anything: the dataset is built on Play or reset. Reading
 * the state is what a dashboard does on every load, and generating 75,000
 * payments behind that read pins the event loop for the better part of a
 * minute. Pages that want the answer key without a loaded dataset read it
 * from `/api/v1/evaluation`, which comes from the database.
 */
sim.get('/api/v1/sim/state', (c) => c.json(runner.state()));

sim.post('/api/v1/sim/start', async (c) => c.json(await runner.start()));
sim.post('/api/v1/sim/pause', async (c) => c.json(await runner.pause()));

/** Destructive: empties everything derived from events and reloads ground truth. */
sim.post('/api/v1/sim/reset', async (c) => c.json(await runner.reset()));

const SpeedBody = z.object({ speed: z.coerce.number().positive().max(3600) });

sim.post('/api/v1/sim/speed', async (c) => {
  const raw = c.req.query('speed')
    ? { speed: c.req.query('speed') }
    : ((await c.req.json().catch(() => ({}))) as unknown);
  const parsed = SpeedBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('speed must be a positive number of simulated minutes per real second', {
      presets: [...SPEED_PRESETS],
    });
  }
  return c.json(await runner.setSpeed(parsed.data.speed));
});

sim.post('/api/v1/sim/jump-to-incident', async (c) => {
  const id = c.req.query('id') ?? ((await c.req.json().catch(() => ({}))) as { id?: string }).id;
  if (!id) throw new ValidationError('id is required', { hint: 'a ground-truth incident id or kind' });
  try {
    return c.json(await runner.jumpToIncident(id));
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : 'unknown incident', { id });
  }
});

/**
 * Inject gateway faults from the simulator panel (§13 step 9): the next
 * `count` gateway calls answer with `kind` — a 429/503, a timeout with an
 * unknown outcome, or a hard rejection — instead of the seeded draw.
 */
const FaultBody = z.object({
  kind: z.enum(['retryable', 'timeout', 'terminal']),
  count: z.coerce.number().int().min(1).max(50).default(3),
});
sim.post('/api/v1/sim/gateway-fault', async (c) => {
  const raw = c.req.query('kind')
    ? { kind: c.req.query('kind'), count: c.req.query('count') ?? 3 }
    : ((await c.req.json().catch(() => ({}))) as unknown);
  const parsed = FaultBody.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('kind must be retryable, timeout or terminal; count 1–50', { issues: parsed.error.issues.map((i) => i.message) });
  }
  return c.json({ gateway: gateway.injectFaults(parsed.data.kind, parsed.data.count) });
});

/** BASELINE vs AGENT on the held-out split (§8.7). Stored; the last run is what the page shows. */
sim.post('/api/v1/simulation/whatif', async (c) => c.json(await runWhatIf()));

sim.get('/api/v1/simulation/whatif', async (c) => {
  const run = await lastWhatIf();
  if (!run) throw new NotFoundError('what-if run', 'latest');
  return c.json(run);
});
