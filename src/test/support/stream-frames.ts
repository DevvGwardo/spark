// Frames for tests that simulate a proxied provider stream. These emit the AI
// SDK v7 UI message stream protocol (newline-delimited `data: <json>` SSE
// frames), matching what server/direct-sse-proxy.ts writes in production.
import { encodeUiMessageChunk } from '../../../server/lib/ui-message-stream';

/** Custom server event (tool activity, usage, approvals, ...). */
export function dataFrame(event: unknown): string {
  return encodeUiMessageChunk({ type: 'data-toolEvent', data: event, transient: true });
}

/** Terminal frame. */
export function finishFrame(_options?: { finishReason?: string; usage?: unknown }): string {
  return encodeUiMessageChunk({ type: 'finish', finishReason: 'stop' });
}

/** Opens a streaming tool call. */
export function toolStartFrame(options: { toolCallId: string; toolName: string }): string {
  return encodeUiMessageChunk({
    type: 'tool-input-start',
    toolCallId: options.toolCallId,
    toolName: options.toolName,
  });
}

/** Text delta; opens the text block first (v7 requires text-start). */
export function textFrame(text: string, id = 'text-0'): string {
  return (
    encodeUiMessageChunk({ type: 'text-start', id }) +
    encodeUiMessageChunk({ type: 'text-delta', id, delta: text })
  );
}
