import { logger } from '../lib/logger';
import { Router } from 'express';
import { sendJson } from '../lib/helpers';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const router = Router();

// Saved under ~/.hermes/images so pasted images render inline in chat
// (cloudchat-asset://hermes/...) and are readable by the hermes agent.
const IMAGES_DIR = join(homedir(), '.hermes', 'images');
const MAX_IMAGE_DECODED_SIZE = 10 * 1024 * 1024; // 10 MB decoded

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

router.post('/upload', (req, res) => {
  try {
    const { data, mimeType } = req.body ?? {};

    if (typeof data !== 'string' || !data) {
      return sendJson(res, 400, { error: 'Missing base64 image data.' });
    }

    const extension = MIME_EXTENSIONS[typeof mimeType === 'string' ? mimeType : ''];
    if (!extension) {
      return sendJson(res, 400, {
        error: `Unsupported image type. Supported: ${Object.keys(MIME_EXTENSIONS).join(', ')}`,
      });
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, 'base64');
    } catch {
      return sendJson(res, 400, { error: 'Invalid base64 image data.' });
    }
    if (buffer.length === 0) {
      return sendJson(res, 400, { error: 'Invalid base64 image data.' });
    }
    if (buffer.length > MAX_IMAGE_DECODED_SIZE) {
      return sendJson(res, 413, { error: 'Image exceeds the 10 MB limit.' });
    }

    const hash = createHash('sha256').update(buffer).digest('hex');
    const basename = `pasted-${hash.slice(0, 16)}.${extension}`;
    const path = join(IMAGES_DIR, basename);

    mkdirSync(IMAGES_DIR, { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, buffer);
    }

    return sendJson(res, 200, { path });
  } catch (err: any) {
    logger.error(`[images] Upload error: ${err.message ?? err}`);
    return sendJson(res, 500, { error: err.message ?? 'Image upload failed.' });
  }
});

const EXTENSION_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Serve stored images over HTTP so non-Electron surfaces (web, mobile remote)
// can render them — cloudchat-asset:// only exists inside the Electron shell.
router.get('/file/:name', (req, res) => {
  const name = req.params.name;
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return sendJson(res, 400, { error: 'Invalid image name.' });
  }
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const mime = EXTENSION_MIMES[ext];
  if (!mime) {
    return sendJson(res, 400, { error: 'Unsupported image type.' });
  }
  const path = join(IMAGES_DIR, name);
  if (!existsSync(path)) {
    return sendJson(res, 404, { error: 'Image not found.' });
  }
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(mime).sendFile(path);
});

export function registerImagesRoute(app: Router) {
  app.use('/functions/v1/images', router);
}
