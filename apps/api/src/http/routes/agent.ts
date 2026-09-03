import { Hono } from 'hono';
import { agentStats, listAgentDecisions } from '../../db/queries.ts';
import { llmStatus, setLlmOverride } from '../../lib/llm.ts';
import { log } from '../../lib/logger.ts';
import type { AppEnv } from '../app.ts';

export const agent = new Hono<AppEnv>();

/** Which model, if any, is answering — and why not, when not. */
agent.get('/api/v1/llm', (c) => c.json(llmStatus()));

/**
 * The §14 resilience demonstration without a restart: switch the model off
 * mid-demo, watch the badges flip to `template` / `fallback` and the choices
 * stay identical; switch it back on. `on` only lifts the runtime override —
 * it cannot conjure a key the environment does not have.
 */
agent.post('/api/v1/llm/off', (c) => {
  const status = setLlmOverride('off');
  log.warn('LLM switched off at runtime — deterministic path only', { ...status });
  return c.json(status);
});
agent.post('/api/v1/llm/on', (c) => {
  const status = setLlmOverride(null);
  log.info('LLM runtime override lifted', { ...status });
  return c.json(status);
});

/** The append-only audit of every agent call, llm and fallback alike. */
agent.get('/api/v1/agent/decisions', async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const [decisions, stats] = await Promise.all([listAgentDecisions(limit), agentStats()]);
  return c.json({
    decisions: decisions.map((d) => ({ ...d, raw_response: d.raw_response ? d.raw_response.slice(0, 2000) : null })),
    stats,
    llm: llmStatus(),
  });
});
