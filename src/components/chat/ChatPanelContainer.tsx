import React from 'react';
import { ChatPanel } from './ChatPanel';
import { usePanelStore } from '@/stores/panel-store';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

interface ChatPanelContainerProps {
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}

export const ChatPanelContainer: React.FC<ChatPanelContainerProps> = ({ onOpenPR }) => {
  const { panels, focusedPanelId, focusPanel, closePanel } = usePanelStore();

  const renderPanel = (panel: typeof panels[0], isFocused: boolean, onClose?: () => void) => (
    <ChatPanel
      panelId={panel.id}
      conversationId={panel.conversationId}
      isFocused={isFocused}
      onFocus={() => focusPanel(panel.id)}
      onClose={onClose}
      onOpenPR={onOpenPR}
    />
  );

  // Single panel
  if (panels.length === 1) {
    return renderPanel(panels[0], true);
  }

  // 3+ panels — tiled grid
  if (panels.length > 2) {
    const cols = panels.length <= 4 ? 2 : panels.length <= 9 ? 3 : 4;
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
            {renderPanel(panel, panel.id === focusedPanelId, () => closePanel(panel.id))}
          </div>
        ))}
      </div>
    );
  }

  // 2 panels — resizable split
  return (
    <ResizablePanelGroup direction="horizontal">
      {panels.map((panel, i) => (
        <React.Fragment key={panel.id}>
          {i > 0 && <ResizableHandle withHandle />}
          <ResizablePanel minSize={20}>
            {renderPanel(panel, panel.id === focusedPanelId, () => closePanel(panel.id))}
          </ResizablePanel>
        </React.Fragment>
      ))}
    </ResizablePanelGroup>
  );
};
