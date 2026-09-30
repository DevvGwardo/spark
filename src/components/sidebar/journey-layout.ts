import dagre from 'dagre';
import type { Edge, Node } from '@xyflow/react';
import type { JourneyNode } from '@/lib/hermes-api';

const NODE_WIDTH = 148;
const NODE_HEIGHT = 42;

export interface JourneyNodeData extends Record<string, unknown> {
  journeyNode: JourneyNode;
}

function nodeTimestamp(n: JourneyNode): number {
  const ts = n.timestamp ?? 0;
  return ts > 1e12 ? ts : ts * 1000;
}

function parseApiEdge(e: Record<string, unknown>): { source: string; target: string } | null {
  const source = String(e.source ?? e.from ?? e.sourceId ?? e.source_id ?? '').trim();
  const target = String(e.target ?? e.to ?? e.targetId ?? e.target_id ?? '').trim();
  if (!source || !target) return null;
  return { source, target };
}

function chronologicalSpineEdges(nodes: JourneyNode[]): Edge[] {
  const sorted = [...nodes].sort((a, b) => nodeTimestamp(a) - nodeTimestamp(b));
  const edges: Edge[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const source = sorted[i]!.id;
    const target = sorted[i + 1]!.id;
    edges.push({
      id: `spine:${source}->${target}`,
      source,
      target,
      type: 'smoothstep',
    });
  }
  return edges;
}

/**
 * Build xyflow nodes/edges from Hermes journey data. Uses API edges when present;
 * otherwise connects nodes in chronological order (oldest → newest, top → bottom).
 */
export function buildJourneyGraph(
  nodes: JourneyNode[],
  rawEdges: Array<Record<string, unknown>>,
): { nodes: Node<JourneyNodeData>[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes: [], edges: [] };

  const nodeIds = new Set(nodes.map((n) => n.id));
  const parsed = rawEdges
    .map(parseApiEdge)
    .filter((e): e is { source: string; target: string } => {
      if (!e) return false;
      return nodeIds.has(e.source) && nodeIds.has(e.target);
    });

  const edges: Edge[] =
    parsed.length > 0
      ? parsed.map(({ source, target }, i) => ({
          id: `api:${source}->${target}:${i}`,
          source,
          target,
          type: 'smoothstep',
        }))
      : chronologicalSpineEdges(nodes);

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 20, ranksep: 32, marginx: 12, marginy: 12 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const flowNodes: Node<JourneyNodeData>[] = nodes.map((journeyNode) => {
    const laid = g.node(journeyNode.id);
    return {
      id: journeyNode.id,
      type: 'journey',
      position: {
        x: (laid?.x ?? 0) - NODE_WIDTH / 2,
        y: (laid?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { journeyNode },
    };
  });

  return { nodes: flowNodes, edges };
}

