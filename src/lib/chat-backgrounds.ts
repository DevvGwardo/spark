import type { CSSProperties } from 'react';

export type ChatBackgroundType = 'solid' | 'gradient' | 'image';
export type ChatBackgroundImageFit = 'cover' | 'contain' | 'stretch' | 'tile';

export interface ChatBackgroundSettings {
  type: ChatBackgroundType;
  imageData: string | null;
  imageFit: ChatBackgroundImageFit;
  imageOpacity: number;
}

export const DEFAULT_CHAT_BACKGROUND_SETTINGS: ChatBackgroundSettings = {
  type: 'gradient',
  imageData: null,
  imageFit: 'cover',
  imageOpacity: 0.4,
};

export function isChatBackgroundType(value: unknown): value is ChatBackgroundType {
  return value === 'solid' || value === 'gradient' || value === 'image';
}

export function isChatBackgroundImageFit(value: unknown): value is ChatBackgroundImageFit {
  return value === 'cover' || value === 'contain' || value === 'stretch' || value === 'tile';
}

export function normalizeChatBackgroundSettings(
  settings: Partial<ChatBackgroundSettings> | undefined,
): ChatBackgroundSettings {
  return {
    type: isChatBackgroundType(settings?.type) ? settings.type : DEFAULT_CHAT_BACKGROUND_SETTINGS.type,
    imageData:
      typeof settings?.imageData === 'string' && settings.imageData.trim().length > 0
        ? settings.imageData
        : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageData,
    imageFit: isChatBackgroundImageFit(settings?.imageFit)
      ? settings.imageFit
      : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageFit,
    imageOpacity:
      typeof settings?.imageOpacity === 'number' && Number.isFinite(settings.imageOpacity)
        ? Math.min(1, Math.max(0.05, settings.imageOpacity))
        : DEFAULT_CHAT_BACKGROUND_SETTINGS.imageOpacity,
  };
}

export function getEffectiveChatBackgroundType(settings: ChatBackgroundSettings): ChatBackgroundType {
  return settings.type === 'image' && !settings.imageData ? 'gradient' : settings.type;
}

export function getChatBackgroundImageStyle(
  imageData: string,
  fit: ChatBackgroundImageFit,
  opacity: number,
): CSSProperties {
  const style: CSSProperties = {
    backgroundImage: `url("${imageData}")`,
    opacity,
  };

  switch (fit) {
    case 'cover':
      style.backgroundPosition = 'center';
      style.backgroundRepeat = 'no-repeat';
      style.backgroundSize = 'cover';
      break;
    case 'contain':
      style.backgroundPosition = 'center';
      style.backgroundRepeat = 'no-repeat';
      style.backgroundSize = 'contain';
      break;
    case 'stretch':
      style.backgroundPosition = 'center';
      style.backgroundRepeat = 'no-repeat';
      style.backgroundSize = '100% 100%';
      break;
    case 'tile':
      style.backgroundPosition = 'center';
      style.backgroundRepeat = 'repeat';
      style.backgroundSize = '280px auto';
      break;
  }

  return style;
}

const DEFAULT_MAX_IMAGE_DIMENSION = 1600;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Unable to read image'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load image'));
    image.src = dataUrl;
  });
}

export async function optimizeChatBackgroundImage(
  file: File,
  maxDimension = DEFAULT_MAX_IMAGE_DIMENSION,
): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const maxSide = Math.max(image.naturalWidth, image.naturalHeight);

  if (!Number.isFinite(maxSide) || maxSide <= maxDimension) {
    return dataUrl;
  }

  const scale = maxDimension / maxSide;
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    return dataUrl;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);

  if (file.type === 'image/png') {
    return canvas.toDataURL('image/png');
  }

  return canvas.toDataURL('image/jpeg', 0.82);
}
