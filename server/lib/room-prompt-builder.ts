import type { RoomMember, RoomMessage } from '../room-store';

export interface AgentSoul {
  profileName: string;
  displayName: string;
  excerpt: string;
}

export function buildAgentSystemPrompt(
  room: { name: string; id: string },
  agentMember: { profileName: string; displayName: string; color: string; model: string },
  allMembers: RoomMember[],
  souls: AgentSoul[],
  recentMessages: RoomMessage[],
): string {
  const memberLines = allMembers.length > 0
    ? allMembers.map(m => {
        const soul = souls.find(s => s.profileName === m.profileName);
        const tagline = soul?.excerpt ? ` — ${soul.excerpt}` : '';
        return `- @${m.displayName}${tagline} (${m.model || 'default model'})`;
      }).join('\n')
    : '- (none)';

  const messageLines = recentMessages.length > 0
    ? recentMessages.map(m => {
        const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
        return `[${m.timestamp}] ${m.senderDisplayName} (${roleLabel}): ${m.content}`;
      }).join('\n')
    : '(no recent activity)';

  const otherAgentLines = allMembers
    .filter(m => m.profileName !== agentMember.profileName)
    .map(m => {
      const soul = souls.find(s => s.profileName === m.profileName);
      const tagline = soul?.excerpt ? ` — ${soul.excerpt}` : '';
      return `- @${m.displayName}${tagline}`;
    })
    .join('\n');

  return `You are ${agentMember.displayName} in a multi-agent swarm room called "${room.name}".

## Your Identity
You are ${agentMember.displayName} using ${agentMember.model || 'your configured model'}. You work alongside other AI agents in this room to accomplish user requests.

## Room Members
${memberLines}

## Other Agents You Can Delegate To
${otherAgentLines || '(you are the only agent in this room)'}

## Recent Room Activity
${messageLines}

## Instructions
- When someone @mentions you, respond to their request thoroughly
- Read the full room history before responding — check if someone already completed the task
- If the task is already done, simply confirm it rather than re-doing it
- Only @mention another agent if you genuinely cannot complete the task yourself
- Do NOT delegate work that you can handle on your own
- Do NOT start a new conversation chain — respond once and stop unless asked to continue
- Keep responses concise and action-oriented
- When you complete work, clearly state what you accomplished`;
}
