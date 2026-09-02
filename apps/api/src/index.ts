import { config, redacted } from './config.ts';
import { closeDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { startRelay, stopRelay } from './app/relay.ts';
import { createApp } from './http/app.ts';
import { log } from './lib/logger.ts';
import { installSignalHandlers, onShutdown, shutdown } from './lib/shutdown.ts';

installSignalHandlers();
onShutdown('database', closeDb);

log.info('boot', { config: redacted() });

/**
 * Migrate before serving. An API that accepts traffic against a schema it has
 * not finished applying will fail in ways that look like application bugs, so
 * a migration failure stops the boot rather than degrading it — and stops it
 * with a readable message instead of an unhandled rejection.
 */
try {
  const report = await migrate();
  log.info('migrations ready', {
    applied: report.applied,
    alreadyApplied: report.alreadyApplied,
  });
} catch (err) {
  log.error('boot aborted: migrations failed', { err });
  await shutdown('migration-failure', 1);
}

// Started after the migrations so the relay never queries a table that does
// not exist yet. Registered before the server binds, so a shutdown during
// startup still unwinds it.
onShutdown('relay', stopRelay);
startRelay();

const app = createApp();

log.info('api listening', { port: config.PORT });

export default {
  port: config.PORT,
  fetch: app.fetch,
  // Long enough for an SSE client (P6) to sit idle between simulator ticks.
  idleTimeout: 120,
};
