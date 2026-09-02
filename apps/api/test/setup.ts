import { afterAll } from 'bun:test';
import { closeDb } from '../src/db/client.ts';

/**
 * Preloaded once for the whole run.
 *
 * The pool is a module singleton shared by every test file, so closing it in
 * one file's `afterAll` tears it out from under the files that run after —
 * which surfaces as `CONNECTION_ENDED` in a file that did nothing wrong.
 * Closing happens once, here, at the end of everything.
 */
afterAll(closeDb);
