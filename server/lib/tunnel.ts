import { spawn, type ChildProcess, execSync } from 'child_process';
import { createInterface } from 'readline';

type TunnelProvider = 'cloudflared' | 'localtunnel';

interface TunnelState {
  running: boolean;
  url: string | null;
  provider: TunnelProvider | null;
  error: string | null;
  pid: number | null;
}

let state: TunnelState = {
  running: false,
  url: null,
  provider: null,
  error: null,
  pid: null,
};

let currentProcess: ChildProcess | null = null;

/** Check if cloudflared is on PATH. Uses execSync for proper env resolution. */
export function cloudflaredAvailable(): boolean {
  try {
    execSync('which cloudflared', { stdio: 'ignore', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/** Check if brew is available. Uses execSync for proper env resolution. */
export function brewAvailable(): boolean {
  try {
    execSync('which brew', { stdio: 'ignore', encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

/** Install cloudflared via brew. */
export function installCloudflared(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (!brewAvailable()) {
      resolve({ ok: false, message: 'Homebrew not found. Install cloudflared manually: brew install cloudflared' });
      return;
    }
    const proc = spawn('brew', ['install', 'cloudflared'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    proc.stdout?.on('data', (c) => chunks.push(c.toString()));
    proc.stderr?.on('data', (c) => chunks.push(c.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: 'cloudflared installed successfully.' });
      } else {
        resolve({ ok: false, message: chunks.join('').slice(-200) || 'Install failed.' });
      }
    });
    proc.on('error', () => resolve({ ok: false, message: 'Failed to start brew install.' }));
  });
}

/**
 * Start a tunnel using available provider.
 * Tries cloudflared first, falls back to localtunnel.
 */
export function startTunnel(localPort: number): Promise<TunnelState> {
  return new Promise((resolve) => {
    if (state.running) {
      resolve(state);
      return;
    }

    const useCloudflared = cloudflaredAvailable();

    if (useCloudflared) {
      startCloudflaredTunnel(localPort, resolve);
    } else {
      startLocaltunnel(localPort, resolve);
    }
  });
}

function startCloudflaredTunnel(localPort: number, resolve: (s: TunnelState) => void) {
  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${localPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  currentProcess = proc;

  const rl = createInterface({ input: proc.stdout! });
  let resolved = false;

  rl.on('line', (line) => {
    // cloudflared outputs: "https://xxxx.trycloudflare.com"
    const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !resolved) {
      resolved = true;
      const url = match[0];
      state = { running: true, url, provider: 'cloudflared', error: null, pid: proc.pid ?? null };
      resolve({ ...state });
    }
  });

  proc.stderr?.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !resolved) {
      resolved = true;
      const url = match[0];
      state = { running: true, url, provider: 'cloudflared', error: null, pid: proc.pid ?? null };
      resolve({ ...state });
    }
  });

  proc.on('close', (code) => {
    if (!resolved) {
      state = { running: false, url: null, provider: null, error: `cloudflared exited with code ${code}`, pid: null };
      currentProcess = null;
      resolve({ ...state });
    }
  });

  proc.on('error', (err) => {
    if (!resolved) {
      state = { running: false, url: null, provider: null, error: err.message, pid: null };
      currentProcess = null;
      resolve({ ...state });
    }
  });

  // Timeout after 15s
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      state = { running: false, url: null, provider: null, error: 'cloudflared timed out (15s)', pid: null };
      killTunnel();
      resolve({ ...state });
    }
  }, 15000);
}

function startLocaltunnel(localPort: number, resolve: (s: TunnelState) => void) {
  const proc = spawn('npx', ['--yes', 'localtunnel', '--port', String(localPort)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  currentProcess = proc;

  const rl = createInterface({ input: proc.stdout! });
  let resolved = false;

  rl.on('line', (line) => {
    // localtunnel outputs: "your url is: https://xxxx.loca.lt"
    const match = line.match(/https:\/\/[a-z0-9-]+\.loca\.lt/);
    if (match && !resolved) {
      resolved = true;
      const url = match[0];
      state = { running: true, url, provider: 'localtunnel', error: null, pid: proc.pid ?? null };
      resolve({ ...state });
    }
  });

  proc.stderr?.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.loca\.lt/);
    if (match && !resolved) {
      resolved = true;
      const url = match[0];
      state = { running: true, url, provider: 'localtunnel', error: null, pid: proc.pid ?? null };
      resolve({ ...state });
    }
  });

  proc.on('close', (code) => {
    if (!resolved) {
      state = { running: false, url: null, provider: null, error: `localtunnel exited with code ${code}`, pid: null };
      currentProcess = null;
      resolve({ ...state });
    }
  });

  proc.on('error', (err) => {
    if (!resolved) {
      state = { running: false, url: null, provider: null, error: err.message, pid: null };
      currentProcess = null;
      resolve({ ...state });
    }
  });

  // Timeout after 15s
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      state = { running: false, url: null, provider: null, error: 'localtunnel timed out (15s)', pid: null };
      killTunnel();
      resolve({ ...state });
    }
  }, 15000);
}

/** Stop the running tunnel. */
export function killTunnel() {
  if (currentProcess) {
    try { currentProcess.kill('SIGTERM'); } catch {}
    currentProcess = null;
  }
  state = { running: false, url: null, provider: null, error: null, pid: null };
}

/** Get current tunnel state. */
export function getTunnelState(): TunnelState {
  return { ...state };
}
