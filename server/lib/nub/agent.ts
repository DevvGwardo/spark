/**
 * Asking the user's nub agent, shared by the server loop tool, the MCP
 * endpoint Hermes uses, and the REST route.
 */

import { NubClient } from './client';
import { loadNubAuth } from './store';

/** Longest message sent to the nub agent in one ask. */
export const MAX_ASK_CHARS = 8_000;
/** Longest reply handed back to a model (keeps its context bounded). */
export const MAX_REPLY_CHARS = 20_000;

export const NUB_ASK_DESCRIPTION =
  "Send one message to the user's nub agent (their always-on cloud agent with their memory, " +
  'skills and connected accounts) and return its reply. Use it for what only that agent knows ' +
  'or can do — the user\'s preferences, earlier conversations, routines, work that should keep ' +
  'running after this session. Never send secrets or whole files.';

export class NubNotLinkedError extends Error {
  constructor(message = 'Nub is not linked. Sign in to Nub in Spark settings first.') {
    super(message);
    this.name = 'NubNotLinkedError';
  }
}

export async function askNubAgent(message: string, client?: NubClient): Promise<string> {
  const auth = await loadNubAuth();
  if (!auth) throw new NubNotLinkedError();
  if (!auth.instance) throw new NubNotLinkedError('No nub agent is linked to this sign-in. Deploy one at maiavm.com.');
  const trimmed = message.trim();
  if (!trimmed) throw new Error('nothing to send');
  const reply = await (client ?? new NubClient(auth.origin)).ask(
    auth.desktopToken,
    auth.instance.id,
    truncate(trimmed, MAX_ASK_CHARS),
  );
  return truncate(reply, MAX_REPLY_CHARS);
}

export async function nubAgentStatus(client?: NubClient): Promise<string> {
  const auth = await loadNubAuth();
  if (!auth) throw new NubNotLinkedError();
  const me = await (client ?? new NubClient(auth.origin)).me(auth.desktopToken);
  return me.instance
    ? `Linked. The nub agent is ${me.instance.status}.`
    : 'Linked, but no nub agent is deployed.';
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}
