import { logger } from '../lib/logger';
import { Router } from 'express';
import { sendJson } from '../lib/helpers';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const router = Router();

type TranscribeProvider = 'groq' | 'openai';

const MAX_AUDIO_BASE64_SIZE = 10 * 1024 * 1024; // 10 MB decoded

function isTranscribeProvider(value: unknown): value is TranscribeProvider {
  return value === 'groq' || value === 'openai';
}

const HERMES_ENV_PATH = join(homedir(), '.hermes', '.env');
const HERMES_AUTH_PATH = join(homedir(), '.hermes', 'auth.json');
const HERMES_FILES_CACHE_TTL_MS = 60_000;

let hermesFilesCache: {
  envContent: string | null;
  authRaw: string | null;
  envMtimeMs: number;
  authMtimeMs: number;
  loadedAt: number;
} | null = null;

function hermesFileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function getHermesFilesCache(): { envContent: string | null; authRaw: string | null } {
  const envMtimeMs = hermesFileMtimeMs(HERMES_ENV_PATH);
  const authMtimeMs = hermesFileMtimeMs(HERMES_AUTH_PATH);
  const now = Date.now();
  const c = hermesFilesCache;
  if (
    c &&
    now - c.loadedAt < HERMES_FILES_CACHE_TTL_MS &&
    c.envMtimeMs === envMtimeMs &&
    c.authMtimeMs === authMtimeMs
  ) {
    return { envContent: c.envContent, authRaw: c.authRaw };
  }

  let envContent: string | null = null;
  let authRaw: string | null = null;
  try {
    envContent = readFileSync(HERMES_ENV_PATH, 'utf8');
  } catch {
    // no ~/.hermes/.env
  }
  try {
    authRaw = readFileSync(HERMES_AUTH_PATH, 'utf8');
  } catch {
    // no ~/.hermes/auth.json
  }

  hermesFilesCache = { envContent, authRaw, envMtimeMs, authMtimeMs, loadedAt: now };
  return { envContent, authRaw };
}

/** Read a single KEY=value from the hermes-agent's ~/.hermes/.env file. */
function readHermesEnvValue(name: string): string | null {
  const { envContent } = getHermesFilesCache();
  if (!envContent) return null;
  for (const line of envContent.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    return value || null;
  }
  return null;
}

/** Read the highest-priority usable API key from ~/.hermes/auth.json credential_pool. */
function readHermesPoolKey(provider: string): string | null {
  const { authRaw } = getHermesFilesCache();
  if (!authRaw) return null;
  try {
    const auth = JSON.parse(authRaw) as {
      credential_pool?: Record<string, Array<{ access_token?: string; priority?: number }>>;
    };
    const pool = auth.credential_pool?.[provider];
    if (Array.isArray(pool)) {
      const sorted = [...pool].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
      for (const cred of sorted) {
        const token = (cred.access_token ?? '').trim();
        if (token && token !== '***') return token;
      }
    }
  } catch {
    // malformed ~/.hermes/auth.json
  }
  return null;
}

/**
 * Resolve a Groq or OpenAI transcription key from the hermes-agent's credentials
 * so users on the Hermes provider don't have to re-enter a key in CloudChat.
 * Checks process env, then ~/.hermes/.env, then ~/.hermes/auth.json. Groq first.
 */
function resolveHermesTranscriptionKey(): { provider: TranscribeProvider; key: string } | null {
  const groq =
    (process.env.GROQ_API_KEY || '').trim() || readHermesEnvValue('GROQ_API_KEY') || readHermesPoolKey('groq');
  if (groq) return { provider: 'groq', key: groq };
  const openai =
    (process.env.OPENAI_API_KEY || '').trim() || readHermesEnvValue('OPENAI_API_KEY') || readHermesPoolKey('openai');
  if (openai) return { provider: 'openai', key: openai };
  return null;
}

// ─── Local whisper.cpp (offline, free, no rate limits) ──────────────────────

const WHISPER_CLI_CANDIDATES = [
  process.env.WHISPER_CLI_PATH,
  '/opt/homebrew/bin/whisper-cli',
  join(homedir(), '.hermes-docker', 'bin', 'whisper-cli'),
  '/usr/local/bin/whisper-cli',
  '/usr/bin/whisper-cli',
];

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

function firstExisting(paths: Array<string | undefined>): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function resolveWhisperModel(): string | null {
  const env = (process.env.WHISPER_CPP_MODEL || process.env.HERMES_WHISPER_CPP_MODEL || '').trim();
  if (env && existsSync(env)) return env;
  const support = join(homedir(), 'Library', 'Application Support', 'superwhisper');
  return firstExisting([
    join(homedir(), '.hermes', 'models', 'ggml-large-v3-turbo.bin'),
    join(support, 'ggml-large-v3-turbo.bin'),
    '/opt/hermes/models/ggml-large-v3-turbo.bin',
    join(homedir(), '.hermes', 'models', 'ggml-small.en.bin'),
    join(support, 'ggml-small.en.bin'),
  ]);
}

interface LocalWhisper {
  cli: string;
  ffmpeg: string;
  model: string;
}

function resolveLocalWhisper(): LocalWhisper | null {
  const cli = firstExisting(WHISPER_CLI_CANDIDATES);
  const ffmpeg = firstExisting(FFMPEG_CANDIDATES);
  const model = resolveWhisperModel();
  return cli && ffmpeg && model ? { cli, ffmpeg, model } : null;
}

function runProcess(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += String(d);
    });
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stderr: String(err) }));
  });
}

/**
 * Transcribe with local whisper.cpp: ffmpeg converts the recording to 16 kHz
 * mono WAV, then whisper-cli runs the GGML model. Quality/anti-hallucination
 * flags mirror the hermes-whisper-cpp patch. Throws on failure so the caller
 * can fall back to the cloud path.
 */
async function transcribeLocally(
  audioBuffer: Buffer,
  ext: string,
  local: LocalWhisper,
  lang?: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cch-stt-'));
  try {
    const inPath = join(dir, `in.${ext || 'webm'}`);
    const wavPath = join(dir, 'audio.wav');
    const outPrefix = join(dir, 'transcript');
    await writeFile(inPath, audioBuffer);

    const ff = await runProcess(local.ffmpeg, [
      '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath, '-y',
    ]);
    if (!existsSync(wavPath)) {
      throw new Error(`ffmpeg conversion failed: ${ff.stderr.slice(-200)}`);
    }

    const w = await runProcess(local.cli, [
      '-m', local.model,
      '-f', wavPath,
      '-l', lang || 'auto',
      '-np', '-nt',
      '-bs', '5', '-bo', '2', '-tp', '0.0', '-mc', '0',
      '--suppress-nst',
      '--prompt', 'Conversation in English.',
      '-otxt', '-of', outPrefix,
    ]);
    const txtPath = `${outPrefix}.txt`;
    if (!existsSync(txtPath)) {
      throw new Error(`whisper-cli failed (code ${w.code}): ${w.stderr.slice(-200)}`);
    }
    return (await readFile(txtPath, 'utf8')).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

router.post('/', async (req, res) => {
  const { provider, api_key, audio, filename, language } = req.body as {
    provider?: unknown;
    api_key?: unknown;
    audio?: unknown;
    filename?: unknown;
    language?: unknown;
  };

  if (typeof audio !== 'string' || !audio.trim()) {
    return sendJson(res, 400, { error: 'Missing audio (base64-encoded).' });
  }

  // Validate base64 size
  const estimatedBytes = Math.ceil(audio.length * 0.75);
  if (estimatedBytes > MAX_AUDIO_BASE64_SIZE) {
    return sendJson(res, 400, {
      error: `Audio too large (${(estimatedBytes / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`,
    });
  }

  // Decode base64 to buffer
  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(audio, 'base64');
  } catch {
    return sendJson(res, 400, { error: 'Invalid base64 audio data.' });
  }

  const fname = typeof filename === 'string' && filename.trim() ? filename.trim() : 'recording.webm';
  const lang = typeof language === 'string' && language.trim() ? language.trim() : undefined;

  // 1. Prefer local whisper.cpp — offline, free, no rate limits, nothing leaves the box.
  const local = resolveLocalWhisper();
  if (local) {
    try {
      const ext = (fname.split('.').pop() || 'webm').toLowerCase();
      const text = await transcribeLocally(audioBuffer, ext, local, lang);
      logger.info(`[transcribe] local whisper.cpp ok (${text.length} chars)`);
      return sendJson(res, 200, { text, provider: 'whisper.cpp' });
    } catch (err: any) {
      logger.warn(`[transcribe] local whisper.cpp failed; falling back to cloud: ${err?.message ?? err}`);
    }
  }

  // 2. Cloud fallback — the key the client sent (CloudChat settings), else the
  // Hermes agent's Groq/OpenAI credential so Hermes-provider users need no key.
  let resolvedProvider: TranscribeProvider;
  let resolvedKey: string;
  if (typeof api_key === 'string' && api_key.trim()) {
    if (!isTranscribeProvider(provider)) {
      return sendJson(res, 400, {
        error: 'Missing or invalid provider. Must be "groq" or "openai".',
      });
    }
    resolvedProvider = provider;
    resolvedKey = api_key.trim();
  } else {
    const fromHermes = resolveHermesTranscriptionKey();
    if (!fromHermes) {
      return sendJson(res, 400, {
        error:
          'No transcription available. Install whisper.cpp + ffmpeg + a GGML model, add a Groq or OpenAI API key in CloudChat settings, or authenticate Groq/OpenAI in your Hermes agent.',
      });
    }
    resolvedProvider = fromHermes.provider;
    resolvedKey = fromHermes.key;
  }

  // Build the upstream Whisper API URL based on provider
  const upstreamUrl =
    resolvedProvider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';

  try {
    // Use global FormData/Blob (available in Node 18+ and Bun)
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audioBuffer)]), fname);
    form.append('model', resolvedProvider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
    form.append('response_format', 'json');
    if (lang) form.append('language', lang);

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedKey}`,
      },
      body: form,
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      let errorMsg = `Upstream ${resolvedProvider} API returned ${upstreamRes.status}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed?.error?.message) errorMsg = parsed.error.message;
      } catch {
        if (errText) errorMsg = errText.slice(0, 300);
      }
      return sendJson(res, 502, { error: errorMsg });
    }

    const data = (await upstreamRes.json()) as { text?: string };
    return sendJson(res, 200, { text: data.text ?? '' });
  } catch (err: any) {
    logger.error(`[transcribe] Error: ${err.message ?? err}`);
    return sendJson(res, 500, { error: err.message ?? 'Transcription failed.' });
  }
});

export function registerTranscribeRoute(app: Router) {
  app.use('/functions/v1/transcribe', router);
}
