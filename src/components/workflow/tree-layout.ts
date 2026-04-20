import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';
import type { Conversation } from '@/lib/db';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 68;

export interface TreeNodeData extends Record<string, unknown> {
  conversationId: string;
  title: string;
  streaming: boolean;
  updatedAt: string;
  pinned?: boolean;
  forkNumber?: number;
}

/**
 * Build an xyflow node/edge graph from the conversation list and run dagre
 * top-to-bottom auto-layout. Orphans (no parent, no children) are included
 * and laid out as isolated roots — dagre keeps them in the same canvas.
 */
export function buildConversationGraph(
  conversations: Conversation[],
  activities: Record<string, { streaming?: boolean } | undefined>,
): { nodes: Node<TreeNodeData>[]; edges: Edge[] } {
  const convById = new Map(conversations.map((c) => [c.id, c]));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const conv of conversations) {
    g.setNode(conv.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  const edges: Edge[] = [];
  for (const conv of conversations) {
    if (conv.parentConversationId && convById.has(conv.parentConversationId)) {
      g.setEdge(conv.parentConversationId, conv.id);
      edges.push({
        id: `${conv.parentConversationId}->${conv.id}`,
        source: conv.parentConversationId,
        target: conv.id,
        type: 'smoothstep',
        animated: activities[conv.id]?.streaming ?? false,
      });
    }
  }

  dagre.layout(g);

  const nodes: Node<TreeNodeData>[] = conversations.map((conv) => {
    const laid = g.node(conv.id);
    return {
      id: conv.id,
      type: 'conversation',
      position: {
        x: (laid?.x ?? 0) - NODE_WIDTH / 2,
        y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: {
        conversationId: conv.id,
        title: conv.title,
        streaming: activities[conv.id]?.streaming ?? false,
        updatedAt: conv.updatedAt,
        pinned: conv.pinned,
        forkNumber: conv.forkNumber,
      },
    };
  });

  return { nodes, edges };
}
