export interface NormalizedChatInput {
  messages: unknown[];
}

const APP_INSTRUCTION_PREFIX = [
  'Application instructions:',
  'The following guidance is supplied by CloudChat and must be followed while responding.',
].join('\n');

function buildInstructionMessage(content: string) {
  return {
    role: 'user',
    content: `${APP_INSTRUCTION_PREFIX}\n\n${content}`,
  };
}

export function normalizeChatMessages(
  inputMessages: unknown,
  baseSystemPrompt?: string,
): NormalizedChatInput {
  const systemParts: string[] = [];

  if (typeof baseSystemPrompt === 'string' && baseSystemPrompt.trim()) {
    systemParts.push(baseSystemPrompt.trim());
  }

  const messages = Array.isArray(inputMessages)
    ? inputMessages.flatMap((message) => {
        if (!message || typeof message !== 'object') {
          return [];
        }

        const role = (message as { role?: unknown }).role;
        if (role === 'system') {
          const content = (message as { content?: unknown }).content;
          if (typeof content === 'string' && content.trim()) {
            systemParts.push(content.trim());
          }
          return [];
        }

        return [message];
      })
    : [];

  return {
    messages: systemParts.length > 0
      ? [buildInstructionMessage(systemParts.join('\n\n')), ...messages]
      : messages,
  };
}
