export interface QueuedMessage {
  id: string;
  content: string;
  createdAt: string;
}

export function createQueuedMessage(content: string): QueuedMessage {
  return {
    id: crypto.randomUUID(),
    content,
    createdAt: new Date().toISOString(),
  };
}

export function moveQueuedMessageToFront(
  queue: QueuedMessage[],
  messageId: string,
): QueuedMessage[] {
  const match = queue.find((item) => item.id === messageId);
  if (!match) return queue;
  return [match, ...queue.filter((item) => item.id !== messageId)];
}

export function removeQueuedMessage(
  queue: QueuedMessage[],
  messageId: string,
): QueuedMessage[] {
  return queue.filter((item) => item.id !== messageId);
}
