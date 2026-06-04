import React, { useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Network,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  useHermesStore,
  type MCPServer,
  type MCPTool,
  type MCPConnectionStatus,
  type MCPTransportType,
} from '@/stores/hermes-store';
import { discoverMCPTools, discoverAllMCPTools } from '@/lib/mcp-connect';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/relative-time';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<MCPConnectionStatus, { color: string; bg: string; ring: string; label: string; icon: React.ComponentType<{ className?: string }> }> = {
  connected: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/12',
    ring: 'ring-emerald-500/25',
    label: 'Connected',
    icon: PlugZap,
  },
  connecting: {
    color: 'text-amber-400',
    bg: 'bg-amber-500/12',
    ring: 'ring-amber-500/25',
    label: 'Connecting…',
    icon: Loader2,
  },
  disconnected: {
    color: 'text-muted-foreground/60',
    bg: 'bg-muted/40',
    ring: 'ring-border/40',
    label: 'Disconnected',
    icon: Plug,
  },
  error: {
    color: 'text-red-400',
    bg: 'bg-red-500/12',
    ring: 'ring-red-500/25',
    label: 'Error',
    icon: AlertCircle,
  },
};

const TRANSPORT_LABELS: Record<MCPTransportType, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  http: { label: 'HTTP', icon: Network },
  stdio: { label: 'Stdio', icon: Terminal },
};

function StatusDot({ status }: { status: MCPConnectionStatus }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        status === 'connected' && 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]',
        status === 'connecting' && 'bg-amber-500 animate-pulse shadow-[0_0_6px_rgba(245,158,11,0.45)]',
        status === 'disconnected' && 'bg-muted-foreground/40',
        status === 'error' && 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.45)]',
      )}
    />
  );
}

function ToolBadge({ tool }: { tool: MCPTool }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground/70 transition-colors hover:border-[#ff8f3f]/30 hover:text-foreground"
      title={tool.description || tool.name}
    >
      <Wrench className="h-2.5 w-2.5 shrink-0 opacity-50" />
      {tool.name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ServerCard — expandable card for a single MCP server
// ---------------------------------------------------------------------------

function ServerCard({
  server,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onRefresh,
  onRemove,
  connecting,
}: {
  server: MCPServer;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onRefresh: () => void;
  onRemove: () => void;
  connecting: boolean;
}) {
  const statusConfig = STATUS_CONFIG[server.connectionStatus];
  const transportConfig = TRANSPORT_LABELS[server.transportType];
  const TransportIcon = transportConfig.icon;
  const StatusIcon = statusConfig.icon;
  const isCircuitBroken = server.errorCount >= 3;

  return (
    <div
      className={cn(
        'rounded-xl border transition-colors',
        expanded
          ? 'border-[#ff8f3f]/30 bg-[#ff8f3f]/7'
          : 'border-border/30 bg-background/30 hover:bg-[hsl(var(--sidebar-active))]',
      )}
    >
      {/* Header row */}
      <button
        onClick={onToggleExpand}
        className="w-full px-3 py-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <div className={cn(
              'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
              statusConfig.bg,
            )}>
              <StatusIcon className={cn(
                'h-3.5 w-3.5',
                statusConfig.color,
                server.connectionStatus === 'connecting' && 'animate-spin',
              )} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[12px] font-medium text-foreground">{server.name}</span>
                <StatusDot status={server.connectionStatus} />
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground/50">
                <TransportIcon className="h-2.5 w-2.5 shrink-0" />
                <span>{transportConfig.label}</span>
                <span className="opacity-40">·</span>
                <span>{server.tools.length} tool{server.tools.length !== 1 ? 's' : ''}</span>
                {isCircuitBroken && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="text-red-400/70">{server.errorCount} errors</span>
                  </>
                )}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              disabled={connecting}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-background/50 hover:text-foreground disabled:opacity-40"
              title="Reconnect"
            >
              <RefreshCw className={cn('h-3 w-3', connecting && 'animate-spin')} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleEnabled(); }}
              className={cn(
                'relative inline-flex h-[20px] w-[34px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200',
                server.enabled ? 'bg-[#ff8f3f]' : 'bg-border',
              )}
              title={server.enabled ? 'Disable' : 'Enable'}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200',
                  server.enabled ? 'translate-x-[17px]' : 'translate-x-[3px]',
                )}
              />
            </button>
          </div>
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border/30 px-3 pb-3 pt-2">
          {/* Connection info */}
          <div className="mb-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/45">
            <span className="truncate font-mono">{server.url}</span>
          </div>

          {/* Status badge */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              `${statusConfig.bg} ${statusConfig.color} ring-1 ${statusConfig.ring}`,
            )}>
              <StatusDot status={server.connectionStatus} />
              {statusConfig.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/50 px-2 py-0.5 text-[10px] text-muted-foreground/60">
              <TransportIcon className="h-2.5 w-2.5" />
              {transportConfig.label}
            </span>
            {server.lastConnectedAt && (
              <span className="text-[10px] text-muted-foreground/40">
                Last connected {relativeTime(server.lastConnectedAt)}
              </span>
            )}
          </div>

          {/* Error message */}
          {server.lastError && (
            <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/8 px-2.5 py-2 text-[10px] text-red-300/80">
              <div className="flex items-start gap-1.5">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="break-all">{server.lastError}</span>
              </div>
            </div>
          )}

          {/* Circuit breaker warning */}
          {isCircuitBroken && (
            <div className="mb-2 rounded-lg border border-amber-500/20 bg-amber-500/8 px-2.5 py-2 text-[10px] text-amber-300/80">
              Circuit breaker open after {server.errorCount} consecutive failures. Auto-retry will resume after cooldown.
            </div>
          )}

          {/* Tools list */}
          {server.tools.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45">
                Exposed tools ({server.tools.length})
              </p>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <ToolBadge key={tool.name} tool={tool} />
                ))}
              </div>
            </div>
          )}

          {server.tools.length === 0 && server.connectionStatus === 'connected' && (
            <p className="text-[10px] text-muted-foreground/45">
              No tools discovered yet. Try refreshing the connection.
            </p>
          )}

          {/* Danger zone */}
          <div className="mt-3 flex items-center justify-between border-t border-border/20 pt-2">
            <button
              onClick={onRemove}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-red-400/60 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
              Remove server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddServerForm — inline form for adding new MCP servers
// ---------------------------------------------------------------------------

function AddServerForm({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, url: string, apiKey: string | undefined, transportType: MCPTransportType) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [transportType, setTransportType] = useState<MCPTransportType>('http');

  const canSubmit = name.trim().length > 0 && (
    (transportType === 'http' && url.trim().length > 0) ||
    (transportType === 'stdio' && url.trim().length > 0)
  );

  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd(name.trim(), url.trim(), apiKey.trim() || undefined, transportType);
  };

  return (
    <div className="rounded-xl border border-[#ff8f3f]/25 bg-[#ff8f3f]/5 p-3 space-y-2.5">
      <p className="text-[11px] font-medium text-foreground">Add MCP Server</p>

      {/* Transport type toggle */}
      <div className="flex gap-1">
        {(['http', 'stdio'] as const).map((t) => {
          const cfg = TRANSPORT_LABELS[t];
          const Icon = cfg.icon;
          return (
            <button
              key={t}
              onClick={() => setTransportType(t)}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                transportType === t
                  ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                  : 'text-muted-foreground/60 hover:bg-background/30 hover:text-foreground',
              )}
            >
              <Icon className="h-3 w-3" />
              {cfg.label}
            </button>
          );
        })}
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Server name"
        className="w-full rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-[#ff8f3f]/30"
      />

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={transportType === 'http' ? 'http://localhost:8080/mcp' : 'npx @modelcontextprotocol/server-filesystem /tmp'}
        className="w-full rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-[#ff8f3f]/30"
      />

      {transportType === 'http' && (
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API key (optional)"
          type="password"
          className="w-full rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-[#ff8f3f]/30"
        />
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff8f3f] px-3 py-1.5 text-[11px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
          Add &amp; Connect
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-background/30 hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HermesMCPPanel — main panel
// ---------------------------------------------------------------------------

export function HermesMCPPanel() {
  const mcpServers = useHermesStore((s) => s.mcpServers);
  const addMCPServer = useHermesStore((s) => s.addMCPServer);
  const removeMCPServer = useHermesStore((s) => s.removeMCPServer);
  const toggleMCPServer = useHermesStore((s) => s.toggleMCPServer);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  // Stats
  const stats = useMemo(() => {
    const total = mcpServers.length;
    const connected = mcpServers.filter((s) => s.connectionStatus === 'connected').length;
    const enabled = mcpServers.filter((s) => s.enabled).length;
    const totalTools = mcpServers.reduce((sum, s) => sum + s.tools.length, 0);
    return { total, connected, enabled, totalTools };
  }, [mcpServers]);

  // Connect / discover tools for a server
  const handleConnect = useCallback(async (serverId: string, url: string, apiKey?: string) => {
    setConnectingIds((prev) => new Set(prev).add(serverId));
    try {
      await discoverMCPTools({ serverId, url, apiKey });
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(serverId);
        return next;
      });
    }
  }, []);

  // Add server handler
  const handleAdd = useCallback((name: string, url: string, apiKey: string | undefined, transportType: MCPTransportType) => {
    const id = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    addMCPServer({
      id,
      name,
      url,
      apiKey,
      enabled: true,
      tools: [],
      transportType,
      connectionStatus: 'disconnected',
      errorCount: 0,
    });
    setShowAddForm(false);
    // Auto-connect for HTTP servers
    if (transportType === 'http') {
      handleConnect(id, url, apiKey);
    }
  }, [addMCPServer, handleConnect]);

  // Remove with confirm
  const handleRemove = useCallback((id: string, name: string) => {
    if (confirm(`Remove MCP server "${name}"?`)) {
      removeMCPServer(id);
      if (expandedId === id) setExpandedId(null);
    }
  }, [removeMCPServer, expandedId]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">MCP Servers</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {stats.connected}/{stats.total} connected · {stats.totalTools} tools exposed
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { void discoverAllMCPTools(); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh all connections"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className={cn(
              'inline-flex h-7 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-medium transition-colors',
              showAddForm
                ? 'bg-[#ff8f3f]/15 text-[#ff8f3f]'
                : 'text-muted-foreground/60 hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground',
            )}
          >
            <Plus className="h-3 w-3" />
            Add
          </button>
        </div>
      </div>

      {/* Quick stats bar */}
      {mcpServers.length > 0 && (
        <div className="flex gap-2 px-3 pb-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-background/30 px-2 py-1">
            <PlugZap className="h-3 w-3 text-emerald-400/70" />
            <span className="text-[10px] font-medium text-muted-foreground/60">
              {stats.enabled} active
            </span>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-background/30 px-2 py-1">
            <Zap className="h-3 w-3 text-[#ff8f3f]/70" />
            <span className="text-[10px] font-medium text-muted-foreground/60">
              {stats.totalTools} tools
            </span>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {/* Add form */}
        {showAddForm && (
          <div className="mb-3">
            <AddServerForm
              onAdd={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        )}

        {/* Empty state */}
        {mcpServers.length === 0 && !showAddForm && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background/60 mb-4">
              <Network className="h-6 w-6 text-muted-foreground/30" />
            </div>
            <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No MCP servers</p>
            <p className="text-[11px] text-muted-foreground/50 text-center leading-relaxed">
              Connect external tool servers to extend agent capabilities.
              MCP servers expose tools the agent can call during conversations.
            </p>
            <button
              onClick={() => setShowAddForm(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[#ff8f3f]/12 px-3 py-2 text-[11px] font-medium text-[#ffbe8a] ring-1 ring-[#ff8f3f]/20 transition-colors hover:bg-[#ff8f3f]/18"
            >
              <Plus className="h-3 w-3" />
              Add MCP Server
            </button>
          </div>
        )}

        {/* Server cards */}
        {mcpServers.length > 0 && (
          <div className="space-y-2">
            {mcpServers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                expanded={expandedId === server.id}
                onToggleExpand={() => setExpandedId((current) => current === server.id ? null : server.id)}
                onToggleEnabled={() => toggleMCPServer(server.id)}
                onRefresh={() => handleConnect(server.id, server.url, server.apiKey)}
                onRemove={() => handleRemove(server.id, server.name)}
                connecting={connectingIds.has(server.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
