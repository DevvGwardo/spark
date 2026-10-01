/**
 * The nub agent as a tool in Spark's own agent loop (Hermes gets the same
 * tool through the `nub` MCP server instead).
 */

import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { NUB_ASK_DESCRIPTION, askNubAgent } from './agent';
import { loadNubAuth } from './store';

/** `{ nub_agent_ask }` when Nub is linked to an agent, otherwise `{}`. */
export async function buildNubTools(): Promise<Record<string, Tool>> {
  const auth = await loadNubAuth();
  if (!auth?.instance) return {};
  return {
    nub_agent_ask: tool({
      description: NUB_ASK_DESCRIPTION,
      inputSchema: z.object({
        message: z.string().describe('What to ask or tell the nub agent.'),
      }),
      execute: async ({ message }) => {
        try {
          return await askNubAgent(message);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}
