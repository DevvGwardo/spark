/**
 * Minimal Server-Sent Events parser.  Consumes a `ReadableStream<Uint8Array>`
 * (what `fetch().body` returns) and yields each `data:` payload as a string.
 * Heartbeat comments (`: heartbeat`) and blank lines are skipped.  The sentinel
 * `[DONE]` is passed through so the caller can detect end-of-stream.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          const data = extractData(buffer);
          if (data !== null) yield data;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = extractData(raw);
        if (data !== null) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function extractData(block: string): string | null {
  const lines = block.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}
