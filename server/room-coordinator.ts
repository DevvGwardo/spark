import { logger } from './lib/logger';
import { createRoomStore, type RoomMessage } from './room-store';
import { buildAgentSystemPrompt } from './lib/room-prompt-builder';
import { OPENAI_COMPATIBLE } from './provider-config';
import type { RoomMember } from './room-store';
import { resolveHermesHome } from './lib/hermes-profiles';
import fs from 'node:fs';
import path from 'node:path';

const HERMES_BRIDGE_URL = `${OPENAI_COMPATIBLE.hermes}/chat/completions`;
const HERMES_BRIDGE_BASE = OPENAI_COMPATIBLE.hermes.replace(/\/v1\/?$/, '');
const AGENT_TIMEOUT_MS = 120_000;
const MAX_ROOM_HISTORY = 20;
const MAX_AGENT_CHAIN_DEPTH = 1;
const MAX_AGENT_CHAIN_DEPTH_TEAM = 3;
const BASE_TOOLSETS = 'web,browser,terminal,files,code_execution';
const TEAM_TOOLSETS = `${BASE_TOOLSETS},team`;

/**
 * Resolve an API key for the Hermes bridge.
 * Checks env vars the bridge uses, falling back to a bearer token.
 */
function resolveBridgeApiKey(): string {
  return (
    process.env.HERMES_OPENROUTER_KEY
    || process.env.OPENROUTER_KEY
    || process.env.HERMES_BRIDGE_TOKEN
    || ''
  );
}

/**
 * Resolve the model for a room member.
 * Priority: member's stored model → profile's config.yaml → bridge default (omit).
 *
 * Profile config.yaml uses multi-line YAML under `model:` with a `default:` sub-key:
 *   model:
 *     default: deepseek/deepseek-v4-flash
 *     provider: nous
 */
function resolveMemberModel(member: RoomMember): string | undefined {
  if (member.model) return member.model;
  try {
    const profilePath = resolveHermesHome(member.profileName);
    const configPath = path.join(profilePath, 'config.yaml');
    if (!fs.existsSync(configPath)) return undefined;

    const raw = fs.readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n');

    // Scan for `model:` key at top level, then look for `default:` in following indented lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      if (indent !== 0) continue; // only top-level keys
      if (!trimmed.startsWith('model:')) continue;
      if (trimmed === 'model:' || trimmed === 'model:') {
        // Multi-line block: look at subsequent indented lines for `default:`
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          const nextTrimmed = next.trimStart();
          const nextIndent = next.length - nextTrimmed.length;
          if (nextIndent === 0) break; // hit next top-level key
          const defaultMatch = nextTrimmed.match(/^default:\s*(.*)$/);
          if (defaultMatch) {
            const val = defaultMatch[1].trim().replace(/^["']|["']$/g, '');
            if (val) return val;
          }
        }
      } else {
        // Inline format: `model: some-value`
        const val = trimmed.slice('model:'.length).trim().replace(/^["']|["']$/g, '');
        if (val && !val.startsWith('#')) return val;
      }
    }
  } catch {
    // Fall through to omitting the model
  }
  return undefined;
}

interface AgentSoul {
  profileName: string;
  displayName: string;
  excerpt: string;
}

const SOUL_CACHE_TTL_MS = 5 * 60 * 1000;
const soulCache = new Map<string, { excerpt: string; expiresAt: number }>();

/**
 * Fetch a profile's SOUL.md excerpt from the Hermes bridge.
 * Returns the preview text or a fallback description.
 */
async function fetchAgentSoul(profileName: string, displayName: string): Promise<AgentSoul> {
  const cached = soulCache.get(profileName);
  if (cached && cached.expiresAt > Date.now()) {
    return { profileName, displayName, excerpt: cached.excerpt };
  }

  const apiKey = resolveBridgeApiKey();
  const headers: Record<string, string> = {
    'X-Hermes-Profile': profileName,
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${HERMES_BRIDGE_BASE}/workspace/files/soul`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      soulCache.set(profileName, { excerpt: '', expiresAt: Date.now() + SOUL_CACHE_TTL_MS });
      return { profileName, displayName, excerpt: '' };
    }
    const data = await res.json() as { file?: { preview?: string; content?: string } };
    const content = data.file?.content || data.file?.preview || '';
    // First line or first 200 chars of soul
    const excerpt = content.split('\n')[0]?.replace(/^#+\s*/, '').trim().slice(0, 200) || '';
    soulCache.set(profileName, { excerpt, expiresAt: Date.now() + SOUL_CACHE_TTL_MS });
    return { profileName, displayName, excerpt };
  } catch {
    soulCache.set(profileName, { excerpt: '', expiresAt: Date.now() + SOUL_CACHE_TTL_MS });
    return { profileName, displayName, excerpt: '' };
  }
}

/**
 * Parse @mentions from a message string.
 * Returns an array of display names that were @mentioned.
 */
export function parseMentions(content: string): string[] {
  const matches = content.match(/@(\w[\w_-]*)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/**
 * Resolve a display name mention to a room member.
 */
function resolveMentionToMember(
  mention: string,
  members: RoomMember[],
): RoomMember | undefined {
  return members.find(
    (m) =>
      m.displayName.toLowerCase() === mention.toLowerCase() ||
      m.profileName.toLowerCase() === mention.toLowerCase(),
  );
}

/**
 * Trigger a Hermes agent for a given room member.
 * Calls the Hermes bridge with the agent's profile and an awareness system prompt,
 * then streams the response back as room messages.
 *
 * If the agent's response @mentions other room members, they are triggered
 * recursively (up to MAX_AGENT_CHAIN_DEPTH) for agent-to-agent collaboration.
 */
async function triggerAgent(
  roomId: string,
  member: RoomMember,
  allMembers: RoomMember[],
  recentMessages: RoomMessage[],
  store: ReturnType<typeof createRoomStore>,
  userMessage: string,
  depth = 0,
  maxDepth = MAX_AGENT_CHAIN_DEPTH,
  teamId?: string,
): Promise<void> {
  const room = store.getRoom(roomId);
  if (!room) return;

  // Skip profiles without a config.yaml — they have no provider or model configured
  const configPath = path.join(resolveHermesHome(member.profileName), 'config.yaml');
  if (!fs.existsSync(configPath)) {
    store.postMessage({
      roomId,
      senderProfile: member.profileName,
      senderDisplayName: member.displayName,
      role: 'system',
      content: `${member.displayName} has no config.yaml — configure it in the Profiles tab first.`,
      mentions: [],
    });
    return;
  }

  // Fetch each agent's SOUL.md so they know each other's identity and expertise
  const souls = await Promise.all(
    allMembers.map((m) => fetchAgentSoul(m.profileName, m.displayName)),
  );

  // Resolve the actual model this agent will use
  const agentModel = resolveMemberModel(member) || member.model || '';

  const systemPrompt = buildAgentSystemPrompt(
    { name: room.name, id: room.id },
    {
      profileName: member.profileName,
      displayName: member.displayName,
      color: member.color,
      model: agentModel,
    },
    allMembers,
    souls,
    recentMessages.slice(-MAX_ROOM_HISTORY),
  );

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userMessage },
  ];

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), AGENT_TIMEOUT_MS);

  const apiKey = resolveBridgeApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hermes-Profile': member.profileName,
    'X-Hermes-Execution-Mode': 'agent-loop',
    'X-Hermes-Toolsets': teamId ? TEAM_TOOLSETS : BASE_TOOLSETS,
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    max_tokens: 16384,
  };
  // Do NOT send a model — the bridge resolves it from the profile's
  // own config.yaml via the X-Hermes-Profile header. Sending a model
  // here overrides the bridge's per-profile routing and causes 401s.

  try {
    const response = await fetch(HERMES_BRIDGE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const errorMsg = `${member.displayName} returned error ${response.status}: ${errorText.slice(0, 200)}`;
      store.postMessage({
        roomId,
        senderProfile: member.profileName,
        senderDisplayName: member.displayName,
        role: 'system',
        content: errorMsg,
        mentions: [],
      });
      return;
    }

    if (!response.body) {
      store.postMessage({
        roomId,
        senderProfile: member.profileName,
        senderDisplayName: member.displayName,
        role: 'system',
        content: `${member.displayName} returned an empty response.`,
        mentions: [],
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6).trim();
        if (payload === '[DONE]') break;

        try {
          const parsed = JSON.parse(payload);
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            fullContent += choice.delta.content;
          }
        } catch {
          // Skip malformed SSE frames
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) {
            fullContent += choice.delta.content;
          }
        } catch {
          // skip
        }
      }
    }

    if (fullContent.trim()) {
      // Check if the agent @mentioned any other members
      const agentMentions = parseMentions(fullContent);
      store.postMessage({
        roomId,
        senderProfile: member.profileName,
        senderDisplayName: member.displayName,
        role: 'assistant',
        content: fullContent.trim(),
        mentions: agentMentions,
      });

      // Agent-to-agent: if this response @mentions other members, trigger them
      // recursively so agents can delegate work to each other.
      if (agentMentions.length > 0 && depth < maxDepth) {
        const newlyMentioned: RoomMember[] = [];
        const seen = new Set<string>([member.profileName]);
        for (const mention of agentMentions) {
          const target = resolveMentionToMember(mention, allMembers);
          if (target && !seen.has(target.profileName)) {
            seen.add(target.profileName);
            newlyMentioned.push(target);
          }
        }
        if (newlyMentioned.length > 0) {
          const updatedMessages = store.getMessages(roomId, MAX_ROOM_HISTORY);
          const delegatedMsg = `${member.displayName} requested help from ${newlyMentioned.map(m => `@${m.displayName}`).join(', ')}`;
          // Stagger recursive triggers to avoid rate limits
          (async () => {
            for (let i = 0; i < newlyMentioned.length; i++) {
              if (i > 0) await new Promise((r) => setTimeout(r, 5000));
              triggerAgent(roomId, newlyMentioned[i], allMembers, updatedMessages, store, delegatedMsg, depth + 1, maxDepth, teamId).catch((err) => {
                logger.error(`[room-coordinator] Chain agent ${newlyMentioned[i].displayName} error:`, err);
              });
            }
          })().catch((err) => {
            logger.error(`[room-coordinator] Chain trigger error:`, err);
          });
        }
      }
    }
  } catch (error: unknown) {
    if (abortController.signal.aborted) {
      store.postMessage({
        roomId,
        senderProfile: member.profileName,
        senderDisplayName: member.displayName,
        role: 'system',
        content: `${member.displayName} did not respond within ${AGENT_TIMEOUT_MS / 1000}s.`,
        mentions: [],
      });
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      store.postMessage({
        roomId,
        senderProfile: member.profileName,
        senderDisplayName: member.displayName,
        role: 'system',
        content: `${member.displayName} error: ${msg}`,
        mentions: [],
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Post a user message to a room and trigger @mentioned agents.
 *
 * Steps:
 * 1. Persist the user message
 * 2. Parse @mentions from the content
 * 3. Resolve mentions to room members
 * 4. Trigger each mentioned agent concurrently
 * 5. Return the created message
 */
export async function postToRoom(
  roomId: string,
  content: string,
  sender: string,
  senderDisplayName?: string,
  teamId?: string,
): Promise<{ message: RoomMessage; triggeredAgents: Array<{ profileName: string; displayName: string }> }> {
  const store = createRoomStore();

  const room = store.getRoom(roomId);
  if (!room) {
    throw new Error('Room not found');
  }

  const mentions = parseMentions(content);

  // Persist the user message
  const message = store.postMessage({
    roomId,
    senderProfile: sender,
    senderDisplayName: senderDisplayName || sender,
    role: 'user',
    content,
    mentions,
  });

  // Resolve mentioned members
  const allMembers = store.getMembers(roomId);
  const recentMessages = store.getMessages(roomId, MAX_ROOM_HISTORY);

  let targetMembers: RoomMember[] = [];

  if (mentions.length > 0) {
    // Only trigger explicitly @mentioned members
    for (const mention of mentions) {
      const member = resolveMentionToMember(mention, allMembers);
      if (member) {
        targetMembers.push(member);
      }
    }
  } else {
    // No @mention — trigger all members
    targetMembers = allMembers;
  }

  if (targetMembers.length > 0) {
    // Only show typing indicator for profiles that have a config.yaml
    const triggeredAgents = targetMembers
      .filter((m) => fs.existsSync(path.join(resolveHermesHome(m.profileName), 'config.yaml')))
      .map((m) => ({
        profileName: m.profileName,
        displayName: m.displayName,
      }));

    // Team rooms get a deeper agent chain depth for collaboration
    const maxDepth = teamId ? MAX_AGENT_CHAIN_DEPTH_TEAM : MAX_AGENT_CHAIN_DEPTH;

    // Trigger agents sequentially with a 5s stagger between each to
    // avoid hammering the provider with concurrent requests (rate limits).
    (async () => {
      for (let i = 0; i < targetMembers.length; i++) {
        const member = targetMembers[i];
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 5000));
        }
        triggerAgent(roomId, member, allMembers, recentMessages, store, content, 0, maxDepth, teamId).catch((err) => {
          logger.error(`[room-coordinator] Agent ${member.displayName} trigger error:`, err);
        });
      }
    })().catch((err) => {
      logger.error(`[room-coordinator] Sequential trigger error:`, err);
    });

    return { message, triggeredAgents };
  }

  return { message, triggeredAgents: [] };
}
