import React from 'react';
import { ChatPanel } from './ChatPanel';
import { usePanelStore } from '@/stores/panel-store';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';

interface ChatPanelContainerProps {
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}

export const ChatPanelContainer: React.FC<ChatPanelContainerProps> = ({ onOpenPR }) => {
  const { panels, focusedPanelId, focusPanel, closePanel } = usePanelStore();

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
