import { Router } from 'express';
import { sendJson } from '../lib/helpers';

const router = Router();

type TranscribeProvider = 'groq' | 'openai';

const MAX_AUDIO_BASE64_SIZE = 10 * 1024 * 1024; // 10 MB decoded

function isTranscribeProvider(value: unknown): value is TranscribeProvider {
  return value === 'groq' || value === 'openai';
}

router.post('/', async (req, res) => {
  const { provider, api_key, audio, filename, language } = req.body as {
    provider?: unknown;
    api_key?: unknown;
    audio?: unknown;
    filename?: unknown;
    language?: unknown;
  };

  if (!isTranscribeProvider(provider)) {
    return sendJson(res, 400, {
      error: 'Missing or invalid provider. Must be "groq" or "openai".',
    });
  }

  if (typeof api_key !== 'string' || !api_key.trim()) {
    return sendJson(res, 400, { error: 'Missing api_key.' });
  }

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

  // Build the upstream Whisper API URL based on provider
  const upstreamUrl =
    provider === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://api.openai.com/v1/audio/transcriptions';

  try {
    // Use global FormData/Blob (available in Node 18+ and Bun)
    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), fname);
    form.append('model', provider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
    form.append('response_format', 'json');
    if (lang) form.append('language', lang);

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api_key}`,
      },
      body: form,
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      let errorMsg = `Upstream ${provider} API returned ${upstreamRes.status}`;
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
    console.error('[transcribe] Error:', err.message ?? err);
    return sendJson(res, 500, { error: err.message ?? 'Transcription failed.' });
  }
});

export function registerTranscribeRoute(app: Router) {
  app.use('/functions/v1/transcribe', router);
}
