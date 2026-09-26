// ─── AI SDK v7 UI message stream writer ──────────────────────────────────────
// The v4 data-stream protocol (`0:"text"`, `2:[...]`, `d:{...}`) was removed in
// `ai` v7. Proxied provider streams must now speak the UI message stream
// protocol: newline-delimited `data: <json>` SSE frames whose payloads are
// UIMessageChunk objects (`text-start` → `text-delta` → `text-end`, `data-*`,
// `finish`). The client's DefaultChatTransport parses these with
// `uiMessageChunkSchema`, and a `text-delta` with no open `text-start` block is
// a hard error — so this writer owns the text/reasoning block state.

export const UI_MESSAGE_STREAM_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
};

/** Terminal sentinel the SDK's SSE parser stops on. */
export const UI_MESSAGE_STREAM_DONE = 'data: [DONE]\n\n';

export type UiFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown';

export function encodeUiMessageChunk(chunk: Record<string, unknown>): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export interface UiMessageStreamWriter {
  /** Opens the message. Emit once per response, before any part. */
  start(): Promise<void>;
  text(delta: string): Promise<void>;
  closeText(): Promise<void>;
  reasoning(delta: string): Promise<void>;
  closeReasoning(): Promise<void>;
  /** Custom event forwarded to the client as a transient `data-*` part. */
  data(event: unknown, name?: string): Promise<void>;
  toolInputStart(toolCallId: string, toolName: string): Promise<void>;
  toolInputDelta(toolCallId: string, inputTextDelta: string): Promise<void>;
  toolInputAvailable(toolCallId: string, toolName: string, input: unknown): Promise<void>;
  error(errorText: string): Promise<void>;
  finish(finishReason?: UiFinishReason): Promise<void>;
  done(): Promise<void>;
}

/**
 * Build a writer over a raw chunk sink (typically `res.write`). Text and
 * reasoning blocks are opened lazily on the first delta and must be closed
 * before switching part kinds, so callers can stream deltas without tracking
 * ids themselves.
 */
export function createUiMessageStreamWriter(
  send: (chunk: string) => Promise<void> | void,
): UiMessageStreamWriter {
  let textId: string | null = null;
  let reasoningId: string | null = null;
  let counter = 0;

  const nextId = (prefix: string) => `${prefix}-${counter++}`;

  const closeTextBlock = async () => {
    if (textId === null) return;
    const id = textId;
    textId = null;
    await send(encodeUiMessageChunk({ type: 'text-end', id }));
  };

  const closeReasoningBlock = async () => {
    if (reasoningId === null) return;
    const id = reasoningId;
    reasoningId = null;
    await send(encodeUiMessageChunk({ type: 'reasoning-end', id }));
  };

  return {
    async start() {
      await send(encodeUiMessageChunk({ type: 'start' }));
    },

    async text(delta) {
      if (delta.length === 0) return;
      await closeReasoningBlock();
      if (textId === null) {
        textId = nextId('text');
        await send(encodeUiMessageChunk({ type: 'text-start', id: textId }));
      }
      await send(encodeUiMessageChunk({ type: 'text-delta', id: textId, delta }));
    },

    async closeText() {
      await closeTextBlock();
    },

    async reasoning(delta) {
      if (delta.length === 0) return;
      await closeTextBlock();
      if (reasoningId === null) {
        reasoningId = nextId('reasoning');
        await send(encodeUiMessageChunk({ type: 'reasoning-start', id: reasoningId }));
      }
      await send(encodeUiMessageChunk({ type: 'reasoning-delta', id: reasoningId, delta }));
    },

    async closeReasoning() {
      await closeReasoningBlock();
    },

    async data(event, name = 'toolEvent') {
      await send(encodeUiMessageChunk({ type: `data-${name}`, data: event, transient: true }));
    },

    async toolInputStart(toolCallId, toolName) {
      await send(encodeUiMessageChunk({ type: 'tool-input-start', toolCallId, toolName }));
    },

    async toolInputDelta(toolCallId, inputTextDelta) {
      await send(encodeUiMessageChunk({ type: 'tool-input-delta', toolCallId, inputTextDelta }));
    },

    async toolInputAvailable(toolCallId, toolName, input) {
      await send(encodeUiMessageChunk({ type: 'tool-input-available', toolCallId, toolName, input }));
    },

    async error(errorText) {
      await send(encodeUiMessageChunk({ type: 'error', errorText }));
    },

    async finish(finishReason = 'stop') {
      await closeTextBlock();
      await closeReasoningBlock();
      await send(encodeUiMessageChunk({ type: 'finish', finishReason }));
    },

    async done() {
      await send(UI_MESSAGE_STREAM_DONE);
    },
  };
}
