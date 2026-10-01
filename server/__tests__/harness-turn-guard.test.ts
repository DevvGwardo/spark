import { describe, expect, it } from "vitest";
import {
  TurnGuard,
  VERIFY_NUDGE,
  WATCHDOG_NUDGE,
  callKey,
  defaultToolClassifier,
  isPureQuestion,
  stuckNudge,
  taskAsksForChanges,
} from "../lib/harness/turn-guard";

describe("TurnGuard stuck detection", () => {
  it("fires on the third identical call regardless of key order or whitespace", () => {
    const guard = new TurnGuard("fix the build");
    guard.recordToolCall("read_file", { path: "a.ts", limit: 10 });
    guard.recordToolCall("read_file", '{"limit":10,"path":" a.ts "}');
    expect(guard.takeStuckNudge()).toBeNull();
    guard.recordToolCall("read_file", { limit: 10, path: "a.ts" });
    expect(guard.takeStuckNudge()).toBe(stuckNudge('read_file({"limit":10,"path":"a.ts"})'));
    expect(guard.takeStuckNudge()).toBeNull();
  });

  it("fires when the same command fails twice with the same output", () => {
    const guard = new TurnGuard("fix the build");
    const args = { command: "npm test" };
    guard.recordToolCall("bash", args);
    guard.recordToolResult("bash", args, "1 failed\n", true);
    guard.recordToolCall("bash", args);
    guard.recordToolResult("bash", args, "1 failed", true);
    expect(guard.takeStuckNudge()).toBe(stuckNudge("npm test"));
  });

  it("does not fire when failures change or the command succeeds", () => {
    const guard = new TurnGuard("fix the build");
    const args = { command: "npm test" };
    guard.recordToolResult("bash", args, "3 failed", true);
    guard.recordToolResult("bash", args, "2 failed", true);
    guard.recordToolResult("bash", args, "ok", false);
    guard.recordToolResult("bash", args, "2 failed", true);
    expect(guard.takeStuckNudge()).toBeNull();
  });

  it("lets a passing shell command be re-run without counting as a loop", () => {
    const guard = new TurnGuard("fix the build");
    const args = { command: "npm test" };
    for (let i = 0; i < 4; i++) {
      guard.recordToolCall("bash", args);
      guard.recordToolResult("bash", args, "ok", false);
    }
    expect(guard.takeStuckNudge()).toBeNull();
  });
});

describe("TurnGuard before finishing", () => {
  it("asks once for verification after an unverified edit", () => {
    const guard = new TurnGuard("fix the bug in a.ts");
    guard.recordToolCall("edit_file", { path: "a.ts" });
    expect(guard.beforeFinish()).toBe(VERIFY_NUDGE);
    expect(guard.beforeFinish()).toBeNull();
  });

  it("is satisfied by a command after the last edit", () => {
    const guard = new TurnGuard("fix the bug in a.ts");
    guard.recordToolCall("edit_file", { path: "a.ts" });
    guard.recordToolCall("run_command", { command: "npm test" });
    expect(guard.beforeFinish()).toBeNull();
  });

  it("nudges once when a change task ends with tools but no edits", () => {
    const guard = new TurnGuard("Add a --json flag to the CLI");
    guard.recordToolCall("read_file", { path: "cli.ts" });
    expect(guard.beforeFinish()).toBe(WATCHDOG_NUDGE);
    expect(guard.beforeFinish()).toBeNull();
  });

  it("leaves questions and tool-free answers alone", () => {
    const question = new TurnGuard("how does the router work?");
    question.recordToolCall("read_file", { path: "router.ts" });
    expect(question.beforeFinish()).toBeNull();
    expect(new TurnGuard("fix the build").beforeFinish()).toBeNull();
  });
});

describe("helpers", () => {
  it("classifies edit and shell tools, including namespaced names", () => {
    expect(defaultToolClassifier.isEdit("mcp__fs__write_file")).toBe(true);
    expect(defaultToolClassifier.isEdit("write_stdin")).toBe(false);
    expect(defaultToolClassifier.isShell("terminal")).toBe(true);
    expect(defaultToolClassifier.isShell("read_file")).toBe(false);
  });

  it("detects questions and change requests", () => {
    expect(isPureQuestion("what does this do?")).toBe(true);
    expect(taskAsksForChanges("what does this do?")).toBe(false);
    expect(taskAsksForChanges("please refactor the parser")).toBe(true);
    expect(taskAsksForChanges("summarize the README")).toBe(false);
  });

  it("builds canonical call keys", () => {
    expect(callKey("t", { b: [" x "], a: 1 })).toBe('t({"a":1,"b":["x"]})');
  });
});
