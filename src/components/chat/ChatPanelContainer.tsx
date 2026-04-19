import React from 'react';
import { ChatPanel } from './ChatPanel';
import { usePanelStore } from '@/stores/panel-store';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

interface ChatPanelContainerProps {
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}

export const ChatPanelContainer: React.FC<ChatPanelContainerProps> = ({ onOpenPR }) => {
  const { panels, focusedPanelId, focusPanel, closePanel, viewMode } = usePanelStore();

  // Single panel — no resize handles, no header
  if (panels.length === 1) {
    return (
      <ChatPanel
        key={panels[0].id}
        panelId={panels[0].id}
        conversationId={panels[0].conversationId}
        isFocused={true}
        onFocus={() => {}}
      />
    );
  }

  // Grid mode — tiled layout (2 cols, wrap). Each panel keeps streaming while
  // unfocused; grid is purely presentational over the same ChatPanel instances.
  if (viewMode === 'grid') {
    const cols = panels.length <= 2 ? 2 : panels.length <= 4 ? 2 : panels.length <= 9 ? 3 : 4;
    return (
      <div
        className="grid h-full gap-0 overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {panels.map((panel) => (
          <div
            key={panel.id}
            className="min-w-0 min-h-0 overflow-hidden border-r border-b border-border/40 last:border-r-0"
          >
            <ChatPanel
              panelId={panel.id}
              conversationId={panel.conversationId}
              isFocused={panel.id === focusedPanelId}
              onFocus={() => focusPanel(panel.id)}
              onClose={() => closePanel(panel.id)}
              onOpenPR={onOpenPR}
            />
          </div>
        ))}
      </div>
    );
  }

  // Multiple panels — resizable split view
  return (
    <ResizablePanelGroup direction="horizontal">
      {panels.map((panel, i) => (
        <React.Fragment key={panel.id}>
          {i > 0 && <ResizableHandle withHandle />}
          <ResizablePanel minSize={20}>
            <ChatPanel
              panelId={panel.id}
              conversationId={panel.conversationId}
              isFocused={panel.id === focusedPanelId}
              onFocus={() => focusPanel(panel.id)}
              onClose={() => closePanel(panel.id)}
              onOpenPR={onOpenPR}
            />
          </ResizablePanel>
        </React.Fragment>
      ))}
    </ResizablePanelGroup>
  );
};
