import { Hono } from 'hono';
import { z } from 'zod';
import { runner } from '../../sim/runner.ts';
import { SPEED_PRESETS } from '../../sim/clock.ts';
import { ValidationError } from '../../lib/errors.ts';
import type { AppEnv } from '../app.ts';

export const sim = new Hono<AppEnv>();

/**
 * Simulator controls (§8.5).
 *
 * These move money through the pipeline, so they are deliberately explicit
 * verbs rather than one overloaded endpoint — a demo driver should never have
 * to guess whether "toggle" is about to wipe the database.
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
