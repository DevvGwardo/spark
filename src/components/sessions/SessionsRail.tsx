import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, LayoutGrid, Rows, Check } from 'lucide-react';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { useStreamLockStore } from '@/stores/stream-lock-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { cn } from '@/lib/utils';

interface SessionsRailProps {
  viewMode: 'row' | 'grid';
  onToggleViewMode: () => void;
}

/**
 * Vertical rail on the left edge showing every active session. Each session is
 * a panel with its own isolated Hermes profile (see panel-store). The rail is
 * the primary visual surface for seeing and navigating parallel sessions.
 *
 * Keyboard: ⌘1..⌘9 focus by index, ⌘T new session, ⌘W close current.
 */
export const SessionsRail: React.FC<SessionsRailProps> = ({ viewMode, onToggleViewMode }) => {
  const panels = usePanelStore((s) => s.panels);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const openPanel = usePanelStore((s) => s.openPanel);
  const focusPanel = usePanelStore((s) => s.focusPanel);
  const closePanel = usePanelStore((s) => s.closePanel);
  const conversations = useChatStore((s) => s.conversations);
  const locks = useStreamLockStore((s) => s.locks);
  const panelUsage = useContextUsageStore((s) => s.panelUsage);

  // A session is "streaming" when its panelId holds a stream lock for any profile.
  const streamingPanels = useMemo(() => {
    const set = new Set<string>();
    for (const panelId of Object.values(locks)) {
      if (panelId) set.add(panelId);
    }
    return set;
  }, [locks]);

  // Completion indicator: when a background (unfocused) session transitions
  // from streaming → idle, flag it briefly so the user notices the card.
  const prevStreamingRef = useRef<Set<string>>(new Set());
  const [completedPanels, setCompletedPanels] = useState<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevStreamingRef.current;
    const justCompleted: string[] = [];
    for (const panelId of prev) {
      if (!streamingPanels.has(panelId) && panelId !== focusedPanelId) {
        justCompleted.push(panelId);
      }
    }
    prevStreamingRef.current = new Set(streamingPanels);
    if (justCompleted.length === 0) return;
    setCompletedPanels((current) => {
      const next = new Set(current);
      for (const id of justCompleted) next.add(id);
      return next;
    });
    const timer = window.setTimeout(() => {
      setCompletedPanels((current) => {
        if (current.size === 0) return current;
        const next = new Set(current);
        for (const id of justCompleted) next.delete(id);
        return next;
      });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [streamingPanels, focusedPanelId]);

  // When user focuses a completed session, clear its completion flag.
  useEffect(() => {
    if (!completedPanels.has(focusedPanelId)) return;
    setCompletedPanels((current) => {
      const next = new Set(current);
      next.delete(focusedPanelId);
      return next;
    });
  }, [focusedPanelId, completedPanels]);

  // ⌘1..⌘9 focus by index; ⌘T new session; ⌘W close current
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Skip if user is typing in an input/textarea/contenteditable
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        const panel = panels[idx];
        if (panel) {
          e.preventDefault();
          focusPanel(panel.id);
        }
        return;
      }
      if (e.key.toLowerCase() === 't' && !e.shiftKey) {
        e.preventDefault();
        openPanel(null);
        return;
      }
      if (e.key.toLowerCase() === 'w' && !e.shiftKey) {
        if (panels.length <= 1) return;
        e.preventDefault();
        closePanel(focusedPanelId);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [panels, focusedPanelId, focusPanel, openPanel, closePanel]);

  return (
    <div className="flex h-full w-[72px] flex-shrink-0 flex-col items-center border-r border-border/60 bg-[hsl(var(--frame-bg))] py-3">
      {/* Session list */}
      <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto w-full px-2">
        {panels.map((panel, idx) => {
          const conv = panel.conversationId
            ? conversations.find((c) => c.id === panel.conversationId)
            : null;
          const isActive = panel.id === focusedPanelId;
          const isStreaming = streamingPanels.has(panel.id);
          const title = conv?.title || 'New session';
          const usage = panelUsage[panel.id];
          const shortcutLabel = idx < 9 ? `⌘${idx + 1}` : '';
          const isCompleted = completedPanels.has(panel.id);
          return (
            <SessionCard
              key={panel.id}
              index={idx + 1}
              title={title}
              shortcut={shortcutLabel}
              profile={panel.profile}
              isActive={isActive}
              isStreaming={isStreaming}
              isCompleted={isCompleted}
              contextPercent={usage?.percentage}
              canClose={panels.length > 1}
              onClick={() => focusPanel(panel.id)}
              onClose={() => closePanel(panel.id)}
            />
          );
        })}

        {/* New session */}
        <button
          onClick={() => openPanel(null)}
          className="group mt-1 flex h-11 w-11 items-center justify-center rounded-xl border border-dashed border-border/50 text-muted-foreground transition-colors hover:border-border hover:bg-background/60 hover:text-foreground"
          title="New session (⌘T)"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {/* View mode toggle */}
      <div className="flex flex-shrink-0 flex-col items-center gap-1 pt-2">
        <button
          onClick={onToggleViewMode}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground',
            panels.length < 2 && 'opacity-40 pointer-events-none'
          )}
          title={viewMode === 'grid' ? 'Switch to split view' : 'Switch to grid view'}
        >
          {viewMode === 'grid' ? <Rows className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
};

interface SessionCardProps {
  index: number;
  title: string;
  shortcut: string;
  profile: string;
  isActive: boolean;
  isStreaming: boolean;
  isCompleted: boolean;
  contextPercent?: number;
  canClose: boolean;
  onClick: () => void;
  onClose: () => void;
}

const SessionCard: React.FC<SessionCardProps> = ({
  index,
  title,
  shortcut,
  profile,
  isActive,
  isStreaming,
  isCompleted,
  contextPercent,
  canClose,
  onClick,
  onClose,
}) => {
  return (
    <div className="group relative w-full">
      <button
        onClick={onClick}
        className={cn(
          'relative flex h-11 w-11 mx-auto items-center justify-center rounded-xl border text-[12px] font-semibold transition-all duration-150',
          isActive
            ? 'border-primary/70 bg-primary/10 text-foreground shadow-[0_0_0_1px_hsl(var(--primary)/0.35)]'
            : 'border-border/50 bg-background/40 text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground'
        )}
        title={`${title} · ${profile}${shortcut ? ` · ${shortcut}` : ''}`}
      >
        <span className="font-mono tabular-nums">{index}</span>
        {isStreaming && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center"
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF8800] opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF8800]" />
          </span>
        )}
        {!isStreaming && isCompleted && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-background shadow-[0_0_0_2px_hsl(var(--frame-bg))]"
          >
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </span>
        )}
        {typeof contextPercent === 'number' && contextPercent > 0 && (
          <span
            aria-hidden
            className={cn(
              'absolute bottom-0.5 left-1 right-1 h-[2px] rounded-full overflow-hidden',
              isActive ? 'bg-primary/20' : 'bg-border/40'
            )}
          >
            <span
              className={cn(
                'block h-full rounded-full transition-all',
                contextPercent > 90
                  ? 'bg-red-400'
                  : contextPercent > 70
                    ? 'bg-amber-400'
                    : 'bg-[#FF8800]'
              )}
              style={{ width: `${Math.min(100, Math.max(2, contextPercent))}%` }}
            />
          </span>
        )}
      </button>

      {/* Close button — hover only */}
      {canClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="absolute -top-1 -left-1 hidden h-4 w-4 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground opacity-0 transition-opacity group-hover:flex group-hover:opacity-100 hover:text-foreground"
          title="Close session (⌘W)"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
};
