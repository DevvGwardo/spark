import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useUIStore } from '@/stores/ui-store';
import { X, Plus, Minus, ChevronDown, ChevronUp, Terminal as TerminalIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rafThrottle } from '@/lib/raf';

interface TabInfo {
  id: string;
  ptyId: string;
  label: string;
}

interface TabInstance {
  xterm: Terminal;
  fitAddon: FitAddon;
  containerEl: HTMLDivElement;
  cleanup: () => void;
}

let tabCounter = 0;

export const TerminalPanel: React.FC<{ cwd?: string }> = ({ cwd }) => {
  const { terminalOpen, setTerminalOpen, terminalHeight, setTerminalHeight } = useUIStore();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Map<string, TabInstance>>(new Map());
  const isResizing = useRef(false);
  const heightFrame = useRef<ReturnType<typeof rafThrottle<[number]>> | null>(null);
  const fitFrame = useRef<ReturnType<typeof rafThrottle<[]>> | null>(null);

  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const prevHeight = useRef(terminalHeight);

  const api = window.electronAPI?.terminal;

  const createTab = useCallback(async () => {
    if (!api || !wrapperRef.current) return;

    setSpawnError(null);

    let ptyId: string;
    try {
      const result = await api.spawn(cwd);
      ptyId = result.id;
    } catch (err) {
      console.error('Failed to spawn terminal:', err);
      setSpawnError(String(err));
      return;
    }

    const tabId = `tab-${++tabCounter}`;

    // Create a dedicated container div for this tab's xterm
    const containerEl = document.createElement('div');
    containerEl.style.cssText = 'width:100%;height:100%;display:none;';
    wrapperRef.current.appendChild(containerEl);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Geist Mono", "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Menlo, monospace',
      lineHeight: 1.35,
      letterSpacing: 0,
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
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Open xterm into its dedicated container
    term.open(containerEl);

    // Forward keystrokes to PTY
    const onDataDisposable = term.onData((data) => {
      api.write(ptyId, data);
    });

    // Receive PTY output
    const removeDataListener = api.onData((id, data) => {
      if (id === ptyId) term.write(data);
    });

    // Handle process exit
    const removeExitListener = api.onExit((id, _exitCode) => {
      if (id === ptyId) {
        term.write('\r\n\x1b[90m— process exited —\x1b[0m\r\n');
      }
    });

    const cleanup = () => {
      onDataDisposable.dispose();
      removeDataListener();
      removeExitListener();
      term.dispose();
      containerEl.remove();
    };

    instancesRef.current.set(tabId, { xterm: term, fitAddon, containerEl, cleanup });

    const tabInfo: TabInfo = { id: tabId, ptyId, label: `Terminal ${tabCounter}` };
    setTabs((prev) => [...prev, tabInfo]);
    setActiveTabId(tabId);
  }, [api, cwd]);

  // Auto-spawn first terminal when panel opens with no tabs
  useEffect(() => {
    if (!terminalOpen || !api || tabs.length > 0) return;
    createTab();
  }, [terminalOpen, api, tabs.length, createTab]);

  // Show/hide tab containers based on active tab
  useEffect(() => {
    instancesRef.current.forEach((instance, tabId) => {
      if (tabId === activeTabId) {
        instance.containerEl.style.display = 'block';
        // Fit and focus after becoming visible
        requestAnimationFrame(() => {
          try {
            instance.fitAddon.fit();
            const tab = tabs.find((t) => t.id === tabId);
            if (tab) {
              api?.resize(tab.ptyId, instance.xterm.cols, instance.xterm.rows);
            }
          } catch {
            // fit may fail briefly
          }
          instance.xterm.focus();
        });
      } else {
        instance.containerEl.style.display = 'none';
      }
    });
  }, [activeTabId, tabs, api]);

  // Re-fit on height/maximize/window resize
  useEffect(() => {
    if (!terminalOpen || !activeTabId) return;
    const instance = instancesRef.current.get(activeTabId);
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!instance || !tab) return;

    const doFitNow = () => {
      try {
        instance.fitAddon.fit();
        api?.resize(tab.ptyId, instance.xterm.cols, instance.xterm.rows);
      } catch {
        // ignore
      }
    };

    fitFrame.current?.cancel();
    fitFrame.current = rafThrottle(doFitNow);
    const doFit = () => fitFrame.current?.();

    const timer = setTimeout(doFit, 60);
    window.addEventListener('resize', doFit, { passive: true });
    return () => {
      fitFrame.current?.cancel();
      clearTimeout(timer);
      window.removeEventListener('resize', doFit);
    };
  }, [terminalOpen, terminalHeight, isMaximized, activeTabId, tabs, api]);

  // Cleanup all terminals on unmount
  useEffect(() => {
    const instances = instancesRef.current;
    return () => {
      heightFrame.current?.cancel();
      fitFrame.current?.cancel();
      document.body.classList.remove('resize-performance-lock');
      instances.forEach((instance, _tabId) => {
        instance.cleanup();
      });
      instances.clear();
    };
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      document.body.classList.add('resize-performance-lock');
      heightFrame.current?.cancel();
      heightFrame.current = rafThrottle((nextHeight: number) => {
        setTerminalHeight(nextHeight);
      });
      const startY = e.clientY;
      const startHeight = terminalHeight;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        heightFrame.current?.(startHeight + (startY - ev.clientY));
      };

      const onMouseUp = () => {
        isResizing.current = false;
        heightFrame.current?.flush();
        heightFrame.current = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.classList.remove('resize-performance-lock');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [terminalHeight, setTerminalHeight]
  );

  const handleToggleMaximize = useCallback(() => {
    if (isMaximized) {
      setTerminalHeight(prevHeight.current);
    } else {
      prevHeight.current = terminalHeight;
      setTerminalHeight(600);
    }
    setIsMaximized(!isMaximized);
  }, [isMaximized, terminalHeight, setTerminalHeight]);

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      const instance = instancesRef.current.get(tabId);
      if (instance) {
        instance.cleanup();
        instancesRef.current.delete(tabId);
      }
      if (tab) {
        api?.kill(tab.ptyId);
      }

      const remaining = tabs.filter((t) => t.id !== tabId);
      setTabs(remaining);
      if (activeTabId === tabId) {
        setActiveTabId(remaining.length > 0 ? remaining[remaining.length - 1].id : null);
      }
      if (remaining.length === 0) {
        setTerminalOpen(false);
      }
    },
    [tabs, activeTabId, api, setTerminalOpen]
  );

  const closeAll = useCallback(() => {
    tabs.forEach((tab) => {
      const instance = instancesRef.current.get(tab.id);
      if (instance) {
        instance.cleanup();
        instancesRef.current.delete(tab.id);
      }
      api?.kill(tab.ptyId);
    });
    setTabs([]);
    setActiveTabId(null);
    setTerminalOpen(false);
  }, [tabs, api, setTerminalOpen]);

  if (!terminalOpen) return null;

  if (!api) {
    return (
      <div className="border-t border-border/60 bg-[#0a0a0a] flex items-center justify-center" style={{ height: terminalHeight }}>
        <p className="text-sm text-muted-foreground">Terminal is only available in the desktop app.</p>
      </div>
    );
  }

  return (
    <div className="app-independent-pane border-t border-border/60 flex flex-col flex-shrink-0" style={{ height: isMaximized ? '70vh' : terminalHeight }}>
      {/* Resize handle */}
      <div onMouseDown={handleResizeStart} className="h-1 cursor-row-resize group flex-shrink-0 bg-[#0a0a0a]">
        <div className="h-px w-full bg-border/30 group-hover:bg-primary/40 group-active:bg-primary/60 transition-colors" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center h-9 px-2 bg-[#0a0a0a] border-b border-border/30 flex-shrink-0">
        <div className="flex items-center gap-1 mr-2">
          <TerminalIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors duration-100 whitespace-nowrap',
                activeTabId === tab.id
                  ? 'bg-[#1a1a1a] text-foreground'
                  : 'text-muted-foreground hover:text-foreground/80'
              )}
            >
              <span>{tab.label}</span>
              <span
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-[#2a2a2a] transition-colors"
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </button>
          ))}
          <button
            onClick={() => createTab()}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] transition-colors"
            title="New terminal"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={handleToggleMaximize}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] transition-colors"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setTerminalOpen(false)}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-[#1a1a1a] transition-colors"
            title="Minimize"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={closeAll}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-red-500/20 hover:text-red-400 transition-colors"
            title="Close terminal"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal content — each tab gets its own div, show/hide based on active */}
      <div
        ref={wrapperRef}
        className="flex-1 bg-[#0a0a0a] overflow-hidden"
        style={{ minHeight: 0 }}
      />

      {/* Spawn error message */}
      {spawnError && (
        <div className="px-3 py-2 bg-red-500/10 border-t border-red-500/20 text-[12px] text-red-400">
          Failed to spawn terminal: {spawnError}
        </div>
      )}
    </div>
  );
};
