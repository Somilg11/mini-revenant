import { z } from 'zod';

/**
 * Config is parsed once, at boot, and fails loudly. Secrets come only from the
 * environment (§15.2) and are never logged in full — `redacted()` is the only
 * shape of the config that may reach a log line.
 */
const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(8090),
  // Loopback by default. `POST /api/v1/sim/reset` truncates the database and
  // nothing on this API is authenticated (§3), so listening on every interface
  // would let anyone on the network wipe it. Set 0.0.0.0 deliberately.
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.string().url(),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Comma-separated. The dashboard is the only browser client; echoing back an
  // arbitrary Origin would let any page a developer has open drive this API.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  SIM_SEED: z.coerce.number().int().default(42),
  SIM_PAYMENTS: z.coerce.number().int().positive().default(5000),
  SIM_MERCHANTS: z.coerce.number().int().positive().default(5),
  SIM_DAYS: z.coerce.number().int().positive().default(7),
  SIM_ENDS_AT: z.string().datetime().default('2026-08-01T00:00:00Z'),
  SIM_SPEED: z.coerce.number().positive().default(60),

  // A signing key short enough to guess is the same as no signature at all.
  // 16 characters is the floor; the shipped development value is longer.
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters'),

  // ── LLM ──────────────────────────────────────────────────────────────────
  // Provider-agnostic via the Vercel AI SDK. Optional by design: an absent key
  // must leave every code path working, with badges flipping to `template`
  // (§14). `none` is the default so the deterministic path is what runs unless
  // somebody opts in.
  LLM_PROVIDER: z.enum(['none', 'gateway', 'anthropic', 'openai', 'google']).default('none'),
  // Empty means "use the per-provider default in lib/llm.ts".
  LLM_MODEL: z.string().default(''),
  // §7.8: slower than this and the deterministic fallback takes over.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  AI_GATEWAY_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().default(''),
});

export type Config = z.infer<typeof Schema>;

function load(): Config {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env.`);
  }
  return parsed.data;
}

export const config = load();

/**
 * The LLM is off unless a provider is chosen AND its key is present. This is
 * the toggle the demo flips live (§13 step 10). `lib/llm.ts` owns the detail;
 * this is the cheap boolean for logging.
 */
export const llmEnabled =
  config.LLM_PROVIDER !== 'none' &&
  [
    config.AI_GATEWAY_API_KEY,
    config.ANTHROPIC_API_KEY,
    config.OPENAI_API_KEY,
    config.GOOGLE_GENERATIVE_AI_API_KEY,
  ].some((k) => k.length > 0);

/** The only form of the config allowed near a log line. */
export function redacted(): Record<string, unknown> {
  const url = new URL(config.DATABASE_URL);
  const dbSafe = `${url.protocol}//${url.username}:***@${url.host}${url.pathname}`;
  return {
    ...config,
    DATABASE_URL: dbSafe,
    WEBHOOK_SECRET: mask(config.WEBHOOK_SECRET),
    AI_GATEWAY_API_KEY: maskOrUnset(config.AI_GATEWAY_API_KEY),
    ANTHROPIC_API_KEY: maskOrUnset(config.ANTHROPIC_API_KEY),
    OPENAI_API_KEY: maskOrUnset(config.OPENAI_API_KEY),
    GOOGLE_GENERATIVE_AI_API_KEY: maskOrUnset(config.GOOGLE_GENERATIVE_AI_API_KEY),
    llmEnabled,
  };
}

function mask(secret: string): string {
  return secret.length <= 4 ? '***' : `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

function maskOrUnset(secret: string): string {
  return secret ? mask(secret) : '(unset)';
}
