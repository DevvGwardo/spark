import React, { useCallback, useRef } from 'react';
import { X, PanelRight } from 'lucide-react';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import { ChatPanel } from './ChatPanel';

export const DockedChatSidebar: React.FC = () => {
  const dockedPanel = usePanelStore((s) => s.dockedPanel);
  const dockedPanelWidth = usePanelStore((s) => s.dockedPanelWidth);
  const setDockedPanelWidth = usePanelStore((s) => s.setDockedPanelWidth);
  const undockPanel = usePanelStore((s) => s.undockPanel);
  const conversations = useChatStore((s) => s.conversations);

  const isResizing = useRef(false);

  const activeConv = dockedPanel
    ? conversations.find((c) => c.id === dockedPanel.conversationId)
    : null;
  const convTitle = activeConv?.title || 'Chat';

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startWidth = dockedPanelWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const newWidth = startWidth + (ev.clientX - startX);
        setDockedPanelWidth(newWidth);
      };

      const onMouseUp = () => {
        isResizing.current = false;
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
    [dockedPanelWidth, setDockedPanelWidth]
  );

  if (!dockedPanel) return null;

  // Use a fake panelId for the docked ChatPanel
  const panelId = `docked-${dockedPanel.sourcePanelId}`;

  return (
    <div
      className="relative shrink-0 h-full border-l border-[hsl(var(--sidebar-border))] bg-[hsl(var(--sidebar-bg))] flex flex-col overflow-hidden"
      style={{ width: dockedPanelWidth }}
    >
      {/* Resize handle on left edge */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute top-0 -left-1.5 z-10 h-full w-3 cursor-col-resize group"
      >
        <div className="absolute inset-y-6 bottom-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border/25 transition-colors group-hover:bg-foreground/25 group-active:bg-foreground/40" />
      </div>

      {/* Header */}
      <div className="flex items-center h-9 px-3 border-b border-border bg-muted/20 shrink-0 gap-2">
        <PanelRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-muted-foreground truncate flex-1 min-w-0">
          {convTitle}
        </span>
        <button
          onClick={undockPanel}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors duration-100 shrink-0"
          title="Pop back in"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Chat content */}
      <div className="flex-1 overflow-hidden">
        <ChatPanel
          panelId={panelId}
          conversationId={dockedPanel.conversationId}
          isFocused={true}
          onFocus={() => {}}
        />
      </div>
    </div>
  );
};
