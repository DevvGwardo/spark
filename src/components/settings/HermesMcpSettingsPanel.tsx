import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Store,
  Terminal,
  Trash2,
} from 'lucide-react';
import {
  fetchHermesMcpServers,
  fetchHermesMcpCatalog,
  installHermesMcpServer,
  uninstallHermesMcpServer,
  HermesApiError,
  type HermesMcpServerInfo,
  type HermesMcpCatalogEntry,
} from '@/lib/hermes-api';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { useHermesMcpToolIndex } from '@/hooks/useHermesMcpToolIndex';
import { McpToolIndexPanel, McpToolThresholdChip } from '@/components/mcp/McpToolIndexPanel';
import {
  fetchToolSearchConfig,
  updateToolSearchConfig,
  type ToolSearchConfig,
} from '@/lib/hermes-api';

function TransportBadge({ transport }: { transport: 'stdio' | 'http' }) {
  const Icon = transport === 'http' ? Network : Terminal;
  return (
    <span className="inline-flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#1a1a1a] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/50">
      <Icon className="h-2.5 w-2.5" />
      {transport === 'http' ? 'HTTP' : 'Stdio'}
    </span>
  );
}

function ServerRow({
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
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d]">
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'inline-block h-2 w-2 shrink-0 rounded-full',
              server.enabled
                ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]'
                : 'bg-muted-foreground/40',
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm text-foreground">{server.name}</span>
              <TransportBadge transport={server.transport} />
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground/60" title={endpoint}>
              {endpoint}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[10px] text-muted-foreground/60">
            {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
          </span>
          <ChevronDown
            className={cn(
              'h-3 w-3 text-muted-foreground/40 transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[#2a2a2a] px-3 pb-2.5 pt-2">
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/50">
            <span
              className={cn(
                'rounded border px-2 py-0.5',
                server.enabled
                  ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400/80'
                  : 'border-[#2a2a2a] bg-[#1a1a1a] text-muted-foreground/60',
              )}
            >
              {server.enabled ? 'Enabled in config.yaml' : 'Disabled in config.yaml'}
            </span>
            {server.env_keys.length > 0 && (
              <span title={server.env_keys.join(', ')}>
                {server.env_keys.length} env var{server.env_keys.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {removable ? (
            <button
              type="button"
              onClick={onUninstall}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Uninstall
            </button>
          ) : (
            <span className="text-[10px] text-muted-foreground/40">Agent-managed (read-only)</span>
          )}
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
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{entry.name}</span>
            <TransportBadge transport={entry.transport} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-muted-foreground/50">
            {entry.description}
          </p>
          {error && <p className="mt-1 text-[10px] text-red-400/80">{error}</p>}
        </div>
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition-opacity hover:bg-primary/90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Install
        </button>
      </div>
    </div>
  );
}

export function HermesMcpSettingsPanel({
  fieldLabelClass,
  settingsCardClass,
}: {
  fieldLabelClass: string;
  settingsCardClass: string;
}) {
  const setMcpStoreFullscreen = useUIStore((s) => s.setMcpStoreFullscreen);

  const { reload: reloadToolIndex, ...toolIndex } = useHermesMcpToolIndex();
  const [servers, setServers] = useState<HermesMcpServerInfo[]>([]);
  const [catalog, setCatalog] = useState<HermesMcpCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [toolSearch, setToolSearch] = useState<ToolSearchConfig | null>(null);
  const [toolSearchSaving, setToolSearchSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, c] = await Promise.all([fetchHermesMcpServers(), fetchHermesMcpCatalog()]);
      setServers(s);
      setCatalog(c);
      await reloadToolIndex();
    } catch (err) {
      setLoadError(err instanceof HermesApiError ? err.message : 'Could not reach the Hermes bridge.');
    } finally {
      setLoading(false);
    }
  }, [reloadToolIndex]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void fetchToolSearchConfig()
      .then(setToolSearch)
      .catch(() => setToolSearch(null));
  }, []);

  const stats = useMemo(() => {
    const enabled = servers.filter((s) => s.enabled).length;
    const totalTools = toolIndex.totalTools || servers.reduce((sum, s) => sum + s.tool_count, 0);
    return { total: servers.length, enabled, totalTools };
  }, [servers, toolIndex.totalTools]);

  const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
  const quickInstall = useMemo(
    () => catalog.filter((e) => !installedNames.has(e.name)).slice(0, 3),
    [catalog, installedNames],
  );

  const handleInstall = useCallback(async (id: string) => {
    setBusyId(id);
    setInstallErrors((e) => ({ ...e, [id]: '' }));
    try {
      await installHermesMcpServer(id);
      await reload();
    } catch (err) {
      setInstallErrors((e) => ({
        ...e,
        [id]: err instanceof HermesApiError ? err.message : 'Install failed',
      }));
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const handleUninstall = useCallback(async (name: string) => {
    if (!confirm(`Uninstall the "${name}" MCP server from hermes-agent config?`)) return;
    setBusyId(name);
    try {
      await uninstallHermesMcpServer(name);
      if (expandedName === name) setExpandedName(null);
      await reload();
    } catch (err) {
      setLoadError(err instanceof HermesApiError ? err.message : 'Uninstall failed');
    } finally {
      setBusyId(null);
    }
  }, [expandedName, reload]);

  const toggleToolSearch = async () => {
    if (!toolSearch) return;
    setToolSearchSaving(true);
    try {
      setToolSearch(await updateToolSearchConfig({ defer: !toolSearch.defer }));
    } finally {
      setToolSearchSaving(false);
    }
  };

  return (
    <div className={cn(settingsCardClass, 'space-y-3 px-5 py-5')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={fieldLabelClass}>MCP Servers</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Installed in Hermes <span className="font-mono text-[11px]">config.yaml</span> — same
            source as the sidebar MCP panel and store.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMcpStoreFullscreen(true)}
            className="inline-flex items-center gap-1 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-[#3a3a3a] hover:text-foreground"
          >
            <Store className="h-3 w-3" />
            Store
          </button>
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#2a2a2a] bg-[#1a1a1a] text-muted-foreground transition-colors hover:border-[#3a3a3a] hover:text-foreground disabled:opacity-40"
            title="Refresh from config.yaml"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {stats.total > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/60">
          <span>
            {stats.enabled}/{stats.total} enabled · {stats.totalTools} tools
          </span>
          <McpToolThresholdChip total={stats.totalTools} threshold={toolIndex.threshold} />
        </div>
      )}

      {toolSearch && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs text-foreground">Defer MCP schemas (tool search)</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/55">
              Maps to Hermes <span className="font-mono">tools.tool_search</span> — agent uses
              on-demand discovery when tool context is large.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={toolSearch.defer}
            disabled={toolSearchSaving}
            onClick={() => void toggleToolSearch()}
            className={cn(
              'relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring',
              toolSearch.defer ? 'bg-primary' : 'bg-[#333333]',
              toolSearchSaving && 'opacity-50',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-200',
                toolSearch.defer ? 'translate-x-[20px]' : 'translate-x-[3px]',
              )}
            />
          </button>
        </div>
      )}

      {(toolIndex.tools.length > 0 || toolIndex.loading) && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2.5">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45">
            Tool index
          </p>
          <McpToolIndexPanel
            tools={toolIndex.filteredTools}
            total={toolIndex.totalTools}
            threshold={toolIndex.threshold}
            query={toolIndex.query}
            onQueryChange={toolIndex.setQuery}
            loading={toolIndex.loading}
            maxHeightClass="max-h-56"
          />
        </div>
      )}

      {loadError && (
        <div className="flex items-start gap-1.5 rounded-md border border-red-500/20 bg-red-500/8 px-2.5 py-2 text-xs text-red-300/80">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">{loadError}</span>
        </div>
      )}

      {loading && servers.length === 0 && (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading MCP servers…
        </div>
      )}

      {!loading && servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-[#2a2a2a] px-4 py-6 text-center">
          <Network className="mx-auto h-5 w-5 text-muted-foreground/30" />
          <p className="mt-2 text-xs font-medium text-muted-foreground/70">No MCP servers in config</p>
          <p className="mt-1 text-[11px] text-muted-foreground/50">
            Install from the catalog — the agent loads tools from config.yaml automatically.
          </p>
          <button
            type="button"
            onClick={() => setMcpStoreFullscreen(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/25"
          >
            <Store className="h-3 w-3" />
            Open MCP store
          </button>
        </div>
      )}

      {servers.length > 0 && (
        <div className="space-y-2">
          {servers.map((server) => (
            <ServerRow
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
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/45">
            Quick install
          </p>
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
        <p className="flex items-center gap-1 text-[10px] text-muted-foreground/40">
          <Plug className="h-2.5 w-2.5" />
          Agent discovers MCP from config — no Spark-side injection.
        </p>
      )}
    </div>
  );
}
