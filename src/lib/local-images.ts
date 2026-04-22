const LOCAL_PATH_RE = /^\/(?:Users|home|tmp|var|opt|etc|private)\/.+$/;
const CLOUDCHAT_ASSET_PROTOCOL = 'cloudchat-asset:';
const HERMES_IMAGE_PATH_RE = /^\/(?:Users|home)\/[^/]+\/\.hermes\/images\/[^/]+$/;
const SNAPSHOT_BASENAME_RE = /^[0-9a-f]{64}\.(png|jpe?g|gif|webp|svg|avif|bmp)$/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:\?\S*)?$/i;

export const LOCAL_IMAGE_TOKEN_RE = /(^|\s)(?:MEDIA:|:)?((?:~\/\S+?|\/(?:Users|home|tmp|var|opt|etc|private)\/\S+?)\.(?:png|jpe?g|gif|webp|svg|avif|bmp))([.,)\];:]+)?(?=\s|$)/gi;

export interface LocalImageTarget {
  srcUrl: string;
  openUrl: string;
  path: string;
}

function getCurrentHomeDir(): string | null {
  const homeDir = window.electronAPI?.homeDir;
  if (homeDir && /^\/(?:Users|home)\/[^/]+$/.test(homeDir)) {
    return homeDir;
  }

  const locationPath = window.location?.pathname ?? '';
  const match = locationPath.match(/^\/(?:Users|home)\/[^/]+/);
  return match ? match[0] : null;
}

function getExpandedPath(path: string): string | null {
  if (!path.startsWith('~/')) return path;

  const homeDir = getCurrentHomeDir();
  if (!homeDir) return null;

  return `${homeDir}/${path.slice(2)}`;
}

function toFileUrl(path: string): string {
  return `file://${path}`;
}

function isSafeAssetBasename(basename: string): boolean {
  return !!basename && !basename.includes('..') && !basename.includes('/') && !basename.includes('\\');
}

function getLocalImageAssetUrl(path: string): string | null {
  const snapshotDir = window.electronAPI?.snapshotDir;
  if (snapshotDir) {
    const snapshotPrefix = `${snapshotDir}/`;
    const snapshotBasename = path.startsWith(snapshotPrefix) ? path.slice(snapshotPrefix.length) : null;
    if (snapshotBasename && SNAPSHOT_BASENAME_RE.test(snapshotBasename)) {
      return `cloudchat-asset://snapshot/${encodeURIComponent(snapshotBasename)}`;
    }
  }

  const tmpBasename = path.startsWith('/tmp/') ? path.slice('/tmp/'.length) : null;
  if (tmpBasename && isSafeAssetBasename(tmpBasename)) {
    return `cloudchat-asset://tmp/${encodeURIComponent(tmpBasename)}`;
  }

  const homeDir = getCurrentHomeDir();
  if (homeDir) {
    const hermesPrefix = `${homeDir}/.hermes/images/`;
    const hermesBasename = path.startsWith(hermesPrefix) ? path.slice(hermesPrefix.length) : null;
    if (hermesBasename && isSafeAssetBasename(hermesBasename)) {
      return `cloudchat-asset://hermes/${encodeURIComponent(hermesBasename)}`;
    }
  } else if (HERMES_IMAGE_PATH_RE.test(path)) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (isSafeAssetBasename(basename)) {
      return `cloudchat-asset://hermes/${encodeURIComponent(basename)}`;
    }
  }

  return null;
}

function getCloudChatAssetPath(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== CLOUDCHAT_ASSET_PROTOCOL) {
      return null;
    }

    const rawBasename = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
    if (!rawBasename) return null;

    const basename = decodeURIComponent(rawBasename);
    if (!isSafeAssetBasename(basename)) return null;

    if (url.hostname === 'tmp') {
      return `/tmp/${basename}`;
    }

    if (url.hostname === 'hermes') {
      const homeDir = getCurrentHomeDir();
      if (!homeDir) return null;
      return `${homeDir}/.hermes/images/${basename}`;
    }

    if (url.hostname === 'snapshot') {
      const snapshotDir = window.electronAPI?.snapshotDir;
      if (!snapshotDir || !SNAPSHOT_BASENAME_RE.test(basename)) return null;
      return `${snapshotDir}/${basename}`;
    }

    return null;
  } catch {
    return null;
  }
}

export function getLocalAbsolutePath(text: string): string | null {
  const trimmed = text.trim().replace(/^(?:MEDIA:|:)/i, '');
  const assetPath = getCloudChatAssetPath(trimmed);
  if (assetPath) return assetPath;

  if (/^file:\/\/\/.+$/i.test(trimmed)) {
    try {
      const pathname = decodeURIComponent(new URL(trimmed).pathname);
      return LOCAL_PATH_RE.test(pathname) ? pathname : null;
    } catch {
      return null;
    }
  }

  const expandedPath = getExpandedPath(trimmed);
  return expandedPath && LOCAL_PATH_RE.test(expandedPath) ? expandedPath : null;
}

export function getOpenableUrl(text: string): string | null {
  const path = getLocalAbsolutePath(text);
  if (!path) return null;

  return toFileUrl(path);
}

export function getLocalImageTarget(text: string): LocalImageTarget | null {
  const path = getLocalAbsolutePath(text);
  if (!path || !IMAGE_EXT_RE.test(path)) return null;

  return {
    srcUrl: getLocalImageAssetUrl(path) ?? toFileUrl(path),
    openUrl: toFileUrl(path),
    path,
  };
}

export function getImageUrl(text: string): string | null {
  return getLocalImageTarget(text)?.srcUrl ?? null;
}

export function defaultSafeUrlTransform(url: string): string {
  const trimmed = url.trim();
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex < 0) return trimmed;

  const slashIndex = trimmed.indexOf('/');
  const questionIndex = trimmed.indexOf('?');
  const hashIndex = trimmed.indexOf('#');
  const firstTailIndex = [slashIndex, questionIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((min, index) => Math.min(min, index), Number.POSITIVE_INFINITY);

  if (firstTailIndex !== Number.POSITIVE_INFINITY && colonIndex > firstTailIndex) {
    return trimmed;
  }

  const protocol = trimmed.slice(0, colonIndex);
  return /^(https?|ircs?|mailto|xmpp)$/i.test(protocol) ? trimmed : '';
}

export function isImageSrcUrl(key: string, node: unknown): boolean {
  if (key !== 'src' || !node || typeof node !== 'object') return false;
  return 'tagName' in node && node.tagName === 'img';
}

export function rewriteLocalImageTokens(markdown: string): string {
  return markdown.replace(LOCAL_IMAGE_TOKEN_RE, (match: string, leading: string, path: string, trailing = '') => {
    const imageUrl = getImageUrl(path);
    if (!imageUrl) return match;
    return `${leading}![${path}](${imageUrl})${trailing}`;
  });
}
