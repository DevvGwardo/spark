import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Compass, LayoutList, Loader2, Network, RefreshCw, X } from 'lucide-react';
import { fetchJourneyGraph, type JourneyNode } from '@/lib/hermes-api';
import { buildJourneyGraph, type JourneyNodeData } from './journey-layout';
import { cn } from '@/lib/utils';

type ViewMode = 'graph' | 'list';

function formatTs(ts?: number): string {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function JourneyFlowNode({ data, selected }: NodeProps) {
  const node = (data as JourneyNodeData).journeyNode;
  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1 }} />
      <div
        className={cn(
          'flex h-[38px] w-[140px] flex-col justify-center rounded-md border px-2 py-1 text-left transition-colors',
          selected
            ? 'border-primary/60 bg-primary/10'
            : 'border-border/50 bg-[hsl(var(--card))] hover:border-border/80',
        )}
      >
        <div className="truncate text-[11px] font-medium leading-tight text-foreground/90">
          {node.label || node.id}
        </div>
        <div className="mt-0.5 flex items-center gap-1 truncate text-[9px] text-muted-foreground/55">
          {node.kind && <span className="font-mono">{node.kind}</span>}
          {node.category && <span className="truncate">{node.category}</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, width: 1, height: 1 }} />
    </>
  );
}

function NodeDetailStrip({
  node,
  onClose,
}: {
  node: JourneyNode;
  onClose: () => void;
}) {
  return (
    <div className="flex w-[132px] shrink-0 flex-col border-l border-border/40 bg-background/60">
      <div className="flex items-center justify-between gap-1 border-b border-border/30 px-2 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Detail
        </span>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Close detail"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
        <div>
          <div className="text-[11px] font-medium leading-snug text-foreground/90">
            {node.label || node.id}
          </div>
          <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/45">{node.id}</div>
        </div>
        <dl className="space-y-1.5 text-[10px]">
          <div>
            <dt className="text-muted-foreground/45">Date</dt>
            <dd className="font-mono text-foreground/80">{formatTs(node.timestamp)}</dd>
          </div>
          {node.kind && (
            <div>
              <dt className="text-muted-foreground/45">Kind</dt>
              <dd className="font-mono text-foreground/80">{node.kind}</dd>
            </div>
          )}
          {node.category && (
            <div>
              <dt className="text-muted-foreground/45">Category</dt>
              <dd className="text-foreground/80">{node.category}</dd>
            </div>
          )}
          {node.state && (
            <div>
              <dt className="text-muted-foreground/45">State</dt>
              <dd className="text-foreground/80">{node.state}</dd>
            </div>
          )}
          {typeof node.useCount === 'number' && (
            <div>
              <dt className="text-muted-foreground/45">Uses</dt>
              <dd className="font-mono text-foreground/80">{node.useCount}</dd>
            </div>
          )}
          {node.createdBy && (
            <div>
              <dt className="text-muted-foreground/45">Created by</dt>
              <dd className="truncate text-foreground/80">{node.createdBy}</dd>
            </div>
          )}
          {node.pinned && (
            <div>
              <dt className="text-muted-foreground/45">Pinned</dt>
              <dd className="text-foreground/80">Yes</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}

function JourneyListView({ nodes }: { nodes: JourneyNode[] }) {
  return (
    <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
      {nodes.map((node) => (
        <div
          key={node.id}
          className="rounded-md border border-border/35 bg-background/35 px-2.5 py-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-foreground/90">
                {node.label || node.id}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/55">
                {node.kind && (
                  <span className="rounded bg-muted/40 px-1 py-0.5 font-mono">{node.kind}</span>
                )}
                {node.category && <span>{node.category}</span>}
                {node.state && <span className="text-muted-foreground/40">{node.state}</span>}
                {typeof node.useCount === 'number' && node.useCount > 0 && (
                  <span className="font-mono">×{node.useCount}</span>
                )}
              </div>
            </div>
            <span className="shrink-0 text-[10px] font-mono text-muted-foreground/45">
              {formatTs(node.timestamp)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Learning graph of skills + memories from `hermes journey --json`.
 * Mounted as a tab inside Memories.
 */
export function JourneyPanel() {
  const [nodes, setNodes] = useState<JourneyNode[]>([]);
  const [rawEdges, setRawEdges] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<ViewMode>('graph');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const graph = await fetchJourneyGraph();
      setNodes(graph.nodes || []);
      setRawEdges(graph.edges || []);
      setError(graph.error || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load journey');
      setNodes([]);
      setRawEdges([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        (n.label || n.id || '').toLowerCase().includes(q) ||
        (n.category || '').toLowerCase().includes(q) ||
        (n.kind || '').toLowerCase().includes(q),
    );
  }, [filter, nodes]);

  const filteredIds = useMemo(() => new Set(filtered.map((n) => n.id)), [filtered]);

  const filteredEdges = useMemo(
    () =>
      rawEdges.filter((e) => {
        const source = String(e.source ?? e.from ?? e.sourceId ?? e.source_id ?? '');
        const target = String(e.target ?? e.to ?? e.targetId ?? e.target_id ?? '');
        return filteredIds.has(source) && filteredIds.has(target);
      }),
    [rawEdges, filteredIds],
  );

  const { nodes: flowNodes, edges: flowEdges } = useMemo(
    () => buildJourneyGraph(filtered, filteredEdges),
    [filtered, filteredEdges],
  );

  const nodeTypes = useMemo(() => ({ journey: JourneyFlowNode }), []);

  const selectedNode = useMemo(
    () => (selectedId ? filtered.find((n) => n.id === selectedId) ?? null : null),
    [filtered, selectedId],
  );

  useEffect(() => {
    if (selectedId && !filteredIds.has(selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, filteredIds]);

  const byKind = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) {
      const k = n.kind || 'other';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [nodes]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Compass className="h-3.5 w-3.5 text-primary/80" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Journey</span>
          <span className="text-[10px] text-muted-foreground/50 font-mono">{nodes.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-md border border-border/40 p-0.5">
            {(
              [
                { key: 'graph' as const, icon: Network, label: 'Graph' },
                { key: 'list' as const, icon: LayoutList, label: 'List' },
              ] as const
            ).map(({ key, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                  mode === key
                    ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                    : 'text-muted-foreground/55 hover:text-foreground',
                )}
                title={`${label} view`}
              >
                <Icon className="h-3 w-3" />
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh journey"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="px-3 pb-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter skills / memories…"
          className="w-full rounded-md border border-border/40 bg-background/40 px-3 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/35 focus:border-primary/30"
        />
        {byKind.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {byKind.slice(0, 6).map(([kind, count]) => (
              <span
                key={kind}
                className="rounded-md border border-border/30 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/60"
              >
                {kind} {count}
              </span>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-md border border-destructive/25 bg-destructive/10 p-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {loading && nodes.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading learning graph…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center text-[12px] text-muted-foreground/55">
          <Compass className="h-4 w-4 opacity-50" />
          <p>No journey nodes yet. Skills and memories appear as Hermes learns.</p>
        </div>
      ) : mode === 'list' ? (
        <JourneyListView nodes={filtered} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="h-full min-h-0 min-w-0 flex-1 [&_.react-flow\_\_attribution]:hidden">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              minZoom={0.25}
              maxZoom={1.5}
              defaultEdgeOptions={{
                style: { stroke: 'hsl(var(--border))', strokeWidth: 1 },
              }}
            >
              <Background gap={20} size={1} color="hsl(var(--border) / 0.35)" />
            </ReactFlow>
          </div>
          {selectedNode && (
            <NodeDetailStrip node={selectedNode} onClose={() => setSelectedId(null)} />
          )}
        </div>
      )}
    </div>
  );
}
