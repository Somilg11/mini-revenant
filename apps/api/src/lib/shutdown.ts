import { log } from './logger.ts';

type Hook = () => Promise<void> | void;

const hooks: { name: string; fn: Hook }[] = [];
let shuttingDown = false;

/** Registered cleanup runs in reverse order — last opened, first closed. */
export function onShutdown(name: string, fn: Hook): void {
  hooks.push({ name, fn });
}

/**
 * Graceful shutdown.
 *
 * The relay (P3) holds outbox rows it has claimed with `FOR UPDATE SKIP
 * LOCKED`, and the executor (P13) may be mid-flight against the gateway.
 * Dropping the process without unwinding those leaves claimed-but-unsent rows
 * to wait out a lock timeout on the next boot. A bounded grace period is the
 * difference between a clean restart and a confusing one.
 */
export async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const deadline = setTimeout(() => {
    log.error('shutdown timed out — exiting anyway', { signal });
    process.exit(exitCode || 1);
  }, 10_000);
  deadline.unref();

  for (const { name, fn } of [...hooks].reverse()) {
    try {
      await fn();
      log.debug('shutdown hook complete', { hook: name });
    } catch (err) {
      // One failing hook must not prevent the rest from running.
      log.error('shutdown hook failed', { hook: name, err });
    }
  }

  clearTimeout(deadline);
  log.info('shutdown complete', { signal });
  process.exit(exitCode);
}

export function installSignalHandlers(): void {
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A crash that leaves the process running in an unknown state is worse than
  // a crash that stops. Log the cause, unwind what we can, then exit non-zero.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: reason });
    void shutdown('unhandledRejection', 1);
  });
}
