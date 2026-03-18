export function getChatScopeId(panelId: string, conversationId: string | null | undefined): string {
  return conversationId && conversationId.trim().length > 0
    ? conversationId
    : panelId;
}
