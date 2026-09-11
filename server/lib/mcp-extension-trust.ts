// Signature/trust gate for .mcpb extension installs. Self-authored; no vendor code.
// Pure (no fs): decideTrust + assertSafeZipPath enforce policy on data only.
// The installer owns all I/O and maps the SDK bundle manifest into InstalledExtension.
import { z } from "zod";
import { validateSpawnCommand } from "../lib/mcp-worker-policy.js";

export const EXTENSION_LIMITS = {
  maxBundleBytes: 20 * 1024 * 1024,
  maxExtractedBytes: 100 * 1024 * 1024,
  maxFiles: 2000,
} as const;

export type ExtensionSignature = {
  status: string;
  fingerprint?: string;
} | null | undefined;

// Fail-closed trust decision. 'signed' allows. 'self-signed'/'unsigned'/null
// allow only with explicit per-request allowUnsigned consent. Any other
// status string (expired, invalid, revoked, garbage) always throws.
export function decideTrust(signature: ExtensionSignature, allowUnsigned: boolean): void {
  const status = signature?.status;
  if (status === "signed") return;
  if (status === "self-signed" || status === "unsigned" || signature == null) {
    if (allowUnsigned === true) return;
    throw new Error(
      "Extension is not signed by a trusted signer — pass allowUnsigned to consent to installing an unsigned extension.",
    );
  }
  throw new Error(`Extension signature status '${String(status)}' is not trusted; refusing install.`);
}

// Zip-slip guard for bundle entry names. Zip spec uses '/', hostile zips use
// '\', so normalize backslashes first, then reject: empty names, absolute
// paths (leading / or drive-letter /^[A-Za-z]:/), any '..' segment
// (covers trailing-slash and 'a/../../b' tricks), NUL bytes, >1024 chars.
export function assertSafeZipPath(entry: string): void {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("Unsafe zip entry: empty path.");
  }
  if (entry.length > 1024) {
    throw new Error("Unsafe zip entry: path exceeds 1024 characters.");
  }
  if (entry.includes("\0")) {
    throw new Error("Unsafe zip entry: NUL byte in path.");
  }
  const normalized = entry.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw new Error(`Unsafe zip entry: absolute path '${entry}'.`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe zip entry: drive-letter path '${entry}'.`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Unsafe zip entry: parent-directory traversal in '${entry}'.`);
  }
}

// OUR registry shape (not the bundle manifest — the installer maps the SDK
// manifest into this before persisting).
export const InstalledExtensionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,128}$/),
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(64),
  serverId: z.string().min(1).max(256),
  command: z.string().min(1).max(4096),
  args: z.array(z.string()).max(128),
  cwd: z.string().min(1).max(1024),
  signatureStatus: z.enum(["signed", "self-signed", "unsigned"]),
  installedAt: z.string().datetime(),
});

export type InstalledExtension = z.infer<typeof InstalledExtensionSchema>;

// Thin wrapper over the single policy choke point (no duplicated regex).
// Bundle-controlled commands must pass this before reaching spawn.
export function isTrustedCommand(cmd: string): boolean {
  return validateSpawnCommand(cmd);
}
