/**
 * Detects tool calls that a model wrote into its text instead of calling the
 * tool (ported from the flash harness, codex-api `sse/leaked_calls.rs`).
 *
 * Cheap models sometimes emit `<invoke name="run_command">…</invoke>`,
 * `<function=read_file>…</function>`, `<tool_call>{…}</tool_call>` or a bare
 * `{"name": …, "arguments": …}` block and then stop, believing they acted.
 * Only names of tools that were actually offered count, so prose that merely
 * mentions a tool is not a leak.
 */

export interface LeakedCall {
  name: string;
  /** Where in the text it was found, for logs. */
  form: "xml" | "function-tag" | "json";
}

const XML_INVOKE = /<\s*(?:invoke|function_call|tool_use)\b[^>]*\bname\s*=\s*["']?([A-Za-z0-9_.:-]+)/gi;
const FUNCTION_TAG = /<\s*function\s*=\s*["']?([A-Za-z0-9_.:-]+)/gi;
const TOOL_CALL_BLOCK = /<\s*tool_call\s*>([\s\S]*?)(?:<\s*\/\s*tool_call\s*>|$)/gi;

export function detectLeakedToolCall(text: string, toolNames: Iterable<string>): LeakedCall | null {
  const names = new Set(toolNames);
  if (names.size === 0 || !text.trim()) return null;

  for (const match of text.matchAll(XML_INVOKE)) {
    if (names.has(match[1])) return { name: match[1], form: "xml" };
  }
  for (const match of text.matchAll(FUNCTION_TAG)) {
    if (names.has(match[1])) return { name: match[1], form: "function-tag" };
  }
  for (const match of text.matchAll(TOOL_CALL_BLOCK)) {
    const name = jsonCallName(match[1], names);
    if (name) return { name, form: "json" };
  }
  for (const candidate of balancedJsonObjects(text)) {
    const name = jsonCallName(candidate, names);
    if (name) return { name, form: "json" };
  }
  return null;
}

export function leakedCallNudge(call: LeakedCall): string {
  return (
    `You wrote a \`${call.name}\` call as text instead of calling the tool, so nothing ran. ` +
    "Call the tool through the tool-calling interface, then continue."
  );
}

/** Name of a JSON object shaped like a call to one of `names`, if it is one. */
function jsonCallName(candidate: string, names: Set<string>): string | null {
  let value: unknown;
  try {
    value = JSON.parse(candidate.trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fn = record.function as Record<string, unknown> | undefined;
  const name = record.name ?? record.tool ?? fn?.name;
  if (typeof name !== "string" || !names.has(name)) return null;
  // A schema declaration (`parameters: {type: "object", properties}`) is not a call.
  const params = record.parameters as Record<string, unknown> | undefined;
  if (params && params.type === "object" && "properties" in params) return null;
  const hasArgs = ["arguments", "args", "input", "parameters"].some((key) => key in record) || fn !== undefined;
  return hasArgs ? name : null;
}

/** Top-level balanced `{…}` regions, string- and escape-aware. */
function* balancedJsonObjects(text: string): Generator<string> {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) yield text.slice(start, i + 1);
    }
  }
}
