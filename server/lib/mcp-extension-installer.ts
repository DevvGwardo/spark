// .mcpb extension installer. Self-authored; no vendor code copied.
// All bundle parsing/validation/signature work goes through the OPEN
// @anthropic-ai/mcpb SDK public API (unpackExtension, validateManifest,
// verifyMcpbFile, extractSignatureBlock, getMcpConfigForManifest,
// vAny.McpbManifestSchema). Trust policy (decideTrust, assertSafeZipPath,
// EXTENSION_LIMITS) is owned by ./mcp-extension-trust.js and loaded via a
// runtime adaptive probe (typeof checks, fail-closed throw if absent).
// Every spawned command passes validateSpawnCommand; every cwd stays under
// the user-data root so the worker policy gate passes.
import { chmodSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  extractSignatureBlock,
  getMcpConfigForManifest,
  unpackExtension,
  vAny,
  validateManifest,
  verifyMcpbFile,
} from '@anthropic-ai/mcpb';
import type { McpbManifestAny } from '@anthropic-ai/mcpb';
import type { McpWorkerSnapshot } from '../../electron/mcp-worker-host.js';
import { validateSpawnCommand } from './mcp-worker-policy.js';
import { spawnWorker, stopWorker } from './mcp-worker-supervisor.js';
import type { InstalledExtension as TrustInstalledExtension } from './mcp-extension-trust.js';

export interface InstalledRef {
  id: string;
  name: string;
  version: string;
  serverId: string;
}

// Full registry record = trust module's schema output + install dir.
export type InstalledExtension = TrustInstalledExtension & { installDir: string };

export interface InstallExtensionInput {
  filename: string;
  data: Buffer;
  allowUnsigned?: boolean;
}

type TrustModule = {
  decideTrust: (signature: { status: string; fingerprint?: string } | null, allowUnsigned: boolean) => void;
  assertSafeZipPath: (entry: string) => void;
  EXTENSION_LIMITS: { maxBundleBytes: number; maxExtractedBytes: number; maxFiles: number };
};

let cachedTrust: TrustModule | null = null;

async function loadTrust(): Promise<TrustModule> {
  if (cachedTrust) return cachedTrust;
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./mcp-extension-trust.js')) as Record<string, unknown>;
  } catch {
    throw new Error('mcp-extension-trust unavailable; refusing extension install (fail-closed).');
  }
  const decideTrust = mod['decideTrust'];
  const assertSafeZipPath = mod['assertSafeZipPath'];
  const limits = mod['EXTENSION_LIMITS'] as Record<string, unknown> | null;
  if (
    typeof decideTrust !== 'function' ||
    typeof assertSafeZipPath !== 'function' ||
    typeof limits !== 'object' ||
    limits === null ||
    typeof limits['maxBundleBytes'] !== 'number' ||
    typeof limits['maxExtractedBytes'] !== 'number' ||
    typeof limits['maxFiles'] !== 'number'
  ) {
    throw new Error('mcp-extension-trust contract mismatch; refusing extension install (fail-closed).');
  }
  cachedTrust = {
    decideTrust: decideTrust as TrustModule['decideTrust'],
    assertSafeZipPath: assertSafeZipPath as TrustModule['assertSafeZipPath'],
    EXTENSION_LIMITS: {
      maxBundleBytes: limits['maxBundleBytes'] as number,
      maxExtractedBytes: limits['maxExtractedBytes'] as number,
      maxFiles: limits['maxFiles'] as number,
    },
  };
  return cachedTrust;
}

function extensionRoot(): string {
  return process.env['CLOUDCHAT_USER_DATA_DIR'] ?? join(homedir(), '.spark');
}

function registryPath(): string {
  return join(extensionRoot(), 'extensions.json');
}

function installDirFor(id: string): string {
  return join(extensionRoot(), 'mcp-extensions', id);
}

function toRef(rec: TrustInstalledExtension): InstalledRef {
  return { id: rec.id, name: rec.name, version: rec.version, serverId: rec.serverId };
}

function slug(value: string, maxLen: number): string {
  const out = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, maxLen);
  return out;
}

// Self-authored zip central-directory scan (entry names + claimed sizes only;
// the SDK owns extraction). Lets us assertSafeZipPath every entry and enforce
// limits BEFORE unpacking, without importing any third-party unzip code.
function listZipEntries(buf: Buffer): Array<{ name: string; uncompressedSize: number }> {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  if (buf.length < 22) throw new Error('Invalid extension bundle: not a zip archive.');
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid extension bundle: end-of-central-directory not found.');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; uncompressedSize: number }> = [];
  let off = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CD_SIG) {
      throw new Error('Invalid extension bundle: corrupt central directory.');
    }
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const nameStart = off + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) throw new Error('Invalid extension bundle: corrupt entry name.');
    entries.push({ name: buf.toString('utf8', nameStart, nameEnd), uncompressedSize });
    off = nameEnd + extraLen + commentLen;
  }
  return entries;
}

async function extractedTreeUsage(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const ents = await readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) {
        files += 1;
        bytes += (await stat(p)).size;
      }
    }
  }
  return { files, bytes };
}

async function readRegistry(): Promise<TrustInstalledExtension[]> {
  const path = registryPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Extension registry is corrupt; refusing to proceed (fail-closed).');
  }
  if (!Array.isArray(parsed)) throw new Error('Extension registry is corrupt; refusing to proceed (fail-closed).');
  const records: TrustInstalledExtension[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>)['id'] === 'string' &&
      typeof (item as Record<string, unknown>)['name'] === 'string' &&
      typeof (item as Record<string, unknown>)['version'] === 'string' &&
      typeof (item as Record<string, unknown>)['serverId'] === 'string' &&
      typeof (item as Record<string, unknown>)['command'] === 'string' &&
      Array.isArray((item as Record<string, unknown>)['args']) &&
      typeof (item as Record<string, unknown>)['cwd'] === 'string'
    ) {
      records.push(item as TrustInstalledExtension);
    } else {
      throw new Error('Extension registry is corrupt; refusing to proceed (fail-closed).');
    }
  }
  return records;
}

async function writeRegistry(records: TrustInstalledExtension[]): Promise<void> {
  await mkdir(extensionRoot(), { recursive: true });
  await writeFile(registryPath(), JSON.stringify(records, null, 2), 'utf8');
}

function resolveServerCommand(
  manifest: McpbManifestAny,
  installDir: string,
  sdkResolved: { command?: string; args?: string[] } | undefined,
  assertSafeZipPath: (entry: string) => void,
): { command: string; args: string[] } {
  // Prefer the SDK-resolved mcp_config only when it already yields an
  // absolute, policy-passing command. Otherwise map server.type+entry_point
  // to absolute in-dir paths (the only other policy-passing resolution).
  if (
    typeof sdkResolved?.command === 'string' &&
    isAbsolute(sdkResolved.command) &&
    validateSpawnCommand(sdkResolved.command)
  ) {
    return { command: sdkResolved.command, args: [...(sdkResolved.args ?? [])] };
  }
  const serverType = manifest.server?.type as string | undefined;
  const entryPoint = manifest.server?.entry_point as string | undefined;
  if (typeof entryPoint !== 'string' || entryPoint.length === 0) {
    throw new Error('Extension manifest has no server.entry_point; refusing install.');
  }
  return resolveFromEntryPoint(serverType, entryPoint, installDir, manifest, assertSafeZipPath);
}

function resolveFromEntryPoint(
  serverType: string | undefined,
  entryPoint: string,
  installDir: string,
  manifest: McpbManifestAny,
  assertSafeZipPath: (entry: string) => void,
): { command: string; args: string[] } {
  // Entry paths get the trust module's zip-slip gate (relative-only), plus a
  // resolve+relative containment check against the install dir.
  assertSafeZipPath(entryPoint);
  const normalized = entryPoint.replace(/\\/g, '/');
  const entryAbs = resolve(installDir, normalized);
  const rel = relative(resolve(installDir), entryAbs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Extension entry_point escapes the install dir; refusing install.');
  }
  const mcpConfig = manifest.server?.mcp_config as
    | { args?: string[]; platform_overrides?: Record<string, { command?: string; args?: string[] }> }
    | undefined;
  const override = mcpConfig?.platform_overrides?.[process.platform];
  const baseArgs = override?.args ?? mcpConfig?.args ?? [];
  if (!Array.isArray(baseArgs) || baseArgs.some((a) => typeof a !== 'string')) {
    throw new Error('Extension manifest args are invalid; refusing install.');
  }
  // Drop a leading duplicate of the entry file when mapping runtimes.
  const rest = baseArgs.filter(
    (a, index) => index !== 0 || (a !== entryAbs && a !== entryPoint && a !== normalized),
  );
  if (serverType === 'node') {
    return { command: process.execPath, args: [entryAbs, ...rest] };
  }
  if (serverType === 'python') {
    const python = '/usr/bin/python3';
    return { command: python, args: [entryAbs, ...rest] };
  }
  if (serverType === 'binary') {
    chmodSync(entryAbs, 0o755);
    return { command: entryAbs, args: [...baseArgs] };
  }
  throw new Error(`Unsupported extension server type '${String(serverType)}'; refusing install.`);
}

export async function installExtension(input: InstallExtensionInput): Promise<InstalledRef> {
  const trust = await loadTrust();
  const { EXTENSION_LIMITS } = trust;
  if (typeof input?.filename !== 'string' || input.filename.length === 0) {
    throw new Error('Extension filename is required.');
  }
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    throw new Error('Extension bundle is empty.');
  }
  if (input.data.byteLength > EXTENSION_LIMITS.maxBundleBytes) {
    throw new Error(
      `Extension bundle exceeds ${String(EXTENSION_LIMITS.maxBundleBytes)} bytes; refusing install.`,
    );
  }
  const allowUnsigned = input.allowUnsigned === true;

  const stageDir = await mkdtemp(join(tmpdir(), 'mcpb-stage-'));
  const stagedPath = join(stageDir, 'extension.mcpb');
  const quarantineDir = join(stageDir, 'unpacked');
  let installDir: string | null = null;
  try {
    await writeFile(stagedPath, input.data);

    // Signature (SDK) → trust gate. Verify failures degrade to unsigned
    // (decideTrust then throws unless allowUnsigned consent was given).
    let signature: { status: string; fingerprint?: string } | null = null;
    try {
      const info = await verifyMcpbFile(stagedPath);
      if (info && typeof info.status === 'string') {
        signature = typeof info.fingerprint === 'string' ? { status: info.status, fingerprint: info.fingerprint } : { status: info.status };
      }
    } catch {
      signature = null;
    }
    trust.decideTrust(signature, allowUnsigned);

    // Pre-unpack entry scan on the signature-stripped payload (SDK helper):
    // zip-slip gate every entry + bundle limits, BEFORE extraction.
    const stagedBytes = await readFile(stagedPath);
    const { originalContent } = extractSignatureBlock(stagedBytes);
    const entries = listZipEntries(originalContent);
    if (entries.length > EXTENSION_LIMITS.maxFiles) {
      throw new Error('Extension bundle exceeds the file-count limit; refusing install.');
    }
    let claimedBytes = 0;
    let hasManifest = false;
    for (const entry of entries) {
      trust.assertSafeZipPath(entry.name);
      claimedBytes += entry.uncompressedSize;
      if (entry.name === 'manifest.json') hasManifest = true;
    }
    if (claimedBytes > EXTENSION_LIMITS.maxExtractedBytes) {
      throw new Error('Extension bundle exceeds the extracted-size limit; refusing install.');
    }
    if (!hasManifest) throw new Error('Extension bundle has no manifest.json; refusing install.');

    // Extract (SDK; path-based so we staged to tmpdir first) + manifest
    // validation (SDK). Both fail closed.
    await mkdir(quarantineDir, { recursive: true });
    const unpacked = await unpackExtension({ mcpbPath: stagedPath, outputDir: quarantineDir, silent: true });
    if (!unpacked) throw new Error('Extension bundle failed to unpack; refusing install.');
    const usage = await extractedTreeUsage(quarantineDir);
    if (usage.files > EXTENSION_LIMITS.maxFiles || usage.bytes > EXTENSION_LIMITS.maxExtractedBytes) {
      throw new Error('Extension extracted content exceeds limits; refusing install.');
    }
    if (!validateManifest(quarantineDir)) {
      throw new Error('Extension manifest failed SDK validation; refusing install.');
    }
    const manifestRaw = await readFile(join(quarantineDir, 'manifest.json'), 'utf8');
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw) as unknown;
    } catch {
      throw new Error('Extension manifest.json is not valid JSON; refusing install.');
    }
    const parsed = vAny.McpbManifestSchema.safeParse(manifestJson);
    if (!parsed.success) throw new Error('Extension manifest failed schema validation; refusing install.');
    const manifest: McpbManifestAny = parsed.data;
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error('Extension manifest is missing name/version; refusing install.');
    }

    const id = `${slug(manifest.name, 64)}-${slug(manifest.version, 32)}`.replace(/^-+|-+$/g, '');
    if (!/^[a-z0-9-]{1,128}$/.test(id)) {
      throw new Error('Extension name/version produce an unsafe id; refusing install.');
    }
    const serverId = `ext:${id}`;
    installDir = installDirFor(id);
    await rm(installDir, { recursive: true, force: true });
    await mkdir(join(extensionRoot(), 'mcp-extensions'), { recursive: true });
    try {
      await rename(quarantineDir, installDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
      await mkdir(installDir, { recursive: true });
      await cp(quarantineDir, installDir, { recursive: true });
    }

    // Entry must exist inside the install dir before command resolution.
    const entryAbs = resolve(installDir, (manifest.server?.entry_point as string).replace(/\\/g, '/'));
    let entryStat;
    try {
      entryStat = await stat(entryAbs);
    } catch {
      throw new Error('Extension entry_point is missing from the bundle; refusing install.');
    }
    if (!entryStat.isFile()) throw new Error('Extension entry_point is not a file; refusing install.');
    // Python runtime availability (node uses process.execPath; binaries are
    // the entry itself). Fail closed here, not at spawn time.
    if ((manifest.server?.type as string) === 'python') {
      try {
        await stat('/usr/bin/python3');
      } catch {
        throw new Error('python3 runtime (/usr/bin/python3) is not available; refusing install.');
      }
    }

    // SDK variable-aware config resolution (handles ${__dirname} and
    // platform_overrides); falls back to type+entry mapping inside
    // resolveServerCommand when the resolved command is unusable.
    let sdkResolved: { command?: string; args?: string[] } | undefined;
    try {
      const resolved = await getMcpConfigForManifest({
        manifest,
        extensionPath: installDir,
        systemDirs: {},
        userConfig: {},
        pathSeparator: sep,
      });
      if (resolved) sdkResolved = { command: resolved.command, args: resolved.args ?? [] };
    } catch {
      sdkResolved = undefined;
    }
    const { command, args } = resolveServerCommand(manifest, installDir, sdkResolved, trust.assertSafeZipPath);
    if (!validateSpawnCommand(command)) {
      throw new Error('Extension server command failed the spawn policy; refusing install.');
    }

    const record: TrustInstalledExtension = {
      id,
      name: manifest.name,
      version: manifest.version,
      serverId,
      command,
      args,
      cwd: installDir,
      signatureStatus: signature?.status === 'signed' || signature?.status === 'self-signed' ? signature.status : 'unsigned',
      installedAt: new Date().toISOString(),
    };
    const records = await readRegistry();
    const next = records.filter((r) => r.id !== id);
    next.push(record);
    await writeRegistry(next);
    return toRef(record);
  } catch (err) {
    if (installDir) await rm(installDir, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

export async function listExtensions(): Promise<InstalledRef[]> {
  await loadTrust();
  const records = await readRegistry();
  return records.map(toRef);
}

export async function uninstallExtension(id: string): Promise<void> {
  await loadTrust();
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(id)) {
    throw new Error('Invalid extension id; refusing uninstall.');
  }
  const serverId = `ext:${id}`;
  try {
    await stopWorker(serverId);
  } catch {
    // Best-effort: the worker may already be stopped.
  }
  const dir = installDirFor(id);
  const rel = relative(resolve(extensionRoot()), resolve(dir));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Extension install dir escapes the extension root; refusing uninstall.');
  }
  await rm(dir, { recursive: true, force: true });
  const records = await readRegistry();
  if (!records.some((r) => r.id === id)) {
    throw new Error(`Unknown extension '${id}'.`);
  }
  await writeRegistry(records.filter((r) => r.id !== id));
}

export async function enableExtension(id: string): Promise<McpWorkerSnapshot> {
  await loadTrust();
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(id)) {
    throw new Error('Invalid extension id; refusing enable.');
  }
  const records = await readRegistry();
  const record = records.find((r) => r.id === id);
  if (!record) throw new Error(`Unknown extension '${id}' (not installed).`);
  if (!validateSpawnCommand(record.command)) {
    throw new Error('Extension server command failed the spawn policy; refusing enable.');
  }
  try {
    await stat(record.cwd);
  } catch {
    throw new Error(`Extension '${id}' install dir is missing; refusing enable.`);
  }
  return spawnWorker({ serverId: record.serverId, command: record.command, args: record.args, cwd: record.cwd });
}
