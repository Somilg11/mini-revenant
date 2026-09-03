import { generateText, Output } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
import { config } from '../config.ts';

/**
 * Provider-agnostic LLM port (Vercel AI SDK).
 *
 * The spec (§7.8) puts the model at the edge: it receives already-computed
 * context and returns a value from a closed enum plus prose. It never produces
 * a number and never executes. Which vendor answers is therefore an
 * implementation detail, so the choice is configuration rather than code —
 * Anthropic, OpenAI and Google are interchangeable here, and `none` is a
 * first-class option because §14 requires the whole pipeline to work with the
 * LLM switched off.
 *
 * Structured output is enforced by the SDK against a zod schema rather than
 * parsed by hand. Prompt injection is assumed: anything that does not satisfy
 * the schema is rejected and the caller falls back deterministically, so
 * injected text has no path to authority.
 */

/** Sensible current default per provider. Override with LLM_MODEL. */
const DEFAULT_MODEL: Record<Exclude<LlmProvider, 'none'>, string> = {
  gateway: 'anthropic/claude-sonnet-5',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.5',
  google: 'gemini-3.7-flash',
};

export type LlmProvider = 'none' | 'gateway' | 'anthropic' | 'openai' | 'google';

export interface LlmStatus {
  enabled: boolean;
  provider: LlmProvider;
  model: string | null;
  /** Why it is off, when it is off. Surfaced on /ready and in the UI badge. */
  reason?: string;
}

/**
 * A runtime switch for the demo: "set LLM_PROVIDER=none mid-demo" without a
 * restart. `off` forces the deterministic path whatever the environment says;
 * `null` defers to it. Never turns a provider *on* that has no key.
 */
let override: 'off' | null = null;

export function setLlmOverride(value: 'off' | null): LlmStatus {
  override = value;
  return llmStatus();
}

function modelId(): string {
  if (config.LLM_MODEL) return config.LLM_MODEL;
  const p = config.LLM_PROVIDER;
  return p === 'none' ? '' : DEFAULT_MODEL[p];
}

function keyFor(provider: LlmProvider): string {
  switch (provider) {
    case 'gateway':   return config.AI_GATEWAY_API_KEY;
    case 'anthropic': return config.ANTHROPIC_API_KEY;
    case 'openai':    return config.OPENAI_API_KEY;
    case 'google':    return config.GOOGLE_GENERATIVE_AI_API_KEY;
    case 'none':      return '';
  }
}

/**
 * Returns the configured model, or `null` when the deterministic path is the
 * one to take. `null` is a supported state, not an error.
 */
export function resolveModel(): LanguageModel | null {
  const provider = config.LLM_PROVIDER;
  if (override === 'off' || provider === 'none') return null;

  const apiKey = keyFor(provider);
  if (!apiKey) return null;

  const id = modelId();
  switch (provider) {
    // A bare 'provider/model' string routes through the Vercel AI Gateway,
    // which is what makes one key work for every vendor.
    case 'gateway':   return id;
    case 'anthropic': return createAnthropic({ apiKey })(id);
    case 'openai':    return createOpenAI({ apiKey })(id);
    case 'google':    return createGoogleGenerativeAI({ apiKey })(id);
  }
}

export function llmStatus(): LlmStatus {
  const provider = config.LLM_PROVIDER;
  if (override === 'off') {
    return { enabled: false, provider, model: null, reason: 'switched off at runtime' };
  }
  if (provider === 'none') {
    return { enabled: false, provider, model: null, reason: 'LLM_PROVIDER=none' };
  }
  if (!keyFor(provider)) {
    return { enabled: false, provider, model: null, reason: `no API key for ${provider}` };
  }
  return { enabled: true, provider, model: modelId() };
}

export interface StructuredResult<T> {
  value: T;
  latencyMs: number;
  rawText: string;
}

/**
 * One structured call, schema-enforced and time-boxed.
 *
 * Returns `null` on every failure mode the spec enumerates — absent model,
 * slow model, unparseable output, transport error — because all four have the
 * same correct response: take the deterministic choice and record
 * `source: 'fallback'`. Callers must handle `null`; there is no throwing path.
 */
export async function generateStructured<T>(opts: {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<StructuredResult<T> | null> {
  const model = resolveModel();
  if (!model) return null;

  const startedAt = performance.now();
  try {
    const result = await generateText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      output: Output.object({ schema: opts.schema }),
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? config.LLM_TIMEOUT_MS),
    });
    return {
      value: result.output,
      latencyMs: Math.round(performance.now() - startedAt),
      rawText: result.text,
    };
  } catch {
    // Deliberately swallowed. The caller's fallback is the supported path, and
    // the reason is recorded on `agent_decisions` by the caller, not here.
    return null;
  }
}
