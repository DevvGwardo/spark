import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Globe, ArrowLeft, ArrowRight, X, ExternalLink } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const CURSOR_MAP: Record<ResizeDir, string> = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
};

const MIN_WIDTH = 400;
const MIN_HEIGHT = 250;
const TOOLBAR_HEIGHT = 36;
const EDGE_ZONE = 14; // px from edge to trigger resize

export const MiniBrowserToggle: React.FC<{ className?: string }> = ({ className }) => {
  const { miniBrowserOpen, setMiniBrowserOpen, setMiniBrowserUrl } = useUIStore();

  const handleToggle = useCallback(() => {
    if (miniBrowserOpen) {
      window.electronAPI?.browser?.close();
      setMiniBrowserOpen(false);
    } else {
      setMiniBrowserUrl('about:blank');
      setMiniBrowserOpen(true);
      window.electronAPI?.browser?.create('about:blank');
    }
  }, [miniBrowserOpen, setMiniBrowserOpen, setMiniBrowserUrl]);

  return (
    <button
      onClick={handleToggle}
      className={cn(
        'inline-flex items-center justify-center h-8 w-8 rounded-md transition-colors',
        miniBrowserOpen
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent',
        className
      )}
      title={miniBrowserOpen ? 'Close mini browser' : 'Open mini browser'}
    >
      <Globe className="h-4 w-4" />
    </button>
  );
};

export const MiniBrowser: React.FC = () => {
  const { miniBrowserOpen, setMiniBrowserOpen, miniBrowserUrl, setMiniBrowserUrl } = useUIStore();
  const [urlInput, setUrlInput] = useState('');
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 600, height: 400 });
  const isInteracting = useRef(false);
  const browserViewHidden = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Sync URL input with store
  useEffect(() => {
    if (miniBrowserUrl && miniBrowserUrl !== 'about:blank') {
      setUrlInput(miniBrowserUrl);
    }
  }, [miniBrowserUrl]);

  // Position in bottom-right by default
  useEffect(() => {
    if (miniBrowserOpen) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setPosition({ x: w - size.width - 20, y: h - size.height - 60 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniBrowserOpen]);

  // Update BrowserView bounds when position/size changes
  useEffect(() => {
    if (miniBrowserOpen) {
      window.electronAPI?.browser?.resize({
        x: position.x,
        y: position.y + TOOLBAR_HEIGHT,
        width: size.width,
        height: size.height - TOOLBAR_HEIGHT,
      });
    }
  }, [miniBrowserOpen, position, size]);

  // Cleanup: show BrowserView when component unmounts
  useEffect(() => {
    return () => {
      if (browserViewHidden.current) {
        window.electronAPI?.browser?.show();
      }
    };
  }, []);

  const hideBrowserView = useCallback(() => {
    if (!browserViewHidden.current) {
      browserViewHidden.current = true;
      window.electronAPI?.browser?.hide();
    }
  }, []);

  const showBrowserView = useCallback(() => {
    if (browserViewHidden.current) {
      browserViewHidden.current = false;
      window.electronAPI?.browser?.show();
    }
  }, []);

  const handleNavigate = useCallback(() => {
    let url = urlInput.trim();
    if (!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
      setUrlInput(url);
    }
    setMiniBrowserUrl(url);
    window.electronAPI?.browser?.navigate(url);
  }, [urlInput, setMiniBrowserUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleNavigate();
    },
    [handleNavigate]
  );

  const handleBack = useCallback(() => window.electronAPI?.browser?.goBack(), []);
  const handleForward = useCallback(() => window.electronAPI?.browser?.goForward(), []);
  const handleClose = useCallback(() => {
    window.electronAPI?.browser?.close();
    setMiniBrowserOpen(false);
  }, [setMiniBrowserOpen]);

  // Unified mouseDown handler — detects drag (toolbar) vs resize (edges/corners)
  const handleContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isInteracting.current) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, button, a, [contenteditable]')) return;

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;

      // Detect edge/corner
      const nearLeft = relX < EDGE_ZONE;
      const nearRight = relX > w - EDGE_ZONE;
      const nearTop = relY < EDGE_ZONE;
      const nearBottom = relY > h - EDGE_ZONE;

      let dir = '';
      if (nearTop) dir += 'n';
      if (nearBottom) dir += 's';
      if (nearLeft) dir += 'w';
      if (nearRight) dir += 'e';

      // Edge/corner resize
      if (dir) {
        e.preventDefault();
        isInteracting.current = true;
        hideBrowserView();

        const startX = e.clientX;
        const startY = e.clientY;
        const startW = size.width;
        const startH = size.height;
        const startPosX = position.x;
        const startPosY = position.y;
        const resizeDir = dir as ResizeDir;

        document.body.style.cursor = CURSOR_MAP[resizeDir];
        document.body.style.userSelect = 'none';

        const onMouseMove = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let newW = startW, newH = startH, newX = startPosX, newY = startPosY;

          if (resizeDir.includes('e')) newW = Math.max(MIN_WIDTH, startW + dx);
          if (resizeDir.includes('w')) {
            const possible = startW - dx;
            if (possible >= MIN_WIDTH) { newW = possible; newX = startPosX + dx; }
            else { newW = MIN_WIDTH; newX = startPosX + (startW - MIN_WIDTH); }
          }
          if (resizeDir.includes('s')) newH = Math.max(MIN_HEIGHT, startH + dy);
          if (resizeDir.includes('n')) {
            const possible = startH - dy;
            if (possible >= MIN_HEIGHT) { newH = possible; newY = startPosY + dy; }
            else { newH = MIN_HEIGHT; newY = startPosY + (startH - MIN_HEIGHT); }
          }

          const maxW = window.innerWidth - newX;
          const maxH = window.innerHeight - newY;
          newW = Math.min(newW, maxW);
          newH = Math.min(newH, maxH);
          newX = Math.max(0, newX);
          newY = Math.max(0, newY);

          setSize({ width: newW, height: newH });
          setPosition({ x: newX, y: newY });
        };

        const onMouseUp = () => {
          isInteracting.current = false;
          showBrowserView();
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        return;
      }

      // Toolbar drag (y < toolbar height, not on interactive elements)
      if (relY < TOOLBAR_HEIGHT) {
        e.preventDefault();
        isInteracting.current = true;
        hideBrowserView();
        dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        const onMouseMove = (ev: MouseEvent) => {
          setPosition({
            x: ev.clientX - dragOffset.current.x,
            y: ev.clientY - dragOffset.current.y,
          });
        };

        const onMouseUp = () => {
          isInteracting.current = false;
          showBrowserView();
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      }
    },
    [size, position, hideBrowserView, showBrowserView]
  );

  // When mouse enters the toolbar area, hide BrowserView so edge/corner detection works.
  // When mouse moves to the content area, show it again.
  const handleContainerMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isInteracting.current) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, button, a, [contenteditable]')) {
        (e.currentTarget as HTMLElement).style.cursor = '';
        return;
      }

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;

      // Hide BrowserView when in toolbar (so we can detect edge clicks)
      if (relY < TOOLBAR_HEIGHT) {
        hideBrowserView();
      } else {
        showBrowserView();
      }

      // Update cursor based on position
      const nearLeft = relX < EDGE_ZONE;
      const nearRight = relX > w - EDGE_ZONE;
      const nearTop = relY < EDGE_ZONE;
      const nearBottom = relY > h - EDGE_ZONE;

      let dir = '';
      if (nearTop) dir += 'n';
      if (nearBottom) dir += 's';
      if (nearLeft) dir += 'w';
      if (nearRight) dir += 'e';

      if (dir) {
        (e.currentTarget as HTMLElement).style.cursor = CURSOR_MAP[dir as ResizeDir];
      } else if (relY < TOOLBAR_HEIGHT) {
        (e.currentTarget as HTMLElement).style.cursor = 'move';
      } else {
        (e.currentTarget as HTMLElement).style.cursor = '';
      }
    },
    [hideBrowserView, showBrowserView]
  );

  // Show BrowserView when mouse leaves the container entirely
  const handleContainerMouseLeave = useCallback(() => {
    if (!isInteracting.current) {
      showBrowserView();
    }
  }, [showBrowserView]);

  if (!miniBrowserOpen) return null;

  // Style helper for visual edge indicator zones
  const edgeStyle = (dir: ResizeDir): React.CSSProperties => {
    const s: React.CSSProperties = { position: 'absolute', pointerEvents: 'none' };
    const half = EDGE_ZONE / 2;
    switch (dir) {
      case 'n':  return { ...s, top: -half, left: 0, right: 0, height: EDGE_ZONE };
      case 's':  return { ...s, bottom: -half, left: 0, right: 0, height: EDGE_ZONE };
      case 'w':  return { ...s, top: 0, left: -half, bottom: 0, width: EDGE_ZONE };
      case 'e':  return { ...s, top: 0, right: -half, bottom: 0, width: EDGE_ZONE };
      case 'nw': return { ...s, top: -half, left: -half, width: EDGE_ZONE * 2, height: EDGE_ZONE * 2 };
      case 'ne': return { ...s, top: -half, right: -half, width: EDGE_ZONE * 2, height: EDGE_ZONE * 2 };
      case 'sw': return { ...s, bottom: -half, left: -half, width: EDGE_ZONE * 2, height: EDGE_ZONE * 2 };
      case 'se': return { ...s, bottom: -half, right: -half, width: EDGE_ZONE * 2, height: EDGE_ZONE * 2 };
    }
    return s;
  };

  const directions: ResizeDir[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

  return (
    <div
      onMouseDown={handleContainerMouseDown}
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={handleContainerMouseLeave}
      className="fixed z-50 flex flex-col rounded-lg border border-border/60 bg-background shadow-2xl"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 h-9 px-2 bg-[#111] border-b border-border/30 flex-shrink-0">
        <button
          onClick={handleBack}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleForward}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Forward"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter URL..."
          className="flex-1 h-6 px-2 rounded bg-[#1a1a1a] border border-border/40 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
        />

        <button
          onClick={handleNavigate}
          className="inline-flex items-center justify-center h-6 px-2 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Go"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={handleClose}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/20 transition-colors ml-1"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* BrowserView content area */}
      <div className="flex-1 bg-transparent" />

      {/* Visual edge indicators */}
      {directions.map((dir) => (
        <div key={dir} style={edgeStyle(dir)} />
      ))}
    </div>
  );
};
