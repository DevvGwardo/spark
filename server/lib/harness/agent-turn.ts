/**
 * Glue between the AI SDK step loop and the flash-style guardrails.
 *
 * - `prepareStep` feeds finished steps to the TurnGuard and, when it smells a
 *   loop, appends a user-role nudge before the next model call.
 * - `repairToolCall` fixes nearly-valid tool arguments and near-miss tool
 *   names instead of failing the step.
 * - `continuation` runs when a pass ends with the model stopping: it returns a
 *   nudge (verify, zero-edit watchdog, leaked call) that the route sends as one
 *   more pass, or null to finish. Capped per turn.
 */

import type { ModelMessage } from "ai";
import { repairToolArgs } from "./tool-args";
import { detectLeakedToolCall, leakedCallNudge } from "./leaked-calls";
import { TurnGuard, VERIFY_NUDGE, type ToolClassifier, defaultToolClassifier } from "./turn-guard";

export const MAX_CONTINUATIONS = 2;

/** The parts of an AI SDK StepResult the harness reads. */
export interface HarnessStep {
  finishReason: string;
  text: string;
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
  content: ReadonlyArray<{
    type: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  }>;
}

export interface HarnessToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: string;
}

export type HarnessEvent =
  | { kind: "nudge"; reason: "stuck" | "verify" | "watchdog" | "leaked-call"; message: string }
  | { kind: "repair"; toolName: string; detail: string };

export class HarnessTurn {
  private readonly guard: TurnGuard;
  private readonly toolNames: Set<string>;
  private observed = 0;
  private continuations = 0;

  constructor(
    userMessage: string,
    toolNames: Iterable<string>,
    private readonly onEvent: (event: HarnessEvent) => void = () => {},
    classifier: ToolClassifier = defaultToolClassifier,
  ) {
    this.guard = new TurnGuard(userMessage, classifier);
    this.toolNames = new Set(toolNames);
  }

  /** Records tool calls and results from steps not seen yet. */
  observe(steps: ReadonlyArray<HarnessStep>): void {
    for (const step of steps.slice(this.observed)) {
      for (const call of step.toolCalls) this.guard.recordToolCall(call.toolName, call.input);
      for (const part of step.content) {
        if (part.type === "tool-result" && part.toolName) {
          const output = stringifyOutput(part.output);
          this.guard.recordToolResult(part.toolName, part.input, output, isFailedOutput(output));
        } else if (part.type === "tool-error" && part.toolName) {
          this.guard.recordToolResult(part.toolName, part.input, stringifyOutput(part.error), true);
        }
      }
    }
    this.observed = steps.length;
  }

  /** For `streamText({ prepareStep })`: add a stuck nudge when one is pending. */
  prepareStep(steps: ReadonlyArray<HarnessStep>, messages: ModelMessage[]): { messages: ModelMessage[] } | undefined {
    this.observe(steps);
    const nudge = this.guard.takeStuckNudge();
    if (!nudge) return undefined;
    this.onEvent({ kind: "nudge", reason: "stuck", message: nudge });
    return { messages: [...messages, { role: "user", content: nudge }] };
  }

  /**
   * After a pass: a nudge to send as one more pass, or null to finish. Only a
   * clean stop qualifies (not a length cut, error, abort, or pending tools).
   */
  continuation(steps: ReadonlyArray<HarnessStep>): string | null {
    this.observe(steps);
    const last = steps[steps.length - 1];
    if (!last || last.finishReason !== "stop" || last.toolCalls.length > 0) return null;
    if (this.continuations >= MAX_CONTINUATIONS) return null;

    const leaked = detectLeakedToolCall(last.text, this.toolNames);
    let nudge: string | null = null;
    let reason: "verify" | "watchdog" | "leaked-call" = "leaked-call";
    if (leaked) {
      nudge = leakedCallNudge(leaked);
    } else {
      nudge = this.guard.beforeFinish();
      reason = nudge === VERIFY_NUDGE ? "verify" : "watchdog";
    }
    if (!nudge) return null;
    this.continuations += 1;
    this.onEvent({ kind: "nudge", reason, message: nudge });
    return nudge;
  }

  /**
   * For `streamText({ repairToolCall })`: fix a near-miss tool name (case,
   * dashes) or nearly-valid JSON arguments. Returns null to keep the error.
   */
  repairToolCall(call: HarnessToolCall): HarnessToolCall | null {
    let toolName = call.toolName;
    if (!this.toolNames.has(toolName)) {
      const match = closestToolName(toolName, this.toolNames);
      if (!match) return null;
      toolName = match;
    }
    const repaired = repairToolArgs(call.input);
    if (!repaired.ok) return null;
    const input = JSON.stringify(repaired.value);
    if (toolName === call.toolName && input === call.input) return null;
    this.onEvent({
      kind: "repair",
      toolName,
      detail: toolName !== call.toolName ? `renamed from ${call.toolName}` : "repaired arguments",
    });
    return { ...call, toolName, input };
  }
}

/** `ReadFile`, `read-file`, `functions.read_file` → `read_file` when offered. */
export function closestToolName(name: string, toolNames: Set<string>): string | null {
  const key = normalizeName(name);
  for (const candidate of toolNames) {
    if (normalizeName(candidate) === key) return candidate;
  }
  return null;
}

function normalizeName(name: string): string {
  const last = name.split(/[.:/]/).pop() ?? name;
  return last
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

/** Spark's run_command appends `[Exit code: N]`; errors start with `Error:`. */
export function isFailedOutput(output: string): boolean {
  const exit = /\[Exit code: (-?\d+)\]/.exec(output);
  if (exit) return Number(exit[1]) !== 0;
  return /^\s*(Error:|error:|Command failed:|failed to )/.test(output);
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `Error: ${value.message}`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // AI SDK wraps tool outputs as { type: 'text' | 'json', value }.
    if ("value" in record && (record.type === "text" || record.type === "json")) {
      return stringifyOutput(record.value);
    }
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

/** The latest user message as plain text (task for the watchdog). */
export function lastUserText(messages: ReadonlyArray<ModelMessage>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return "";
}
