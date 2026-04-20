import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { X, Pin, GitFork } from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { useActivityStore } from '@/stores/activity-store';
import { usePanelStore } from '@/stores/panel-store';
import { GhostIcon } from '@/components/chat/GhostIcon';
import { buildConversationGraph, type TreeNodeData } from './tree-layout';
import { cn } from '@/lib/utils';

interface ConversationTreeOverlayProps {
  onClose: () => void;
}

/**
 * Full-screen overlay visualizing every conversation as a node in a dagre-laid
 * out tree. Edges follow parentConversationId (fork history). Clicking a node
 * focuses that conversation in the active panel and closes the overlay.
 */
export const ConversationTreeOverlay: React.FC<ConversationTreeOverlayProps> = ({ onClose }) => {
  const conversations = useChatStore((s) => s.conversations);
  const activities = useActivityStore((s) => s.activities);
  const setConversationForPanel = usePanelStore((s) => s.setConversationForPanel);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);

  const { nodes, edges } = useMemo(
    () => buildConversationGraph(conversations, activities),
    [conversations, activities],
  );

  const nodeTypes = useMemo(() => ({ conversation: ConversationNode }), []);

  const handleNodeClick = (_: React.MouseEvent, node: { id: string }) => {
    setConversationForPanel(focusedPanelId, node.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[hsl(var(--frame-bg))]">
      {/* Header */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="flex items-center gap-2">
          <GitFork className="h-4 w-4 text-muted-foreground" />
          <span className="text-[13px] font-medium">Conversation tree</span>
          <span className="text-[11px] text-muted-foreground">· {conversations.length} threads</span>
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0">
        {conversations.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            No conversations yet.
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={handleNodeClick}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
          >
            <Background gap={24} size={1} color="hsl(var(--border))" />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => ((n.data as TreeNodeData)?.streaming ? '#FF8800' : '#3F3F3F')}
              maskColor="hsl(var(--frame-bg) / 0.6)"
              style={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  );
};

// ── Custom node ──────────────────────────────────────────────────────────

const ConversationNode: React.FC<NodeProps> = ({ data, selected }) => {
  const d = data as TreeNodeData;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        className={cn(
          'flex min-h-[56px] w-[210px] flex-col gap-1 rounded-[10px] border px-3 py-2 text-left transition-colors',
          selected
            ? 'border-primary/70 bg-primary/10'
            : d.streaming
              ? 'border-[#FF880055] bg-[hsl(var(--card))] shadow-[0_0_0_1px_#FF880033]'
              : 'border-border/60 bg-[hsl(var(--card))] hover:border-border hover:bg-background/70',
        )}
      >
        <div className="flex items-center gap-1.5">
          {d.streaming && <GhostIcon size={11} />}
          {d.pinned && <Pin className="h-3 w-3 text-foreground/70" fill="currentColor" />}
          {typeof d.forkNumber === 'number' && d.forkNumber > 0 && (
            <GitFork className="h-3 w-3 text-muted-foreground/70" />
          )}
          <span className="truncate text-[12px] font-medium text-foreground">{d.title}</span>
        </div>
        <span className="text-[10px] text-muted-foreground/80">
          {new Date(d.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
};
