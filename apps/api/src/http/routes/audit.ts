import { Hono } from 'hono';
import { auditTrail } from '../../app/audit.ts';
import type { AppEnv } from '../app.ts';

export const audit = new Hono<AppEnv>();

/** The full chain, event → outcome, in causal order with every input (§10). */
audit.get('/api/v1/audit/:paymentId', async (c) => c.json(await auditTrail(c.req.param('paymentId'))));
