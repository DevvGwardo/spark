import { AlertTriangle, Loader2, Search } from 'lucide-react';
import { displayMcpToolName } from '@/lib/mcp-tool-index';
import type { HermesMcpToolIndexEntry } from '@/lib/hermes-api';
import { cn } from '@/lib/utils';

export function McpToolThresholdChip({
  total,
  threshold,
  className,
}: {
  total: number;
  threshold: number;
  className?: string;
}) {
  if (total <= threshold) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300/90',
        className,
      )}
      title={`${total} enabled MCP tools exceed the ${threshold}-tool context threshold. Hermes tool_search may defer schemas to the agent.`}
    >
      <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
      {total} tools · over {threshold}
    </span>
  );
}

function ToolRow({
  tool,
  compact,
}: {
  tool: HermesMcpToolIndexEntry;
  compact?: boolean;
}) {
  const shortName = displayMcpToolName(tool.name, tool.server);
  return (
    <div
      className={cn(
        'rounded-lg border border-border/25 bg-background/20',
        compact ? 'px-2 py-1.5' : 'px-2.5 py-2',
      )}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate font-mono text-[10px] text-foreground/90" title={tool.name}>
          {shortName}
        </span>
        <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/45">
          {tool.server}
        </span>
      </div>
      {tool.description && (
        <p
          className={cn(
            'mt-0.5 text-muted-foreground/50',
            compact ? 'line-clamp-1 text-[9px] leading-snug' : 'line-clamp-2 text-[10px] leading-snug',
          )}
          title={tool.description}
        >
          {tool.description}
        </p>
      )}
    </div>
  );
}

export function McpToolIndexPanel({
  tools,
  total,
  threshold,
  query,
  onQueryChange,
  loading,
  compact,
  className,
  maxHeightClass = 'max-h-48',
}: {
  tools: HermesMcpToolIndexEntry[];
  total: number;
  threshold: number;
  query: string;
  onQueryChange: (q: string) => void;
  loading?: boolean;
  compact?: boolean;
  className?: string;
  maxHeightClass?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[140px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/40" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search tools…"
            aria-label="Search MCP tools"
            className={cn(
              'w-full rounded-lg border border-border/35 bg-background/40 py-1.5 pl-7 pr-2 text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-primary/40',
              compact && 'py-1 text-[10px]',
            )}
          />
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground/50">
          {query.trim() ? `${tools.length}/${total}` : total}
        </span>
        <McpToolThresholdChip total={total} threshold={threshold} />
      </div>

      {loading && tools.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-[10px] text-muted-foreground/50">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading tool index…
        </div>
      ) : tools.length === 0 ? (
        <p className="py-2 text-[10px] text-muted-foreground/45">
          {query.trim() ? 'No tools match your search.' : 'No MCP tools registered yet.'}
        </p>
      ) : (
        <div className={cn('space-y-1 overflow-y-auto pr-0.5', maxHeightClass)}>
          {tools.map((tool) => (
            <ToolRow key={`${tool.server}:${tool.name}`} tool={tool} compact={compact} />
          ))}
        </div>
      )}
    </div>
  );
}
