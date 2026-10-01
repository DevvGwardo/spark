import { describe, expect, it } from "vitest";
import {
  HarnessTurn,
  MAX_CONTINUATIONS,
  closestToolName,
  isFailedOutput,
  lastUserText,
  type HarnessEvent,
  type HarnessStep,
} from "../lib/harness/agent-turn";
import { detectLeakedToolCall, leakedCallNudge } from "../lib/harness/leaked-calls";
import { VERIFY_NUDGE, WATCHDOG_NUDGE, stuckNudge } from "../lib/harness/turn-guard";

const TOOLS = ["read_file", "write_file", "run_command"];

function toolStep(toolName: string, input: unknown, output: unknown): HarnessStep {
  return {
    finishReason: "tool-calls",
    text: "",
    toolCalls: [{ toolName, input }],
    content: [{ type: "tool-result", toolName, input, output }],
  };
}

function stopStep(text = "Done."): HarnessStep {
  return { finishReason: "stop", text, toolCalls: [], content: [{ type: "text" }] };
}

describe("HarnessTurn", () => {
  it("injects a stuck nudge before the next step", () => {
    const events: HarnessEvent[] = [];
    const turn = new HarnessTurn("fix the build", TOOLS, (event) => events.push(event));
    const step = toolStep("read_file", { path: "a.ts" }, "contents");
    const messages = [{ role: "user" as const, content: "fix the build" }];

    expect(turn.prepareStep([step, step], messages)).toBeUndefined();
    const nudge = stuckNudge('read_file({"path":"a.ts"})');
    expect(turn.prepareStep([step, step, step], messages)).toEqual({
      messages: [...messages, { role: "user", content: nudge }],
    });
    expect(events).toEqual([{ kind: "nudge", reason: "stuck", message: nudge }]);
  });

  it("detects repeated identical failures from tool results", () => {
    const turn = new HarnessTurn("fix the build", TOOLS);
    const failing = toolStep("run_command", { command: "npm test" }, "1 failed\n[Exit code: 1]");
    turn.observe([failing, failing]);
    expect(turn.prepareStep([failing, failing], [])?.messages).toEqual([
      { role: "user", content: stuckNudge("npm test") },
    ]);
  });

  it("asks for verification after an edit, then lets the turn finish", () => {
    const turn = new HarnessTurn("fix the bug", TOOLS);
    const steps = [toolStep("write_file", { path: "a.ts" }, "ok"), stopStep()];
    expect(turn.continuation(steps)).toBe(VERIFY_NUDGE);
    const verified = [...steps, toolStep("run_command", { command: "npm test" }, "ok"), stopStep()];
    expect(turn.continuation(verified)).toBeNull();
  });

  it("nudges a change task that ends without edits", () => {
    const turn = new HarnessTurn("add a --json flag", TOOLS);
    expect(turn.continuation([toolStep("read_file", { path: "cli.ts" }, "x"), stopStep()])).toBe(WATCHDOG_NUDGE);
  });

  it("turns a leaked call into a nudge", () => {
    const turn = new HarnessTurn("what's in a.ts?", TOOLS);
    const text = 'Let me look.\n<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>';
    expect(turn.continuation([stopStep(text)])).toBe(leakedCallNudge({ name: "read_file", form: "xml" }));
  });

  it("only continues after a clean stop and at most MAX_CONTINUATIONS times", () => {
    const turn = new HarnessTurn("q", TOOLS);
    const leak = stopStep('<function=read_file>{"path":"a"}</function>');
    expect(turn.continuation([{ ...leak, finishReason: "length" }])).toBeNull();
    for (let i = 0; i < MAX_CONTINUATIONS; i++) expect(turn.continuation([leak])).not.toBeNull();
    expect(turn.continuation([leak])).toBeNull();
  });

  it("repairs arguments and near-miss tool names", () => {
    const events: HarnessEvent[] = [];
    const turn = new HarnessTurn("x", TOOLS, (event) => events.push(event));
    expect(
      turn.repairToolCall({ type: "tool-call", toolCallId: "1", toolName: "ReadFile", input: '{"path":"a.ts","limit":null,}' }),
    ).toEqual({ type: "tool-call", toolCallId: "1", toolName: "read_file", input: '{"path":"a.ts"}' });
    expect(events).toEqual([{ kind: "repair", toolName: "read_file", detail: "renamed from ReadFile" }]);
    expect(turn.repairToolCall({ type: "tool-call", toolCallId: "2", toolName: "nope", input: "{}" })).toBeNull();
    expect(turn.repairToolCall({ type: "tool-call", toolCallId: "3", toolName: "read_file", input: "{bad" })).toBeNull();
  });
});

describe("leaked call detection", () => {
  it("recognizes the common leak forms for offered tools only", () => {
    expect(detectLeakedToolCall('<tool_call>{"name":"run_command","arguments":{"command":"ls"}}</tool_call>', TOOLS)).toEqual({
      name: "run_command",
      form: "json",
    });
    expect(detectLeakedToolCall('```json\n{"name": "write_file", "arguments": {"path": "a"}}\n```', TOOLS)).toEqual({
      name: "write_file",
      form: "json",
    });
    expect(detectLeakedToolCall('<function=run_command>', TOOLS)).toEqual({ name: "run_command", form: "function-tag" });
    expect(detectLeakedToolCall('<invoke name="delete_everything">', TOOLS)).toBeNull();
    expect(detectLeakedToolCall("I used read_file to check it.", TOOLS)).toBeNull();
    expect(
      detectLeakedToolCall('{"name":"read_file","parameters":{"type":"object","properties":{}}}', TOOLS),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("classifies run_command output", () => {
    expect(isFailedOutput("boom\n[Exit code: 2]")).toBe(true);
    expect(isFailedOutput("ok\n[Exit code: 0]")).toBe(false);
    expect(isFailedOutput("Error: Command timed out after 30 seconds.")).toBe(true);
    expect(isFailedOutput("all good")).toBe(false);
  });

  it("matches tool names loosely", () => {
    const names = new Set(TOOLS);
    expect(closestToolName("functions.run_command", names)).toBe("run_command");
    expect(closestToolName("write-file", names)).toBe("write_file");
    expect(closestToolName("grep", names)).toBeNull();
  });

  it("reads the latest user text", () => {
    expect(
      lastUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("second");
  });
});
