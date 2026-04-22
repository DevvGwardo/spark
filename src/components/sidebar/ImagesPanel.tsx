import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, X, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { db, type Conversation, type Message } from '@/lib/db';
import { relativeTime } from '@/lib/relative-time';
import {
  getLocalImageTarget,
  LOCAL_IMAGE_TOKEN_RE,
} from '@/lib/local-images';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';

interface ImageItem {
  url: string;
  srcUrl: string;
  conversationId: string;
  conversationTitle: string;
  timestamp: string;
  messageId: string;
}

// Matches markdown image syntax: ![alt](url)
const MARKDOWN_IMAGE_REGEX = /!\[[^\]]*\]\(([^)]+)\)/g;
// Matches standalone image URLs with common extensions (http, https)
const STANDALONE_IMAGE_URL_REGEX = /(?<!\()https?:\/\/[^\s<>"]+\.(?:png|jpg|jpeg|gif|webp|svg|avif|jfif)(?:\?[^\s<>"]*)?/gi;
// Matches cloudchat-asset:// URLs (local images stored by hermes)
const CLOUDCHAT_ASSET_URL_REGEX = /(?<!\()cloudchat-asset:\/\/[^\s<>"]+/gi;
// Matches data URIs for images
const DATA_URI_REGEX = /(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)/g;
// Matches local image paths wrapped in inline code spans
const INLINE_CODE_LOCAL_IMAGE_REGEX = /`((?:MEDIA:|:)?(?:~\/\S+|\/(?:Users|home|tmp|var|opt|etc|private)\/\S+?)\.(?:png|jpe?g|gif|webp|svg|avif|bmp))`/gi;

function getRenderableImage(url: string): { originalUrl: string; srcUrl: string } | null {
  const trimmed = url.trim().replace(/^<(.+)>$/, '$1').replace(/^`(.+)`$/, '$1');
  if (!trimmed) return null;

  const localTarget = getLocalImageTarget(trimmed);
  if (localTarget) {
    return {
      originalUrl: trimmed,
      srcUrl: localTarget.srcUrl,
    };
  }

  if (/^(?:https?:\/\/|data:image\/)/i.test(trimmed)) {
    return {
      originalUrl: trimmed,
      srcUrl: trimmed,
    };
  }

  return null;
}

function getToolResultText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (typeof r.output === 'string' && r.output.trim()) return r.output;
  if (typeof r.message === 'string' && r.message.trim()) return r.message;
  if (Array.isArray(r.content)) {
    const textParts = r.content
      .filter((c) => typeof c === 'object' && c && (c as Record<string, unknown>).type === 'text')
      .map((c) => ((c as Record<string, unknown>).text as string) || '')
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('\n');
  }
  if (typeof r.result === 'string' && r.result.trim()) return r.result;
  return null;
}

function collectToolResultTexts(msg: Message): string[] {
  const texts: string[] = [];

  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    if (p.type !== 'tool-invocation') continue;
    const invocation = p.toolInvocation as Record<string, unknown> | undefined;
    if (!invocation) continue;
    const text = getToolResultText(invocation.result);
    if (text) texts.push(text);
  }

  const invocations = Array.isArray(msg.toolInvocations) ? msg.toolInvocations : [];
  for (const invocation of invocations) {
    if (!invocation || typeof invocation !== 'object') continue;
    const text = getToolResultText((invocation as Record<string, unknown>).result);
    if (text) texts.push(text);
  }

  return texts;
}

export function extractImageUrls(messages: Message[], conv: Conversation): ImageItem[] {
  const images: ImageItem[] = [];
  const seen = new Set<string>();

  const addUrl = (url: string, msg: Message) => {
    const renderable = getRenderableImage(url);
    if (!renderable) return;
    if (seen.has(renderable.originalUrl)) return;
    seen.add(renderable.originalUrl);
    images.push({
      url: renderable.originalUrl,
      srcUrl: renderable.srcUrl,
      conversationId: conv.id,
      conversationTitle: conv.title,
      timestamp: msg.timestamp,
      messageId: msg.id,
    });
  };

  const scanBlob = (text: string, msg: Message) => {
    // Extract from markdown ![alt](url)
    for (const match of text.matchAll(MARKDOWN_IMAGE_REGEX)) {
      const url = match[1]?.trim();
      if (url) addUrl(url, msg);
    }

    // Extract standalone image URLs not already inside markdown syntax
    for (const match of text.matchAll(STANDALONE_IMAGE_URL_REGEX)) {
      addUrl(match[0], msg);
    }

    // Extract cloudchat-asset URLs (local images stored by hermes)
    for (const match of text.matchAll(CLOUDCHAT_ASSET_URL_REGEX)) {
      addUrl(match[0], msg);
    }

    // Extract bare local image paths in plaintext tool output
    const localImageRegex = new RegExp(LOCAL_IMAGE_TOKEN_RE);
    for (const match of text.matchAll(localImageRegex)) {
      const path = match[2]?.trim();
      if (path) addUrl(path, msg);
    }

    // Extract inline-code local image paths rendered by the transcript
    for (const match of text.matchAll(INLINE_CODE_LOCAL_IMAGE_REGEX)) {
      const path = match[1]?.trim();
      if (path) addUrl(path, msg);
    }

    // Extract data URIs
    for (const match of text.matchAll(DATA_URI_REGEX)) {
      addUrl(match[1], msg);
    }
  };

  for (const msg of messages) {
    if (msg.role !== 'assistant' && msg.role !== 'user') continue;

    if (msg.content) scanBlob(msg.content, msg);

    for (const toolText of collectToolResultTexts(msg)) {
      scanBlob(toolText, msg);
    }
  }

  return images;
}

function ImageThumbnail({ image }: { image: ImageItem }) {
  const [hasError, setHasError] = React.useState(false);

  if (hasError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/30">
        <div className="text-[10px] text-muted-foreground/50">Unavailable</div>
      </div>
    );
  }

  return (
    <img
      src={image.srcUrl}
      alt=""
      className="h-full w-full object-cover"
      loading="lazy"
      onError={() => setHasError(true)}
    />
  );
}

function Lightbox({
  images,
  initialIndex,
  onClose,
  onNavigate,
}: {
  images: ImageItem[];
  initialIndex: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const { setActiveTab, setActiveSubTab } = useUIStore();
  const { focusedPanelId, setConversationForPanel } = usePanelStore();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [hasError, setHasError] = useState(false);
  const current = images[currentIndex];

  useEffect(() => {
    setCurrentIndex(initialIndex);
    setHasError(false);
  }, [initialIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        setCurrentIndex((i) => i - 1);
        onNavigate(currentIndex - 1);
      }
      if (e.key === 'ArrowRight' && currentIndex < images.length - 1) {
        setCurrentIndex((i) => i + 1);
        onNavigate(currentIndex + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentIndex, images.length, onClose, onNavigate]);

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex((i) => i - 1);
      onNavigate(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex((i) => i + 1);
      onNavigate(currentIndex + 1);
    }
  };

  const handleGoToConversation = () => {
    setActiveTab('chat');
    setConversationForPanel(focusedPanelId, current.conversationId);
    setActiveSubTab('threads');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={onClose}
    >
      <button
        className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
        onClick={(e) => { e.stopPropagation(); handlePrev(); }}
        disabled={currentIndex === 0}
      >
        <ChevronLeft className="h-6 w-6" />
      </button>

      <div className="max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        {hasError ? (
          <div className="flex h-[50vh] w-[50vw] items-center justify-center bg-muted/30">
            <div className="text-[14px] text-muted-foreground">Image unavailable</div>
          </div>
        ) : (
          <img
            src={current.srcUrl}
            alt=""
            className="max-h-[85vh] max-w-full object-contain"
            onError={() => setHasError(true)}
          />
        )}
        <div className="mt-3 flex flex-col items-center gap-2 text-center text-[12px] text-white/60">
          <button
            onClick={handleGoToConversation}
            className="group flex items-center gap-1 text-white/80 transition-colors hover:text-white"
          >
            <span className="truncate max-w-[300px]">{current.conversationTitle}</span>
            <ExternalLink className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
          <div className="text-white/40">
            {currentIndex + 1} / {images.length} · {relativeTime(current.timestamp)}
          </div>
        </div>
      </div>

      <button
        className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
        onClick={(e) => { e.stopPropagation(); handleNext(); }}
        disabled={currentIndex === images.length - 1}
      >
        <ChevronRight className="h-6 w-6" />
      </button>

      <button
        className="absolute right-4 top-4 rounded-full p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        onClick={onClose}
      >
        <X className="h-6 w-6" />
      </button>
    </div>
  );
}

export function ImagesPanel() {
  const [loading, setLoading] = useState(true);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const loadImages = useCallback(async () => {
    setLoading(true);
    try {
      const allImages: ImageItem[] = [];
      const convs = await db.conversations.getAll();

      for (const conv of convs) {
        const messages = await db.messages.getByConversation(conv.id);
        const extracted = extractImageUrls(messages, conv);
        allImages.push(...extracted);
      }

      allImages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setImages(allImages);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadImages();
  }, [loadImages]);

  const handleImageClick = (index: number) => {
    setLightboxIndex(index);
  };

  const handleLightboxClose = () => {
    setLightboxIndex(null);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Images</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {images.length} image{images.length !== 1 ? 's' : ''} found
          </p>
        </div>
        <button
          onClick={() => void loadImages()}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh images"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground/60">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading images...
          </div>
        ) : images.length === 0 ? (
          <div className="rounded-xl border border-border/30 bg-background/30 p-4 text-[12px] text-muted-foreground/55">
            No images found in conversations yet. Images from assistant responses will appear here.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {images.map((img, index) => (
              <button
                key={`${img.conversationId}-${img.url}-${index}`}
                onClick={() => handleImageClick(index)}
                className="group relative aspect-square overflow-hidden rounded-lg border border-border/40 bg-background/40 transition-colors hover:border-border"
              >
                <ImageThumbnail image={img} />
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="text-[10px] text-white">View</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {lightboxIndex !== null && (
        <Lightbox
          images={images}
          initialIndex={lightboxIndex}
          onClose={handleLightboxClose}
          onNavigate={(idx) => setLightboxIndex(idx)}
        />
      )}
    </div>
  );
}
