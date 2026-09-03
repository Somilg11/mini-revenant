import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { AppError, isConnectionError, publicMessage } from '../lib/errors.ts';
import { log } from '../lib/logger.ts';
import { health } from './routes/health.ts';
import { cases } from './routes/cases.ts';
import { incidents } from './routes/incidents.ts';
import { metrics } from './routes/metrics.ts';
import { model } from './routes/model.ts';
import { sim } from './routes/sim.ts';
import { stream } from './sse.ts';
import { webhooks } from './routes/webhooks.ts';

/** Context variables set by middleware and read by handlers and the boundary. */
export interface AppEnv {
  Variables: {
    requestId: string;
  };
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * The dashboard is the only browser client, and it is same-machine. Echoing
   * back an arbitrary Origin would let any page a developer happens to have
   * open drive this API, including its approve endpoint.
   */
  app.use(
    '*',
    cors({
      origin: config.CORS_ORIGINS,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-Request-Id', 'X-Webhook-Signature'],
      maxAge: 600,
    }),
  );

  /**
   * Request id + access log. The id is echoed so a line in the dashboard, a
   * line in the API log and a row in `agent_decisions` can be tied together
   * without guessing from timestamps.
   */
  app.use('*', async (c, next) => {
    // Client-supplied ids are echoed into every log line for the request. Cap
    // the length and the alphabet so a hostile header cannot bloat or shape
    // the log.
    const supplied = c.req.header('X-Request-Id');
    const requestId =
      supplied && /^[A-Za-z0-9._-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);

    const startedAt = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - startedAt);

    // Health checks would otherwise dominate the log at simulator speeds.
    const path = c.req.path;
    const noisy = path === '/health' || path === '/ready';
    const level = c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info';
    if (!noisy || level !== 'info') {
      log[level]('request', {
        requestId,
        method: c.req.method,
        path,
        status: c.res.status,
        durationMs,
      });
    }
  });

  app.route('/', health);
  app.route('/', webhooks);
  app.route('/', metrics);
  app.route('/', incidents);
  app.route('/', cases);
  app.route('/', model);
  app.route('/', sim);
  app.route('/', stream);

  app.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: `no route for ${c.req.method} ${c.req.path}` } }, 404),
  );

  /**
   * The error boundary. Nothing below this line reaches a client unfiltered:
   * an unexpected error yields a generic message and a request id, because a
   * stack trace or a driver message on a payments API is an information leak.
   * The full error goes to the log, keyed by that same id.
   */
  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';

    if (err instanceof AppError) {
      // Expected, classified failures. Safe to describe.
      const level = err.status >= 500 ? 'error' : 'warn';
      log[level]('request failed', {
        requestId,
        path: c.req.path,
        code: err.code,
        errorClass: err.errorClass,
        err,
      });
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.detail ? { detail: err.detail } : {}),
          },
          requestId,
        },
        err.status,
      );
    }

    if (isConnectionError(err)) {
      log.error('database unreachable during a request', { requestId, path: c.req.path, err });
      return c.json(
        { error: { code: 'DATABASE_UNAVAILABLE', message: 'database unavailable' }, requestId },
        503,
      );
    }

    log.error('unhandled error', { requestId, path: c.req.path, err });
    return c.json(
      { error: { code: 'INTERNAL', message: publicMessage(err) }, requestId },
      500,
    );
  });

  return app;
}
