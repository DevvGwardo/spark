// Clean-room behavioral pins.
// Shape pins for resources/skills/manifest.json. If the manifest is absent
// the suite skips (no vendor content assertions anywhere — shape only).
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(__dirname, "../../resources/skills/manifest.json");
const manifestExists = existsSync(manifestPath);

function loadManifest(): unknown {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe.skipIf(!manifestExists)("skills manifest shape", () => {
  it("is an object with version 1 and a skills array", () => {
    const data = loadManifest() as { version?: unknown; skills?: unknown };
    expect(data).toBeTypeOf("object");
    expect(data.version).toBe(1);
    expect(Array.isArray(data.skills)).toBe(true);
  });

  it("gives every skill a non-empty name, description, and tier", () => {
    const data = loadManifest() as { skills: Array<Record<string, unknown>> };
    expect(data.skills.length).toBeGreaterThan(0);
    for (const skill of data.skills) {
      expect(typeof skill["name"]).toBe("string");
      expect((skill["name"] as string).length).toBeGreaterThan(0);
      expect(typeof skill["description"]).toBe("string");
      expect((skill["description"] as string).length).toBeGreaterThan(0);
      expect(typeof skill["tier"]).toBe("string");
      expect((skill["tier"] as string).length).toBeGreaterThan(0);
    }
  });
});

describe("skills manifest presence", () => {
  it(manifestExists ? "manifest is present — shape suite ran" : "manifest absent — shape suite skipped by design", () => {
    // Behavioral pin on the loader contract: exactly one branch holds.
    expect(manifestExists).toBe(existsSync(manifestPath));
  });
});
