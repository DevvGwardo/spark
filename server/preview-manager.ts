import { spawn, ChildProcess } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

interface ActivePreview {
  id: string;
  owner: string;
  repo: string;
  dir: string;
  port: number;
  process: ChildProcess | null;
  status: 'cloning' | 'installing' | 'building' | 'running' | 'error' | 'stopped';
  error?: string;
  logs: string[];
}

const activePreview: Map<string, ActivePreview> = new Map();
let nextPort = 3100;

function getPreviewId(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function appendLog(preview: ActivePreview, line: string) {
  preview.logs.push(line);
  // Keep last 200 lines
  if (preview.logs.length > 200) {
    preview.logs = preview.logs.slice(-200);
  }
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  preview: ActivePreview,
  label: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    appendLog(preview, `[${label}] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { cwd, env: { ...process.env, CI: 'true' } });

    proc.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((l: string) => appendLog(preview, `[${label}] ${l}`));
    });

    proc.stderr?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      lines.forEach((l: string) => appendLog(preview, `[${label}] ${l}`));
    });

    proc.on('close', (code) => resolve(code ?? 1));
    proc.on('error', (err) => reject(err));
  });
}

function startDevServer(
  cwd: string,
  port: number,
  preview: ActivePreview
): ChildProcess {
  // Detect project type and choose command
  const hasPackageJson = existsSync(join(cwd, 'package.json'));

  let cmd: string;
  let args: string[];

  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      const scripts = pkg.scripts || {};

      if (scripts.dev) {
        // Most frameworks (Next.js, Vite, etc.) use "dev"
        cmd = 'npx';
        args = ['--yes', 'cross-env', `PORT=${port}`, 'npm', 'run', 'dev', '--', '--port', String(port)];
      } else if (scripts.start) {
        cmd = 'npx';
        args = ['--yes', 'cross-env', `PORT=${port}`, 'npm', 'run', 'start'];
      } else {
        // Fallback: try to serve static files
        cmd = 'npx';
        args = ['--yes', 'serve', '-l', String(port), '-s', '.'];
      }
    } catch {
      cmd = 'npx';
      args = ['--yes', 'serve', '-l', String(port), '-s', '.'];
    }
  } else {
    // No package.json — serve static files
    cmd = 'npx';
    args = ['--yes', 'serve', '-l', String(port), '-s', '.'];
  }

  appendLog(preview, `[dev-server] Starting: ${cmd} ${args.join(' ')}`);

  const proc = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      BROWSER: 'none',
      CI: 'true',
    },
  });

  proc.stdout?.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach((l: string) => appendLog(preview, `[dev-server] ${l}`));
  });

  proc.stderr?.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    lines.forEach((l: string) => appendLog(preview, `[dev-server] ${l}`));
  });

  proc.on('error', (err) => {
    appendLog(preview, `[dev-server] Error: ${err.message}`);
    preview.status = 'error';
    preview.error = err.message;
  });

  proc.on('close', (code) => {
    if (preview.status === 'running') {
      appendLog(preview, `[dev-server] Exited with code ${code}`);
      preview.status = 'stopped';
    }
  });

  return proc;
}

async function waitForServer(port: number, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function startPreview(
  owner: string,
  repo: string,
  pat: string,
  branch?: string
): Promise<{ id: string; port: number; url: string }> {
  const id = getPreviewId(owner, repo);

  // Stop existing preview for this repo if any
  const existing = activePreview.get(id);
  if (existing) {
    await stopPreview(owner, repo);
  }

  const port = nextPort++;
  const dir = await mkdtemp(join(tmpdir(), `cloudchat-preview-`));

  const preview: ActivePreview = {
    id,
    owner,
    repo,
    dir,
    port,
    process: null,
    status: 'cloning',
    logs: [],
  };
  activePreview.set(id, preview);

  try {
    // Clone the repo — pass auth via http.extraHeader to avoid embedding the PAT in the URL
    const cloneUrl = `https://github.com/${owner}/${repo}.git`;
    const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${pat}`).toString('base64')}`;
    const cloneArgs = ['clone', '-c', `http.extraHeader=${authHeader}`, '--depth', '1'];
    if (branch) {
      cloneArgs.push('--branch', branch);
    }
    cloneArgs.push(cloneUrl, '.');

    const cloneCode = await runCommand('git', cloneArgs, dir, preview, 'clone');
    if (cloneCode !== 0) {
      throw new Error('Git clone failed');
    }

    // Install dependencies
    const hasPackageLock = existsSync(join(dir, 'package-lock.json'));
    const hasYarnLock = existsSync(join(dir, 'yarn.lock'));
    const hasPnpmLock = existsSync(join(dir, 'pnpm-lock.yaml'));
    const hasBunLock = existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'));

    if (existsSync(join(dir, 'package.json'))) {
      preview.status = 'installing';

      let installCode: number;
      if (hasBunLock) {
        installCode = await runCommand('bun', ['install'], dir, preview, 'install');
      } else if (hasPnpmLock) {
        installCode = await runCommand('pnpm', ['install', '--no-frozen-lockfile'], dir, preview, 'install');
      } else if (hasYarnLock) {
        installCode = await runCommand('yarn', ['install'], dir, preview, 'install');
      } else {
        installCode = await runCommand('npm', ['install'], dir, preview, 'install');
      }

      if (installCode !== 0) {
        throw new Error('Dependency installation failed');
      }
    }

    // Start dev server
    preview.status = 'building';
    preview.process = startDevServer(dir, port, preview);

    // Wait for server to be ready
    const ready = await waitForServer(port, 90000);
    if (!ready) {
      throw new Error('Dev server failed to start within 90 seconds');
    }

    preview.status = 'running';
    return { id, port, url: `http://localhost:${port}` };
  } catch (err: unknown) {
    preview.status = 'error';
    preview.error = err instanceof Error ? err.message : String(err);
    // Clean up on error
    if (preview.process) {
      preview.process.kill('SIGTERM');
    }
    throw err;
  }
}

export async function stopPreview(owner: string, repo: string): Promise<void> {
  const id = getPreviewId(owner, repo);
  const preview = activePreview.get(id);
  if (!preview) return;

  if (preview.process) {
    preview.process.kill('SIGTERM');
    // Force kill after 5 seconds
    setTimeout(() => {
      if (preview.process && !preview.process.killed) {
        preview.process.kill('SIGKILL');
      }
    }, 5000);
  }

  preview.status = 'stopped';

  // Clean up temp directory
  try {
    await rm(preview.dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }

  activePreview.delete(id);
}

export async function applyChanges(
  owner: string,
  repo: string,
  changes: Array<{ path: string; action: 'create' | 'edit' | 'delete'; content: string }>
): Promise<void> {
  const id = getPreviewId(owner, repo);
  const preview = activePreview.get(id);
  if (!preview) {
    throw new Error('No active preview for this repo');
  }

  for (const change of changes) {
    const filePath = join(preview.dir, change.path);
    const resolved = resolve(filePath);
    if (!resolved.startsWith(preview.dir)) {
      throw new Error(`Path traversal blocked: ${change.path}`);
    }

    if (change.action === 'delete') {
      try {
        await rm(filePath, { force: true });
      } catch {
        // File might not exist
      }
    } else {
      // Create parent directories if needed
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }
      await writeFile(filePath, change.content, 'utf-8');
    }
  }

  appendLog(preview, `[changes] Applied ${changes.length} file change(s)`);
}

export function getPreviewStatus(owner: string, repo: string) {
  const id = getPreviewId(owner, repo);
  const preview = activePreview.get(id);
  if (!preview) return null;

  return {
    id: preview.id,
    status: preview.status,
    port: preview.port,
    url: preview.status === 'running' ? `http://localhost:${preview.port}` : null,
    error: preview.error,
    logs: preview.logs.slice(-50),
  };
}

export function getAllPreviews() {
  return Array.from(activePreview.values()).map((p) => ({
    id: p.id,
    owner: p.owner,
    repo: p.repo,
    status: p.status,
    port: p.port,
    url: p.status === 'running' ? `http://localhost:${p.port}` : null,
  }));
}

// Cleanup all previews on process exit
process.on('exit', () => {
  for (const preview of activePreview.values()) {
    if (preview.process) {
      preview.process.kill('SIGKILL');
    }
  }
});

process.on('SIGINT', async () => {
  for (const [, preview] of activePreview) {
    await stopPreview(preview.owner, preview.repo);
  }
  process.exit(0);
});
