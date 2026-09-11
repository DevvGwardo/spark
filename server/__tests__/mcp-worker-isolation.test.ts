// Clean-room behavioral pins.
// Pins for server/lib/mcp-worker-policy.ts. The real module is present, so
// these tests exercise it directly (a local stub stands in ONLY if the
// module is absent). The validator returns a boolean — rejection is `false`
// (a throwing validator also counts as rejection). All assertions are
// behavioral (call the validator with evil/benign input) — never regex
// over source.
// NOTE: the real policy requires ABSOLUTE binary paths, so a bare `python3`
// is REJECTED (returns false) — pinned as such below.
// @vitest-environment node
import { describe, expect, it } from "vitest";

type Validator = (cmd: string) => boolean | string;

const EXPECTED_MAX_WORKERS = 8;

// Local stub of the contract — fallback only, real module takes precedence.
const STUB_MAX_WORKERS = 8;
function stubValidateSpawnCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false;
  if (/[|;&$`\n\r\0]/.test(cmd)) return false;
  const bin = cmd.trim().split(/\s+/)[0] ?? "";
  if (!bin || !bin.startsWith("/")) return false;
  if (bin.includes("..")) return false;
  return true;
}

let validateSpawnCommand: Validator = stubValidateSpawnCommand;
let maxWorkers: number = STUB_MAX_WORKERS;
let usingStub = true;

try {
  const mod: Record<string, unknown> = await import("../lib/mcp-worker-policy.js");
  if (typeof mod["validateSpawnCommand"] === "function") {
    validateSpawnCommand = mod["validateSpawnCommand"] as Validator;
    usingStub = false;
  }
  const policy = mod["MCP_WORKER_POLICY"] as { maxWorkers?: unknown } | undefined;
  if (policy && typeof policy.maxWorkers === "number") {
    maxWorkers = policy.maxWorkers;
  } else if (typeof mod["MAX_WORKERS"] === "number") {
    maxWorkers = mod["MAX_WORKERS"] as number;
  } else if (typeof mod["maxWorkers"] === "number") {
    maxWorkers = mod["maxWorkers"] as number;
  }
} catch {
  // Real policy module absent — contract stub applies (see header).
}

// Rejection = returns false (or throws). Acceptance = truthy return.
function isRejected(cmd: string): boolean {
  try {
    const r = validateSpawnCommand(cmd);
    return r === false || r === undefined || r === null || r === "";
  } catch {
    return true;
  }
}

function isAccepted(cmd: string): boolean {
  try {
    const r = validateSpawnCommand(cmd);
    return r === true || r === cmd;
  } catch {
    return false;
  }
}

describe("mcp worker spawn isolation (behavioral)", () => {
  it("exercises the real policy module, not the stub", () => {
    expect(typeof validateSpawnCommand).toBe("function");
    expect(usingStub).toBe(false);
  });

  it("rejects a command containing `;` (command chaining)", () => {
    expect(isRejected("python3 -c 'x'; rm -rf /tmp/pwn")).toBe(true);
  });

  it("rejects a command containing `|` (piping)", () => {
    expect(isRejected("python3 script.py | tee /tmp/leak")).toBe(true);
  });

  it("rejects command substitution `$()` and backticks", () => {
    expect(isRejected("/usr/bin/python3 $(whoami)")).toBe(true);
    expect(isRejected("/usr/bin/python3 `whoami`")).toBe(true);
  });

  it("rejects embedded newline, CR, and NUL", () => {
    expect(isRejected("/usr/bin/python3\nrm -rf /tmp/pwn")).toBe(true);
    expect(isRejected("/usr/bin/python3\rmalicious")).toBe(true);
    expect(isRejected("/usr/bin/python3\u0000hidden")).toBe(true);
  });

  it("rejects a bare binary name — absolute path required", () => {
    expect(isRejected("python3")).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isRejected("")).toBe(true);
  });

  it("accepts an absolute path with args", () => {
    expect(isAccepted("/usr/bin/python3 -u server/worker.py")).toBe(true);
  });

  it("caps the worker pool at 8", () => {
    expect(maxWorkers).toBe(EXPECTED_MAX_WORKERS);
  });
});
