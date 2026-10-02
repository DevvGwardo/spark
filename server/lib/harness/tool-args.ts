/**
 * Best-effort repair of tool-call argument strings from OpenAI-compatible
 * providers (ported from the flash harness, codex-api `sse/tool_args.rs`).
 *
 * Cheap models emit arguments that are *nearly* valid JSON. The shapes seen in
 * practice:
 *   - optional arguments sent as `null` instead of being omitted,
 *   - arrays/objects double-encoded as JSON strings (`"[\"a\"]"`),
 *   - trailing commas (`{"a":1,}`) and containers left open by a truncated
 *     argument stream.
 *
 * Every repair is validated by re-parsing. When nothing parses, the original
 * string is returned so the tool reports a real JSON error to the model
 * instead of silently running with guessed arguments.
 */

export type RepairedArgs =
  | { ok: true; value: Record<string, unknown>; repaired: boolean }
  | { ok: false; raw: string; error: string };

/** Parses and repairs `raw` into an arguments object. */
export function repairToolArgs(raw: string | null | undefined): RepairedArgs {
  const trimmed = (raw ?? "").trim();
  // A tool without parameters legitimately streams an empty string.
  if (!trimmed) return { ok: true, value: {}, repaired: false };

  const direct = tryParse(trimmed);
  if (direct.parsed) return finish(direct.value, false, trimmed);

  for (const candidate of repairCandidates(trimmed)) {
    const attempt = tryParse(candidate);
    if (attempt.parsed) return finish(attempt.value, true, trimmed);
  }
  return { ok: false, raw: trimmed, error: direct.error };
}

/**
 * Same repair applied to an already-parsed value (providers that hand back
 * objects still send nulls and string-encoded arrays).
 */
export function cleanToolArgsValue(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  return cleanValue(value) as Record<string, unknown>;
}

function finish(value: unknown, repaired: boolean, raw: string): RepairedArgs {
  if (!isPlainObject(value)) {
    return { ok: false, raw, error: "tool arguments must be a JSON object" };
  }
  const cleaned = cleanValue(value) as Record<string, unknown>;
  const changed = repaired || JSON.stringify(cleaned) !== JSON.stringify(value);
  return { ok: true, value: cleaned, repaired: changed };
}

function tryParse(text: string): { parsed: true; value: unknown } | { parsed: false; error: string } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch (err) {
    return { parsed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Candidate rewrites, most conservative first. */
function repairCandidates(input: string): string[] {
  const candidates: string[] = [];
  const noTrailing = stripTrailingCommas(input);
  if (noTrailing !== input) candidates.push(noTrailing);
  const closed = closeUnbalanced(noTrailing);
  if (closed !== null) {
    // Closing an object can expose a comma that was trailing at end of input.
    const reStripped = stripTrailingCommas(closed);
    if (reStripped !== noTrailing) candidates.push(reStripped);
  }
  return candidates;
}

/** Drops a `,` that precedes `}` / `]` or ends the input. String-aware. */
export function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (j >= input.length || input[j] === "}" || input[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Appends the closers needed to balance a truncated value. Returns null when
 * already balanced or when a mismatched closer shows damage too deep to fix.
 */
export function closeUnbalanced(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
    }
  }
  if (stack.length === 0 && !inString) return null;
  let closed = input;
  if (inString) closed += '"';
  while (stack.length) closed += stack.pop();
  return closed;
}

/** Drops null-valued keys and re-expands JSON containers encoded as strings. */
function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null) continue;
      out[key] = cleanValue(entry);
    }
    return out;
  }
  if (typeof value === "string") return expandEncodedJson(value);
  return value;
}

function expandEncodedJson(text: string): unknown {
  const first = text.trimStart()[0];
  if (first !== "[" && first !== "{") return text;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) || isPlainObject(parsed) ? cleanValue(parsed) : text;
  } catch {
    return text;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
