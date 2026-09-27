import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, X, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { db } from '@/lib/db';
import { relativeTime } from '@/lib/relative-time';
import { extractImageUrls, type ImageItem } from '@/lib/image-extract';
import { useUIStore } from '@/stores/ui-store';
import { usePanelStore } from '@/stores/panel-store';

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
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const loadImages = useCallback(async () => {
    setLoading(true);
    setError(null);
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
    } catch (err) {
      // Without this the rejection escapes `void loadImages()` unhandled and
      // the panel just stops spinning with no explanation.
      setError(err instanceof Error ? err.message : 'Failed to read local image index');
      setImages([]);
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
        ) : error ? (
          <div className="rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-[11px] text-destructive">
            {error}
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
