import React, { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Globe, ArrowLeft, ArrowRight, X, ExternalLink, PanelRight, Terminal, ChevronRight, Minus, Plus } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

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
const FOOTER_HEIGHT = 32;
const EDGE_ZONE = 14; // px from edge to trigger resize

// ─────────────────────────────────────────────────────────────────────────────
// HermesPTYPanel — real terminal that spawns the hermes CLI via node-pty.
// Used in AppLayout when the user toggles "Open Hermes".
// Exposes zoom controls via ref so UI buttons can drive font size.
// ─────────────────────────────────────────────────────────────────────────────
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 20;
const DEFAULT_FONT_SIZE = 12;

export interface HermesPTYPanelHandle {
  zoomIn: () => void;
  zoomOut: () => void;
}

export const HermesPTYPanel = forwardRef<HermesPTYPanelHandle, { maximized?: boolean }>(
  ({ maximized }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const ptyIdRef = useRef<string | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    // Store api in a ref so ResizeObserver and zoom handlers (which run outside the
    // spawn callback) can call api.resize() to notify the PTY of new dimensions.
    const apiRef = useRef<typeof window.electronAPI.terminal | null>(null);
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

    // Helper: fit xterm and notify PTY of new cols/rows
    const fitAndResize = useCallback(() => {
      const term = termRef.current;
      const fitAddon = fitAddonRef.current;
      const api = apiRef.current;
      const ptyId = ptyIdRef.current;
      if (!term || !fitAddon) return;
      try {
        fitAddon.fit();
        if (api && ptyId) {
          api.resize(ptyId, term.cols, term.rows);
        }
      } catch { /* ignore */ }
    }, []);

    // Expose zoom methods to parent via ref
    useImperativeHandle(ref, () => ({
      zoomIn: () => {
        setFontSize((prev) => {
          const next = Math.min(prev + 1, MAX_FONT_SIZE);
          if (termRef.current) {
            termRef.current.options.fontSize = next;
            fitAndResize();
          }
          return next;
        });
      },
      zoomOut: () => {
        setFontSize((prev) => {
          const next = Math.max(prev - 1, MIN_FONT_SIZE);
          if (termRef.current) {
            termRef.current.options.fontSize = next;
            fitAndResize();
          }
          return next;
        });
      },
    }), [fitAndResize]);

    useEffect(() => {
      if (!containerRef.current) return;
      const container = containerRef.current;

      const term = new XTerm({
        cursorBlink: true,
        fontSize,
        scrollback: 5000,
        fontFamily: '"Geist Mono", "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Menlo, monospace',
        lineHeight: 1.35,
        theme: {
          background: '#0a0a0a',
          foreground: '#e4e4e7',
          cursor: '#e4e4e7',
          cursorAccent: '#0a0a0a',
          selectionBackground: '#27272a',
          selectionForeground: '#fafafa',
          black: '#18181b',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#eab308',
          blue: '#3b82f6',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#e4e4e7',
          brightBlack: '#52525b',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#fafafa',
        },
      });
      const fitAddon = new FitAddon();
      termRef.current = term;
      fitAddonRef.current = fitAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(container);

      // Capture api in a ref so the ResizeObserver (set up below) can call
      // api.resize() even though it lives outside the spawn callback.
      apiRef.current = window.electronAPI?.terminal ?? null;
      const api = apiRef.current;
      if (!api) {
        term.writeln('\x1b[31mTerminal API not available.\x1b[0m');
        return;
      }

      // Spawn hermes CLI agent.
      api.spawn({ command: 'hermes' }).then((result: { id: string }) => {
        ptyIdRef.current = result.id;
        fitAddon.fit();
        term.focus();

        // Forward keystrokes → PTY
        const onDataDisposable = term.onData((data: string) => {
          api.write(result.id, data);
        });

        // Receive PTY output → xterm
        const removeDataListener = api.onData((id: string, data: string) => {
          if (id === result.id) term.write(data);
        });

        // Handle exit
        const removeExitListener = api.onExit((id: string, _exitCode: number) => {
          if (id === result.id) {
            term.writeln('\r\n\x1b[90m— hermes exited —\x1b[0m\r\n');
          }
        });

        // Re-fit + notify PTY on container size changes.
        // ResizeObserver catches flex layout shifts (sidebar width drag, maximize/restore).
        const resizeObserver = new ResizeObserver(() => {
          fitAndResize();
        });
        resizeObserver.observe(container);

        return () => {
          onDataDisposable.dispose();
          removeDataListener();
          removeExitListener();
          resizeObserver.disconnect();
          try { term.dispose(); } catch { /* ignore */ }
          if (ptyIdRef.current) {
            api.kill(ptyIdRef.current);
            ptyIdRef.current = null;
          }
        };
      }).catch((err: unknown) => {
        term.writeln(`\x1b[31mFailed to spawn hermes: ${err}\x1b[0m`);
      });

      return () => {
        try { term.dispose(); } catch { /* ignore */ }
        const id = ptyIdRef.current;
        if (id) {
          window.electronAPI?.terminal.kill(id);
          ptyIdRef.current = null;
        }
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-fit + notify PTY when maximized state or font size changes.
    // Also add a window resize listener as a safety net — ResizeObserver alone
    // can miss sidebar drag-resize events (same pattern used in DockedMiniBrowser).
    useEffect(() => {
      const timer = setTimeout(() => {
        fitAndResize();
      }, 80);
      window.addEventListener('resize', fitAndResize);
      return () => {
        clearTimeout(timer);
        window.removeEventListener('resize', fitAndResize);
      };
    }, [maximized, fontSize, fitAndResize]);

    return <div ref={containerRef} className="w-full h-full bg-[#0a0a0a]" />;
  }
);
HermesPTYPanel.displayName = 'HermesPTYPanel';

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

// ─────────────────────────────────────────────────────────────────────────────
// Shared toolbar rendered in both floating and docked modes
// ─────────────────────────────────────────────────────────────────────────────
interface ToolbarProps {
  urlInput: string;
  onUrlChange: (v: string) => void;
  onNavigate: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onBack: () => void;
  onForward: () => void;
  onToggleDock: () => void;
  onClose: () => void;
  onUrlInputMouseDown?: (e: React.MouseEvent) => void;
  onUrlInputFocus?: () => void;
  onUrlInputBlur?: () => void;
  isDocked: boolean;
  miniBrowserDocked: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({
  urlInput, onUrlChange, onNavigate, onKeyDown,
  onBack, onForward, onToggleDock, onClose,
  onUrlInputMouseDown, onUrlInputFocus, onUrlInputBlur,
  isDocked, miniBrowserDocked,
}) => (
  <div className="flex items-center gap-1.5 h-9 px-2 bg-[#111] border-b border-border/30 flex-shrink-0">
    <button
      onClick={onBack}
      className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title="Back"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
    </button>
    <button
      onClick={onForward}
      className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title="Forward"
    >
      <ArrowRight className="h-3.5 w-3.5" />
    </button>

    <input
      type="text"
      value={urlInput}
      onChange={(e) => onUrlChange(e.target.value)}
      onKeyDown={onKeyDown}
      onMouseDown={onUrlInputMouseDown}
      onFocus={onUrlInputFocus}
      onBlur={onUrlInputBlur}
      placeholder="Enter URL..."
      className="flex-1 h-6 px-2 rounded bg-[#1a1a1a] border border-border/40 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
    />

    <button
      onClick={onNavigate}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex items-center justify-center h-6 px-2 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      title="Go"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </button>

    <button
      onClick={onToggleDock}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'inline-flex items-center justify-center h-6 w-6 rounded transition-colors ml-1',
        miniBrowserDocked
          ? 'text-primary bg-primary/10 hover:bg-primary/20'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
      title={miniBrowserDocked ? 'Undock (floating)' : 'Dock to right sidebar'}
    >
      <PanelRight className="h-3.5 w-3.5" />
    </button>

    <button
      onClick={onClose}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/20 transition-colors ml-1"
      title="Close"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// DockedMiniBrowser — rendered by AppLayout as a flex child (NOT position:fixed).
// Uses ResizeObserver to track actual DOM bounds and sync BrowserView overlay.
// ─────────────────────────────────────────────────────────────────────────────
export const DockedMiniBrowser: React.FC = () => {
  const {
    miniBrowserOpen, setMiniBrowserOpen,
    miniBrowserUrl,
    miniBrowserDocked, setMiniBrowserDocked,
    miniBrowserDockedWidth, setMiniBrowserDockedWidth,
    rightSidebarHidden, setRightSidebarHidden,
  } = useUIStore();

  const [urlInput, setUrlInput] = useState('');

  const browserViewHidden = useRef(false);
  const dockedResizeRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Ref for measuring the Hermes panel height to shrink BrowserView bounds


  // Sync URL input with store
  useEffect(() => {
    if (miniBrowserUrl && miniBrowserUrl !== 'about:blank') {
      setUrlInput(miniBrowserUrl);
    }
  }, [miniBrowserUrl]);

  // Sync BrowserView bounds whenever container size/position changes
  useEffect(() => {
    if (!miniBrowserOpen || !miniBrowserDocked) return;

    const container = containerRef.current;
    if (!container) return;

    const updateBounds = () => {
      const rect = container.getBoundingClientRect();
      // When sidebar is hidden, move BrowserView off-screen so it keeps running
      // but doesn't intercept clicks
      if (rightSidebarHidden) {
        window.electronAPI?.browser?.resize({
          x: -9999,
          y: rect.top + TOOLBAR_HEIGHT,
          width: 1,
          height: 1,
        });
      } else {
        window.electronAPI?.browser?.resize({
          x: rect.left,
          y: rect.top + TOOLBAR_HEIGHT,
          width: rect.width,
          height: rect.height - TOOLBAR_HEIGHT - FOOTER_HEIGHT,
        });
      }
    };

    updateBounds();

    // ResizeObserver catches container size changes (flex layout shifts)
    const ro = new ResizeObserver(updateBounds);
    ro.observe(container);

    // window resize catches fullscreen enter/exit and window drag-resize.
    // ResizeObserver alone misses macOS fullscreen transitions because
    // the container's CSS dimensions may not change synchronously with the
    // window bounds during the transition.
    window.addEventListener('resize', updateBounds);
    window.addEventListener('enter-html-full-screen', updateBounds);
    window.addEventListener('leave-html-full-screen', updateBounds);

    // IPC from main process — fired when mainWindow enters/leaves fullscreen,
    // ensuring BrowserView bounds are recalculated even when the renderer
    // window events are not delivered in time.
    const removeForceResize = window.electronAPI?.browser?.onForceResize?.(updateBounds);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('enter-html-full-screen', updateBounds);
      window.removeEventListener('leave-html-full-screen', updateBounds);
      removeForceResize?.();
    };
  }, [miniBrowserOpen, miniBrowserDocked, rightSidebarHidden]);

  // Hide/show BrowserView — used during sidebar resize to prevent flickering.
  // In docked mode, BrowserView bounds are set below the toolbar so it's always
  // visible; no mousemove-based hide/show is needed.
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
    window.electronAPI?.browser?.navigate(url);
  }, [urlInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleNavigate(); },
    [handleNavigate]
  );

  const handleBack = useCallback(() => window.electronAPI?.browser?.goBack(), []);
  const handleForward = useCallback(() => window.electronAPI?.browser?.goForward(), []);
  const handleClose = useCallback(() => {
    window.electronAPI?.browser?.close();
    setMiniBrowserOpen(false);
    setMiniBrowserDocked(false);
  }, [setMiniBrowserOpen, setMiniBrowserDocked]);
  const handleToggleDock = useCallback(() => setMiniBrowserDocked(false), [setMiniBrowserDocked]);
  const handleHideSidebar = useCallback(() => setRightSidebarHidden(true), [setRightSidebarHidden]);

  // Docked sidebar resize
  const handleDockedResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dockedResizeRef.current = true;
      const startX = e.clientX;
      const startWidth = miniBrowserDockedWidth;
      // If sidebar is hidden, show it immediately so drag works visually
      if (rightSidebarHidden) {
        setRightSidebarHidden(false);
      }
      hideBrowserView();

      const onMouseMove = (ev: MouseEvent) => {
        if (!dockedResizeRef.current) return;
        setMiniBrowserDockedWidth(startWidth - (ev.clientX - startX));
      };

      const onMouseUp = () => {
        dockedResizeRef.current = false;
        showBrowserView();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [miniBrowserDockedWidth, setMiniBrowserDockedWidth, hideBrowserView, showBrowserView, rightSidebarHidden, setRightSidebarHidden]
  );

  if (!miniBrowserOpen || !miniBrowserDocked) return null;

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full border-l border-border/60 bg-background flex-shrink-0 transition-none"
      style={{
        width: rightSidebarHidden ? 0 : miniBrowserDockedWidth,
        overflow: 'hidden',
        minWidth: rightSidebarHidden ? 0 : miniBrowserDockedWidth,
      }}
    >
      {/* Resize handle on left edge */}
      <div
        onMouseDown={handleDockedResizeStart}
        className="absolute top-0 -left-1.5 z-10 h-full w-3 cursor-col-resize group"
      >
        <div className="absolute inset-y-6 bottom-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/25 transition-colors group-hover:bg-foreground/25 group-active:bg-foreground/40" />
      </div>

      {/* Toolbar area — always rendered to keep BrowserView bounds correct */}
      <div className="flex items-center flex-shrink-0 h-9 bg-[#111] border-b border-border/30">
        {/* Collapse sidebar button — only visible when not hidden */}
        {!rightSidebarHidden && (
          <button
            onClick={handleHideSidebar}
            onMouseDown={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ml-1"
            title="Hide browser (keeps video playing)"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
        <Toolbar
          urlInput={urlInput}
          onUrlChange={setUrlInput}
          onNavigate={handleNavigate}
          onKeyDown={handleKeyDown}
          onBack={handleBack}
          onForward={handleForward}
          onToggleDock={handleToggleDock}
          onClose={handleClose}
          isDocked={true}
          miniBrowserDocked={miniBrowserDocked}
        />
      </div>

      <div className="flex-[2] min-h-0 bg-transparent" />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MiniBrowser — rendered by AppLayout. In docked mode returns null because
// DockedMiniBrowser is responsible for the flex layout rendering.
// ─────────────────────────────────────────────────────────────────────────────
export const MiniBrowser: React.FC = () => {
  const {
    miniBrowserOpen, setMiniBrowserOpen,
    miniBrowserUrl, setMiniBrowserUrl,
    miniBrowserDocked,
  } = useUIStore();

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

  // Position in bottom-right by default (floating only)
  useEffect(() => {
    if (miniBrowserOpen && !miniBrowserDocked) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setPosition({ x: w - size.width - 20, y: h - size.height - 60 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniBrowserOpen]);

  // Update BrowserView bounds when position/size changes (floating mode)
  useEffect(() => {
    if (miniBrowserOpen && !miniBrowserDocked) {
      window.electronAPI?.browser?.resize({
        x: position.x,
        y: position.y + TOOLBAR_HEIGHT,
        width: size.width,
        height: size.height - TOOLBAR_HEIGHT,
      });
    }
  }, [miniBrowserOpen, miniBrowserDocked, position, size]);

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

  // Cleanup: show BrowserView when component unmounts
  useEffect(() => {
    return () => {
      if (browserViewHidden.current) {
        window.electronAPI?.browser?.show();
      }
    };
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
    (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleNavigate(); },
    [handleNavigate]
  );

  const handleBack = useCallback(() => window.electronAPI?.browser?.goBack(), []);
  const handleForward = useCallback(() => window.electronAPI?.browser?.goForward(), []);
  const handleClose = useCallback(() => {
    window.electronAPI?.browser?.close();
    setMiniBrowserOpen(false);
  }, [setMiniBrowserOpen]);
  const handleToggleDock = useCallback(() => {
    const { miniBrowserDocked: docked, setMiniBrowserDocked } = useUIStore.getState();
    setMiniBrowserDocked(!docked);
  }, []);

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
    []
  );

  const handleContainerMouseLeave = useCallback(() => {
    if (!isInteracting.current) showBrowserView();
  }, [showBrowserView]);

  if (!miniBrowserOpen) return null;

  // Docked mode: handled by DockedMiniBrowser component in AppLayout
  if (miniBrowserDocked) return null;

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

  // Floating mode
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
      <Toolbar
        urlInput={urlInput}
        onUrlChange={setUrlInput}
        onNavigate={handleNavigate}
        onKeyDown={handleKeyDown}
        onBack={handleBack}
        onForward={handleForward}
        onToggleDock={handleToggleDock}
        onClose={handleClose}
        onUrlInputMouseDown={(e) => { e.stopPropagation(); hideBrowserView(); }}
        onUrlInputFocus={hideBrowserView}
        onUrlInputBlur={showBrowserView}
        isDocked={false}
        miniBrowserDocked={miniBrowserDocked}
      />

      {/* BrowserView content area */}
      <div className="flex-1 bg-transparent" />

      {/* Visual edge indicators */}
      {directions.map((dir) => (
        <div key={dir} style={edgeStyle(dir)} />
      ))}
    </div>
  );
};
