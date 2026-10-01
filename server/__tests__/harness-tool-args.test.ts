import { describe, expect, it } from "vitest";
import {
  cleanToolArgsValue,
  closeUnbalanced,
  repairToolArgs,
  stripTrailingCommas,
} from "../lib/harness/tool-args";

describe("repairToolArgs", () => {
  it("leaves valid arguments alone", () => {
    expect(repairToolArgs('{"path":"a.ts","limit":20}')).toEqual({
      ok: true,
      value: { path: "a.ts", limit: 20 },
      repaired: false,
    });
  });

  it("treats empty arguments as an empty object", () => {
    expect(repairToolArgs("")).toEqual({ ok: true, value: {}, repaired: false });
    expect(repairToolArgs(undefined)).toEqual({ ok: true, value: {}, repaired: false });
  });

  it("drops nulls and expands string-encoded containers", () => {
    expect(repairToolArgs('{"cmd":"ls","timeout":null,"paths":"[\\"a\\",\\"b\\"]"}')).toEqual({
      ok: true,
      value: { cmd: "ls", paths: ["a", "b"] },
      repaired: true,
    });
  });

  it("removes trailing commas and closes a truncated stream", () => {
    expect(repairToolArgs('{"path":"a.ts","lines":[1,2,],}')).toEqual({
      ok: true,
      value: { path: "a.ts", lines: [1, 2] },
      repaired: true,
    });
    expect(repairToolArgs('{"path":"a.ts","content":"hel')).toEqual({
      ok: true,
      value: { path: "a.ts", content: "hel" },
      repaired: true,
    });
  });

  it("returns the original when the damage is too deep", () => {
    const result = repairToolArgs('{"a":[1}');
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ raw: '{"a":[1}' });
  });

  it("rejects non-object arguments", () => {
    expect(repairToolArgs("[1,2]")).toEqual({
      ok: false,
      raw: "[1,2]",
      error: "tool arguments must be a JSON object",
    });
  });

  it("keeps commas and braces inside strings", () => {
    expect(stripTrailingCommas('{"s":"a,}"}')).toBe('{"s":"a,}"}');
    expect(closeUnbalanced('{"s":"{["}')).toBeNull();
  });
});

describe("cleanToolArgsValue", () => {
  it("cleans parsed objects and ignores non-objects", () => {
    expect(cleanToolArgsValue({ a: null, b: '{"c":1}' })).toEqual({ b: { c: 1 } });
    expect(cleanToolArgsValue("x")).toBeNull();
  });
});
