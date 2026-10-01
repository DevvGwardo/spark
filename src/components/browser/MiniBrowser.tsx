import React, { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { Globe, ArrowLeft, ArrowRight, X, ExternalLink, PanelRight, ChevronRight, RotateCw, CornerDownLeft, Search, ChevronUp, ChevronDown } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { rafThrottle } from '@/lib/raf';
import { openExternalUrl } from '@/lib/open-external';
import type { ElectronAPI } from '@/electron';
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
const FIND_BAR_HEIGHT = 34; // second toolbar row, only when find is open
const EDGE_ZONE = 14; // px from edge to trigger resize

function normalizeBrowserUrl(raw: string): string | null {
  let url = raw.trim();
  if (!url) return null;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://${url}`;
  }
  return url;
}

/** Shared chrome state for docked + floating toolbars. */
function useMiniBrowserChrome() {
  const miniBrowserOpen = useUIStore((s) => s.miniBrowserOpen);
  const miniBrowserUrl = useUIStore((s) => s.miniBrowserUrl);
  const setMiniBrowserUrl = useUIStore((s) => s.setMiniBrowserUrl);
  const setMiniBrowserOpen = useUIStore((s) => s.setMiniBrowserOpen);
  const setMiniBrowserDocked = useUIStore((s) => s.setMiniBrowserDocked);

  const [urlInput, setUrlInput] = useState('');
  const [urlFocused, setUrlFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  // In-page find (⌘F). Mirrors Claude Desktop's dedicated find_in_page surface:
  // the renderer owns query/UI, the BrowserView reports match counts.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState(0);
  const [findActiveMatch, setFindActiveMatch] = useState(0);

  useEffect(() => {
    if (!urlFocused && miniBrowserUrl && miniBrowserUrl !== 'about:blank') {
      setUrlInput(miniBrowserUrl);
    }
  }, [miniBrowserUrl, urlFocused]);

  useEffect(() => {
    const api = window.electronAPI?.browser;
    if (!api) return;

    const unsubs = [
      api.onLoading?.((isLoading) => setLoading(isLoading)),
      api.onNavState?.((state) => {
        setCanGoBack(state.canGoBack);
        setCanGoForward(state.canGoForward);
      }),
      api.onFailLoad?.(({ errorDescription }) => {
        setLoadError(errorDescription || 'Failed to load page');
        setLoading(false);
      }),
      api.onNavigated?.(() => setLoadError(null)),
      api.onFoundInPage?.((result) => {
        setFindMatches(result.matches);
        setFindActiveMatch(result.activeMatchOrdinal);
      }),
    ];

    return () => {
      for (const unsub of unsubs) unsub?.();
    };
  }, []);

  const handleNavigate = useCallback(() => {
    const url = normalizeBrowserUrl(urlInput);
    if (!url) return;
    setUrlInput(url);
    setLoadError(null);
    setMiniBrowserUrl(url);
  }, [urlInput, setMiniBrowserUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleNavigate();
    },
    [handleNavigate],
  );

  const handleBack = useCallback(() => {
    void window.electronAPI?.browser?.goBack();
  }, []);

  const handleForward = useCallback(() => {
    void window.electronAPI?.browser?.goForward();
  }, []);

  const handleReload = useCallback(() => {
    setLoadError(null);
    void window.electronAPI?.browser?.reload();
  }, []);

  const handleOpenExternal = useCallback(() => {
    const url = normalizeBrowserUrl(urlInput) || (miniBrowserUrl !== 'about:blank' ? miniBrowserUrl : null);
    if (url) openExternalUrl(url);
  }, [urlInput, miniBrowserUrl]);

  const handleClose = useCallback(() => {
    setMiniBrowserOpen(false);
    setMiniBrowserDocked(false);
  }, [setMiniBrowserOpen, setMiniBrowserDocked]);

  const handleToggleDock = useCallback(() => {
    const { miniBrowserDocked: docked } = useUIStore.getState();
    setMiniBrowserDocked(!docked);
  }, [setMiniBrowserDocked]);

  const runFind = useCallback((text: string, forward = true) => {
    const api = window.electronAPI?.browser;
    if (!api?.findInPage) return;
    if (!text) {
      setFindMatches(0);
      setFindActiveMatch(0);
      void api.stopFindInPage?.('clearSelection');
      return;
    }
    // Always findNext:true. Electron 44 emits NO found-in-page result for
    // findNext:false, so counts would never reach the bar. With findNext:true
    // Chromium restarts at match 1 for a changed query and advances for a
    // repeated one — both behaviours we want.
    void api.findInPage(text, { forward, findNext: true });
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    // Re-run the existing query so the bar reflects the current page immediately.
    if (findQuery) runFind(findQuery, true);
  }, [findQuery, runFind]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindMatches(0);
    setFindActiveMatch(0);
    void window.electronAPI?.browser?.stopFindInPage?.('clearSelection');
  }, []);

  const handleFindQueryChange = useCallback(
    (value: string) => {
      setFindQuery(value);
      runFind(value, true);
    },
    [runFind],
  );

  const findNext = useCallback(() => runFind(findQuery, true), [findQuery, runFind]);
  const findPrev = useCallback(() => runFind(findQuery, false), [findQuery, runFind]);

  // ⌘F / Ctrl+F opens find — but only while the mini browser is open, so we
  // never hijack ⌘F from the rest of the app. Escape is handled by the find
  // input itself so it doesn't swallow Escape from other panels.
  useEffect(() => {
    if (!miniBrowserOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'f') return;
      e.preventDefault();
      openFind();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [miniBrowserOpen, openFind]);

  return {
    urlInput,
    setUrlInput,
    urlFocused,
    setUrlFocused,
    loading,
    loadError,
    canGoBack,
    canGoForward,
    handleNavigate,
    handleKeyDown,
    handleBack,
    handleForward,
    handleReload,
    handleOpenExternal,
    handleClose,
    handleToggleDock,
    findOpen,
    findQuery,
    findMatches,
    findActiveMatch,
    openFind,
    closeFind,
    handleFindQueryChange,
    findNext,
    findPrev,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HermesPTYPanel — real terminal that spawns the hermes CLI via node-pty.
// Used in AppLayout when the user toggles "Open Hermes".
// Exposes zoom controls via ref so UI buttons can drive font size.
// ─────────────────────────────────────────────────────────────────────────────
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 20;
const DEFAULT_FONT_SIZE = 12;
type TerminalApi = NonNullable<ElectronAPI['terminal']>;

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
    const apiRef = useRef<TerminalApi | null>(null);
    const fitFrameRef = useRef<ReturnType<typeof rafThrottle<[]>> | null>(null);
    const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

    // Helper: fit xterm and notify PTY of new cols/rows
    const fitAndResizeNow = useCallback(() => {
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

    const fitAndResize = useCallback(() => {
      if (!fitFrameRef.current) {
        fitFrameRef.current = rafThrottle(fitAndResizeNow);
      }
      fitFrameRef.current();
    }, [fitAndResizeNow]);

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
        fontFamily: '"Geist Mono Variable", "Geist Mono", "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Menlo, monospace',
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
            api?.kill(ptyIdRef.current);
            ptyIdRef.current = null;
          }
        };
      }).catch((err: unknown) => {
        term.writeln(`\x1b[31mFailed to spawn hermes: ${err}\x1b[0m`);
      });

      return () => {
        fitFrameRef.current?.cancel();
        try { term.dispose(); } catch { /* ignore */ }
        const id = ptyIdRef.current;
        if (id) {
          window.electronAPI?.terminal?.kill(id);
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
  const { miniBrowserOpen, setMiniBrowserOpen, setMiniBrowserDocked, setMiniBrowserUrl, setRightSidebarHidden } = useUIStore();

  const handleToggle = useCallback(() => {
    if (miniBrowserOpen) {
      setMiniBrowserOpen(false);
      setMiniBrowserDocked(false);
    } else {
      setMiniBrowserUrl('about:blank');
      setMiniBrowserDocked(true);
      setMiniBrowserOpen(true);
      setRightSidebarHidden(false);
    }
  }, [miniBrowserOpen, setMiniBrowserOpen, setMiniBrowserDocked, setMiniBrowserUrl, setRightSidebarHidden]);

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
  onReload: () => void;
  onOpenExternal: () => void;
  onToggleDock: () => void;
  onClose: () => void;
  onUrlInputMouseDown?: (e: React.MouseEvent) => void;
  onUrlInputFocus?: () => void;
  onUrlInputBlur?: () => void;
  miniBrowserDocked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  loadError: string | null;
  findOpen: boolean;
  findQuery: string;
  findMatches: number;
  findActiveMatch: number;
  onFindQueryChange: (v: string) => void;
  onFindOpen: () => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onFindClose: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({
  urlInput, onUrlChange, onNavigate, onKeyDown,
  onBack, onForward, onReload, onOpenExternal, onToggleDock, onClose,
  onUrlInputMouseDown, onUrlInputFocus, onUrlInputBlur,
  miniBrowserDocked, canGoBack, canGoForward, loading, loadError,
  findOpen, findQuery, findMatches, findActiveMatch,
  onFindQueryChange, onFindOpen, onFindNext, onFindPrev, onFindClose,
}) => (
  <div className="flex flex-col flex-shrink-0 bg-[#111] border-b border-border/30">
    <div className="flex items-center gap-1 h-9 px-1.5">
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
        title="Back"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
        title="Forward"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onReload}
        onMouseDown={(e) => e.preventDefault()}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title="Reload"
      >
        <RotateCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
      </button>

      <div className="relative flex-1 min-w-0">
        <input
          type="text"
          value={urlInput}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={onKeyDown}
          onMouseDown={onUrlInputMouseDown}
          onFocus={onUrlInputFocus}
          onBlur={onUrlInputBlur}
          placeholder="Enter URL..."
          className="w-full h-6 px-2 rounded bg-[#1a1a1a] border border-border/40 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 font-mono"
        />
        {loading && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-px bg-primary/40 overflow-hidden">
            <div className="h-full w-full origin-left animate-pulse bg-primary/80" />
          </div>
        )}
      </div>

      <button
        onClick={onNavigate}
        onMouseDown={(e) => e.preventDefault()}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title="Go"
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={onOpenExternal}
        onMouseDown={(e) => e.preventDefault()}
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        title="Open in system browser"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={findOpen ? onFindClose : onFindOpen}
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          'inline-flex items-center justify-center h-6 w-6 rounded transition-colors ml-0.5',
          findOpen
            ? 'text-primary bg-primary/10 hover:bg-primary/20'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        title={findOpen ? 'Close find (Esc)' : 'Find in page (⌘F)'}
      >
        <Search className="h-3.5 w-3.5" />
      </button>

      <button
        onClick={onToggleDock}
        onMouseDown={(e) => e.preventDefault()}
        className={cn(
          'inline-flex items-center justify-center h-6 w-6 rounded transition-colors ml-0.5',
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
        className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/20 transition-colors"
        title="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
    {findOpen && (
      <div className="flex items-center gap-1 h-[34px] px-1.5 border-t border-border/30">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          type="text"
          value={findQuery}
          onChange={(e) => onFindQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onFindClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) onFindPrev();
              else onFindNext();
            }
          }}
          placeholder="Find in page..."
          className="flex-1 min-w-0 h-6 px-2 rounded bg-[#1a1a1a] border border-border/40 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40"
        />
        <span className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground">
          {findQuery ? `${findActiveMatch}/${findMatches}` : '0/0'}
        </span>
        <button
          type="button"
          onClick={onFindPrev}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!findQuery || findMatches === 0}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Previous match (⇧Enter)"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onFindNext}
          onMouseDown={(e) => e.preventDefault()}
          disabled={!findQuery || findMatches === 0}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="Next match (Enter)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onFindClose}
          onMouseDown={(e) => e.preventDefault()}
          className="inline-flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Close find (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )}
    {loadError && (
      <div className="flex items-center gap-2 px-2 pb-1.5 text-[10px] text-red-400/90">
        <span className="truncate flex-1">{loadError}</span>
        <button
          type="button"
          onClick={onReload}
          className="shrink-0 underline hover:text-red-300"
        >
          Retry
        </button>
      </div>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// DockedMiniBrowser — rendered by AppLayout as a flex child (NOT position:fixed).
// Uses ResizeObserver to track actual DOM bounds and sync BrowserView overlay.
// ─────────────────────────────────────────────────────────────────────────────
export const DockedMiniBrowser: React.FC = () => {
  const {
    miniBrowserOpen,
    miniBrowserDocked,
    miniBrowserDockedWidth, setMiniBrowserDockedWidth,
    rightSidebarHidden, setRightSidebarHidden,
  } = useUIStore();

  const chrome = useMiniBrowserChrome();
  const browserViewHidden = useRef(false);
  const dockedResizeRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dockedResizeFrame = useRef<ReturnType<typeof rafThrottle<[number]>> | null>(null);
  const boundsFrame = useRef<ReturnType<typeof rafThrottle<[]>> | null>(null);
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // Sync BrowserView bounds whenever container size/position changes
  useEffect(() => {
    if (!miniBrowserOpen || !miniBrowserDocked) return;

    const container = containerRef.current;
    if (!container) return;

    const updateBoundsNow = () => {
      const rect = container.getBoundingClientRect();
      const toolbarH = container.querySelector('[data-mini-browser-toolbar]')?.getBoundingClientRect().height ?? TOOLBAR_HEIGHT;
      const nextBounds = rightSidebarHidden
        ? {
            x: -9999,
            y: Math.round(rect.top + toolbarH),
            width: 1,
            height: 1,
          }
        : {
            x: Math.round(rect.left),
            y: Math.round(rect.top + toolbarH),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height - toolbarH)),
          };
      const lastBounds = lastBoundsRef.current;
      if (
        lastBounds &&
        lastBounds.x === nextBounds.x &&
        lastBounds.y === nextBounds.y &&
        lastBounds.width === nextBounds.width &&
        lastBounds.height === nextBounds.height
      ) {
        return;
      }
      lastBoundsRef.current = nextBounds;
      window.electronAPI?.browser?.resize(nextBounds);
    };

    boundsFrame.current?.cancel();
    boundsFrame.current = rafThrottle(updateBoundsNow);
    const updateBounds = () => boundsFrame.current?.();

    updateBounds();

    const ro = new ResizeObserver(updateBounds);
    ro.observe(container);

    window.addEventListener('resize', updateBounds, { passive: true });
    window.addEventListener('enter-html-full-screen', updateBounds);
    window.addEventListener('leave-html-full-screen', updateBounds);

    const removeForceResize = window.electronAPI?.browser?.onForceResize?.(updateBounds);

    return () => {
      boundsFrame.current?.cancel();
      ro.disconnect();
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('enter-html-full-screen', updateBounds);
      window.removeEventListener('leave-html-full-screen', updateBounds);
      removeForceResize?.();
    };
  }, [miniBrowserOpen, miniBrowserDocked, rightSidebarHidden, chrome.loadError, chrome.findOpen]);

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

  const handleHideSidebar = useCallback(() => setRightSidebarHidden(true), [setRightSidebarHidden]);

  const handleDockedResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dockedResizeRef.current = true;
      document.body.classList.add('resize-performance-lock');
      dockedResizeFrame.current?.cancel();
      dockedResizeFrame.current = rafThrottle((nextWidth: number) => {
        setMiniBrowserDockedWidth(nextWidth);
      });
      const startX = e.clientX;
      const startWidth = miniBrowserDockedWidth;
      if (rightSidebarHidden) {
        setRightSidebarHidden(false);
      }
      hideBrowserView();

      const onMouseMove = (ev: MouseEvent) => {
        if (!dockedResizeRef.current) return;
        dockedResizeFrame.current?.(startWidth - (ev.clientX - startX));
      };

      const onMouseUp = () => {
        dockedResizeRef.current = false;
        dockedResizeFrame.current?.flush();
        dockedResizeFrame.current = null;
        showBrowserView();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.classList.remove('resize-performance-lock');
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
      className="app-independent-pane relative flex flex-col h-full border-l border-border/60 bg-background flex-shrink-0 transition-none"
      style={{
        width: rightSidebarHidden ? 0 : miniBrowserDockedWidth,
        overflow: 'hidden',
        minWidth: rightSidebarHidden ? 0 : miniBrowserDockedWidth,
      }}
    >
      <div
        onMouseDown={handleDockedResizeStart}
        className="absolute top-0 -left-1.5 z-10 h-full w-3 cursor-col-resize group"
      >
        <div className="absolute inset-y-6 bottom-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/25 transition-colors group-hover:bg-foreground/25 group-active:bg-foreground/40" />
      </div>

      <div className="flex items-stretch flex-shrink-0" data-mini-browser-toolbar>
        {!rightSidebarHidden && (
          <button
            onClick={handleHideSidebar}
            onMouseDown={(e) => e.stopPropagation()}
            className="inline-flex items-center justify-center h-9 w-7 shrink-0 bg-[#111] border-b border-border/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="Hide browser (keeps video playing)"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <Toolbar
            urlInput={chrome.urlInput}
            onUrlChange={chrome.setUrlInput}
            onNavigate={chrome.handleNavigate}
            onKeyDown={chrome.handleKeyDown}
            onBack={chrome.handleBack}
            onForward={chrome.handleForward}
            onReload={chrome.handleReload}
            onOpenExternal={chrome.handleOpenExternal}
            onToggleDock={chrome.handleToggleDock}
            onClose={chrome.handleClose}
            onUrlInputFocus={() => chrome.setUrlFocused(true)}
            onUrlInputBlur={() => chrome.setUrlFocused(false)}
            miniBrowserDocked={miniBrowserDocked}
            canGoBack={chrome.canGoBack}
            canGoForward={chrome.canGoForward}
            loading={chrome.loading}
            loadError={chrome.loadError}
            findOpen={chrome.findOpen}
            findQuery={chrome.findQuery}
            findMatches={chrome.findMatches}
            findActiveMatch={chrome.findActiveMatch}
            onFindQueryChange={chrome.handleFindQueryChange}
            onFindOpen={chrome.openFind}
            onFindNext={chrome.findNext}
            onFindPrev={chrome.findPrev}
            onFindClose={chrome.closeFind}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-transparent" />
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MiniBrowser — floating overlay. Docked mode is handled by DockedMiniBrowser.
// ─────────────────────────────────────────────────────────────────────────────
export const MiniBrowser: React.FC = () => {
  const { miniBrowserOpen, miniBrowserDocked } = useUIStore();
  const chrome = useMiniBrowserChrome();

  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ width: 600, height: 400 });
  const isInteracting = useRef(false);
  const browserViewHidden = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const floatingFrame = useRef<ReturnType<typeof rafThrottle<[{ x: number; y: number }, { width: number; height: number }]>> | null>(null);
  const floatingBoundsFrame = useRef<ReturnType<typeof rafThrottle<[]>> | null>(null);
  const lastFloatingBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const clampPosition = useCallback((pos: { x: number; y: number }, sz: { width: number; height: number }) => {
    const maxX = Math.max(0, window.innerWidth - sz.width);
    const maxY = Math.max(0, window.innerHeight - sz.height);
    return {
      x: Math.max(0, Math.min(pos.x, maxX)),
      y: Math.max(0, Math.min(pos.y, maxY)),
    };
  }, []);

  // Position bottom-right when opening floating / undocking
  useEffect(() => {
    if (miniBrowserOpen && !miniBrowserDocked) {
      const sz = sizeRef.current;
      setPosition(clampPosition(
        { x: window.innerWidth - sz.width - 20, y: window.innerHeight - sz.height - 60 },
        sz,
      ));
    }
  }, [miniBrowserOpen, miniBrowserDocked, clampPosition]);

  // Update BrowserView bounds when position/size changes (floating mode)
  useEffect(() => {
    if (!miniBrowserOpen || miniBrowserDocked) return;

    const updateBoundsNow = () => {
      const toolbarExtra = (chrome.loadError ? 18 : 0) + (chrome.findOpen ? FIND_BAR_HEIGHT : 0);
      const nextBounds = {
        x: Math.round(position.x),
        y: Math.round(position.y + TOOLBAR_HEIGHT + toolbarExtra),
        width: Math.max(1, Math.round(size.width)),
        height: Math.max(1, Math.round(size.height - TOOLBAR_HEIGHT - toolbarExtra)),
      };
      const lastBounds = lastFloatingBoundsRef.current;
      if (
        lastBounds &&
        lastBounds.x === nextBounds.x &&
        lastBounds.y === nextBounds.y &&
        lastBounds.width === nextBounds.width &&
        lastBounds.height === nextBounds.height
      ) {
        return;
      }
      lastFloatingBoundsRef.current = nextBounds;
      window.electronAPI?.browser?.resize(nextBounds);
    };

    floatingBoundsFrame.current?.cancel();
    floatingBoundsFrame.current = rafThrottle(updateBoundsNow);
    floatingBoundsFrame.current();

    const onWindowResize = () => {
      setPosition((prev) => clampPosition(prev, sizeRef.current));
      floatingBoundsFrame.current?.();
    };

    window.addEventListener('resize', onWindowResize, { passive: true });
    window.addEventListener('enter-html-full-screen', onWindowResize);
    window.addEventListener('leave-html-full-screen', onWindowResize);
    const removeForceResize = window.electronAPI?.browser?.onForceResize?.(onWindowResize);

    return () => {
      floatingBoundsFrame.current?.cancel();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('enter-html-full-screen', onWindowResize);
      window.removeEventListener('leave-html-full-screen', onWindowResize);
      removeForceResize?.();
    };
  }, [miniBrowserOpen, miniBrowserDocked, position, size, chrome.loadError, chrome.findOpen, clampPosition]);

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

  useEffect(() => {
    return () => {
      floatingFrame.current?.cancel();
      floatingBoundsFrame.current?.cancel();
      if (browserViewHidden.current) {
        window.electronAPI?.browser?.show();
      }
    };
  }, []);

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
        e.preventDefault();
        isInteracting.current = true;
        document.body.classList.add('resize-performance-lock');
        floatingFrame.current?.cancel();
        floatingFrame.current = rafThrottle((nextPosition, nextSize) => {
          setPosition(nextPosition);
          setSize(nextSize);
        });
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

          floatingFrame.current?.({ x: newX, y: newY }, { width: newW, height: newH });
        };

        const onMouseUp = () => {
          isInteracting.current = false;
          floatingFrame.current?.flush();
          floatingFrame.current = null;
          showBrowserView();
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.body.classList.remove('resize-performance-lock');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        return;
      }

      if (relY < TOOLBAR_HEIGHT) {
        e.preventDefault();
        isInteracting.current = true;
        document.body.classList.add('resize-performance-lock');
        floatingFrame.current?.cancel();
        floatingFrame.current = rafThrottle((nextPosition, nextSize) => {
          setPosition(nextPosition);
          setSize(nextSize);
        });
        hideBrowserView();
        dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        const onMouseMove = (ev: MouseEvent) => {
          floatingFrame.current?.(
            clampPosition(
              {
                x: ev.clientX - dragOffset.current.x,
                y: ev.clientY - dragOffset.current.y,
              },
              size,
            ),
            size,
          );
        };

        const onMouseUp = () => {
          isInteracting.current = false;
          floatingFrame.current?.flush();
          floatingFrame.current = null;
          showBrowserView();
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          document.body.classList.remove('resize-performance-lock');
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      }
    },
    [size, position, hideBrowserView, showBrowserView, clampPosition]
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
  if (miniBrowserDocked) return null;

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
      className="app-independent-pane fixed z-50 flex flex-col rounded-lg border border-border/60 bg-background shadow-2xl"
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
      }}
    >
      <div data-mini-browser-toolbar>
        <Toolbar
          urlInput={chrome.urlInput}
          onUrlChange={chrome.setUrlInput}
          onNavigate={chrome.handleNavigate}
          onKeyDown={chrome.handleKeyDown}
          onBack={chrome.handleBack}
          onForward={chrome.handleForward}
          onReload={chrome.handleReload}
          onOpenExternal={chrome.handleOpenExternal}
          onToggleDock={chrome.handleToggleDock}
          onClose={chrome.handleClose}
          onUrlInputMouseDown={(e) => { e.stopPropagation(); hideBrowserView(); }}
          onUrlInputFocus={() => { chrome.setUrlFocused(true); hideBrowserView(); }}
          onUrlInputBlur={() => { chrome.setUrlFocused(false); showBrowserView(); }}
          miniBrowserDocked={miniBrowserDocked}
          canGoBack={chrome.canGoBack}
          canGoForward={chrome.canGoForward}
          loading={chrome.loading}
          loadError={chrome.loadError}
          findOpen={chrome.findOpen}
          findQuery={chrome.findQuery}
          findMatches={chrome.findMatches}
          findActiveMatch={chrome.findActiveMatch}
          onFindQueryChange={chrome.handleFindQueryChange}
          onFindOpen={chrome.openFind}
          onFindNext={chrome.findNext}
          onFindPrev={chrome.findPrev}
          onFindClose={chrome.closeFind}
        />
      </div>

      <div className="flex-1 bg-transparent" />

      {directions.map((dir) => (
        <div key={dir} style={edgeStyle(dir)} />
      ))}
    </div>
  );
};
