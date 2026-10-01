import { useCallback, useMemo, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  Loader2,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Store,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import type { HermesMcpServerInfo, HermesMcpCatalogEntry } from '@/lib/hermes-api';
import {
  useHermesMcpCatalog,
  useHermesMcpServers,
  useInstallHermesMcpServer,
  useUninstallHermesMcpServer,
} from '@/lib/hermes-queries';
import { toHermesError } from '@/lib/hermes-errors';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { cn } from '@/lib/utils';
import { useHermesMcpToolIndex } from '@/hooks/useHermesMcpToolIndex';
import { McpToolIndexPanel, McpToolThresholdChip } from '@/components/mcp/McpToolIndexPanel';

// Hermes-native MCP panel — reads/writes config.yaml via hermes-api (same source as McpStoreView).

function TransportBadge({ transport }: { transport: 'stdio' | 'http' }) {
  const Icon = transport === 'http' ? Network : Terminal;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/50 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground/60">
      <Icon className="h-2.5 w-2.5" />
      {transport === 'http' ? 'HTTP' : 'Stdio'}
    </span>
  );
}

function ServerCard({
  server,
  expanded,
  onToggleExpand,
  onUninstall,
  busy,
}: {
  server: HermesMcpServerInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onUninstall: () => void;
  busy: boolean;
}) {
  const removable = !!server.catalog_id;
  const endpoint = server.transport === 'http'
    ? server.url
    : `${server.command} ${server.args.join(' ')}`.trim();

  return (
    <div
      className={cn(
        'rounded-xl border transition-colors',
        expanded
          ? 'border-primary/30 bg-primary/[0.07]'
          : 'border-border/30 bg-background/30 hover:bg-[hsl(var(--sidebar-active))]',
      )}
    >
      <button onClick={onToggleExpand} className="w-full px-3 py-2.5 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <span
              className={cn(
                'mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full',
                server.enabled
                  ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]'
                  : 'bg-muted-foreground/40',
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-foreground">{server.name}</span>
                <TransportBadge transport={server.transport} />
              </div>
              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/45" title={endpoint}>
                {endpoint}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
            <span className="text-[10px] text-muted-foreground/50">
              {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
            </span>
            <ChevronDown
              className={cn(
                'h-3 w-3 text-muted-foreground/40 transition-transform',
                expanded && 'rotate-180',
              )}
            />
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/30 px-3 pb-2.5 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/50">
            <span className={cn(
              'rounded-full border px-2 py-0.5',
              server.enabled
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400/80'
                : 'border-border/40 bg-background/40 text-muted-foreground/60',
            )}>
              {server.enabled ? 'Enabled in config' : 'Disabled in config'}
            </span>
            {server.env_keys.length > 0 && (
              <span title={server.env_keys.join(', ')}>
                {server.env_keys.length} env var{server.env_keys.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            {removable ? (
              <button
                onClick={onUninstall}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] text-red-400/60 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                Uninstall
              </button>
            ) : (
              <span className="text-[10px] text-muted-foreground/40">agent-managed</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function QuickInstallRow({
  entry,
  onInstall,
  busy,
  error,
}: {
  entry: HermesMcpCatalogEntry;
  onInstall: () => void;
  busy: boolean;
  error?: string;
}) {
  return (
    <div className="rounded-lg border border-border/30 bg-background/25 px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[11px] font-medium text-foreground">{entry.name}</span>
            <TransportBadge transport={entry.transport} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground/50">
            {entry.description}
          </p>
          {error && (
            <p className="mt-1 text-[10px] text-red-400/80">{error}</p>
          )}
        </div>
        <button
          onClick={onInstall}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Install
        </button>
      </div>
    </div>
  );
}

export function HermesMCPPanel() {
  const setMcpStoreFullscreen = useUIStore((s) => s.setMcpStoreFullscreen);
  const { reload: reloadToolIndex, ...toolIndex } = useHermesMcpToolIndex();

  const serversQuery = useHermesMcpServers();
  const catalogQuery = useHermesMcpCatalog();
  const servers = useMemo(() => serversQuery.data ?? [], [serversQuery.data]);
  const catalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const installMutation = useInstallHermesMcpServer();
  const uninstallMutation = useUninstallHermesMcpServer();
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [uninstallError, setUninstallError] = useState<unknown>(null);
  const loading = serversQuery.isFetching || catalogQuery.isFetching;
  const loadError = uninstallError ?? serversQuery.error ?? catalogQuery.error;

  const refetchServers = serversQuery.refetch;
  const refetchCatalog = catalogQuery.refetch;
  const reload = useCallback(async () => {
    setUninstallError(null);
    await Promise.all([refetchServers(), refetchCatalog(), reloadToolIndex()]);
  }, [refetchServers, refetchCatalog, reloadToolIndex]);

  const stats = useMemo(() => {
    const total = servers.length;
    const enabled = servers.filter((s) => s.enabled).length;
    const totalTools = toolIndex.totalTools || servers.reduce((sum, s) => sum + s.tool_count, 0);
    return { total, enabled, totalTools };
  }, [servers, toolIndex.totalTools]);

  const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
  const quickInstall = useMemo(
    () => catalog.filter((e) => !installedNames.has(e.name)).slice(0, 3),
    [catalog, installedNames],
  );

  const installServer = installMutation.mutateAsync;
  const handleInstall = useCallback(async (id: string) => {
    setBusyId(id);
    setInstallErrors((e) => ({ ...e, [id]: '' }));
    try {
      await installServer(id);
      await reloadToolIndex();
    } catch (err) {
      setInstallErrors((e) => ({
        ...e,
        [id]: toHermesError(err, 'Install failed').message,
      }));
    } finally {
      setBusyId(null);
    }
  }, [installServer, reloadToolIndex]);

  const uninstallServer = uninstallMutation.mutateAsync;
  const handleUninstall = useCallback(async (name: string) => {
    if (!confirm(`Uninstall the "${name}" MCP server from your hermes-agent?`)) return;
    setBusyId(name);
    setUninstallError(null);
    try {
      await uninstallServer(name);
      if (expandedName === name) setExpandedName(null);
      await reloadToolIndex();
    } catch (err) {
      setUninstallError(err);
    } finally {
      setBusyId(null);
    }
  }, [expandedName, uninstallServer, reloadToolIndex]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">MCP Servers</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {stats.enabled}/{stats.total} enabled · {stats.totalTools} tools in config
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMcpStoreFullscreen(true)}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Browse the MCP store"
          >
            <Store className="h-3.5 w-3.5" />
            Store
          </button>
          <button
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground disabled:opacity-40"
            title="Refresh from config.yaml"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {servers.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-background/30 px-2 py-1">
            <Zap className="h-3 w-3 text-primary/70" />
            <span className="text-[10px] font-medium text-muted-foreground/60">
              Hermes config.yaml
            </span>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-background/30 px-2 py-1">
            <Wrench className="h-3 w-3 text-emerald-400/70" />
            <span className="text-[10px] font-medium text-muted-foreground/60">
              {stats.totalTools} tools
            </span>
          </div>
          <McpToolThresholdChip total={stats.totalTools} threshold={toolIndex.threshold} />
        </div>
      )}

      {(toolIndex.tools.length > 0 || toolIndex.loading) && (
        <div className="border-b border-border/25 px-3 pb-2">
          <McpToolIndexPanel
            tools={toolIndex.filteredTools}
            total={toolIndex.totalTools}
            threshold={toolIndex.threshold}
            query={toolIndex.query}
            onQueryChange={toolIndex.setQuery}
            loading={toolIndex.loading}
            compact
            maxHeightClass="max-h-40"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        <HermesErrorState
          error={loadError}
          onRetry={() => void reload()}
          fallbackMessage="Could not reach the bridge."
          variant="inline"
          className="mb-2"
        />

        {serversQuery.isPending && !loadError && (
          <div className="flex items-center justify-center gap-2 py-10 text-[11px] text-muted-foreground/50">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading MCP servers…
          </div>
        )}

        {!serversQuery.isPending && !serversQuery.isFetching && servers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-background/60">
              <Network className="h-5 w-5 text-muted-foreground/30" />
            </div>
            <p className="text-[12px] font-medium text-muted-foreground/70">No MCP servers in config</p>
            <p className="mt-1 text-center text-[10px] leading-relaxed text-muted-foreground/45">
              Install from the catalog — the agent loads tools from config.yaml automatically.
            </p>
            <button
              onClick={() => setMcpStoreFullscreen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary/[0.12] px-3 py-1.5 text-[10px] font-medium text-primary ring-1 ring-primary/20 transition-colors hover:bg-primary/[0.18]"
            >
              <Store className="h-3 w-3" />
              Open MCP store
            </button>
          </div>
        )}

        {servers.length > 0 && (
          <div className="space-y-2">
            {servers.map((server) => (
              <ServerCard
                key={server.name}
                server={server}
                expanded={expandedName === server.name}
                onToggleExpand={() => setExpandedName((n) => (n === server.name ? null : server.name))}
                onUninstall={() => void handleUninstall(server.name)}
                busy={busyId === server.name}
              />
            ))}
          </div>
        )}

        {quickInstall.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45">
                Quick install
              </p>
              <button
                onClick={() => setMcpStoreFullscreen(true)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/45 transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                All
              </button>
            </div>
            <div className="space-y-1.5">
              {quickInstall.map((entry) => (
                <QuickInstallRow
                  key={entry.id}
                  entry={entry}
                  busy={busyId === entry.id}
                  error={installErrors[entry.id]}
                  onInstall={() => void handleInstall(entry.id)}
                />
              ))}
            </div>
          </div>
        )}

        {servers.length > 0 && (
          <p className="mt-3 flex items-center gap-1 text-[10px] text-muted-foreground/40">
            <Plug className="h-2.5 w-2.5" />
            Agent discovers MCP from config — no Spark-side injection.
          </p>
        )}
      </div>
    </div>
  );
}
