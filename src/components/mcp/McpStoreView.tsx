import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Minimize2,
  Loader2,
  RefreshCw,
  Plug,
  PlugZap,
  Network,
  Terminal,
  Wrench,
  Check,
  Plus,
  Trash2,
  ExternalLink,
  AlertCircle,
  FolderTree,
  Globe,
  GitBranch,
  Brain,
  ListTree,
  MousePointerClick,
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
import { cn } from '@/lib/utils';

const ACCENT = '#ff8f3f';

const CATALOG_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  filesystem: FolderTree,
  fetch: Globe,
  git: GitBranch,
  memory: Brain,
  'sequential-thinking': ListTree,
  playwright: MousePointerClick,
};

function TransportBadge({ transport }: { transport: 'stdio' | 'http' }) {
  const Icon = transport === 'http' ? Network : Terminal;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground/70">
      <Icon className="h-2.5 w-2.5" />
      {transport === 'http' ? 'HTTP' : 'Stdio'}
    </span>
  );
}

// ── Installed server card ───────────────────────────────────────────────────

function InstalledCard({
  server,
  onUninstall,
  busy,
}: {
  server: HermesMcpServerInfo;
  onUninstall: () => void;
  busy: boolean;
}) {
  const removable = !!server.catalog_id;
  return (
    <div className="flex flex-col rounded-xl border border-border/30 bg-background/30 p-3.5 transition-colors hover:border-[#ff8f3f]/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'inline-block h-2 w-2 shrink-0 rounded-full',
              server.enabled ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.45)]' : 'bg-muted-foreground/40',
            )}
          />
          <span className="truncate text-[13px] font-medium text-foreground">{server.name}</span>
        </div>
        <TransportBadge transport={server.transport} />
      </div>

      <code className="mt-2 block truncate font-mono text-[10px] text-muted-foreground/50" title={`${server.command} ${server.args.join(' ')}`}>
        {server.command} {server.args.join(' ')}
      </code>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
          <span className="inline-flex items-center gap-1">
            <Wrench className="h-2.5 w-2.5" />
            {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
          </span>
          {server.env_keys.length > 0 && (
            <span className="truncate" title={server.env_keys.join(', ')}>
              · {server.env_keys.length} env
            </span>
          )}
        </div>
        {removable ? (
          <button
            onClick={onUninstall}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-medium text-red-400/70 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
            Uninstall
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground/40">agent-managed</span>
        )}
      </div>
    </div>
  );
}

// ── Available (installable) catalog card ────────────────────────────────────

function AvailableCard({
  entry,
  onInstall,
  busy,
  error,
}: {
  entry: HermesMcpCatalogEntry;
  onInstall: (param?: string) => void;
  busy: boolean;
  error?: string;
}) {
  const Icon = CATALOG_ICONS[entry.id] || Plug;
  const [showParam, setShowParam] = useState(false);
  const [param, setParam] = useState(entry.requires_param?.default ?? '');

  const handleClick = () => {
    if (entry.requires_param && !showParam) {
      setShowParam(true);
      return;
    }
    onInstall(entry.requires_param ? param.trim() || entry.requires_param.default : undefined);
  };

  return (
    <div className="flex flex-col rounded-xl border border-border/30 bg-background/30 p-3.5 transition-colors hover:border-[#ff8f3f]/30">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ff8f3f]/12">
          <Icon className="h-4 w-4 text-[#ff8f3f]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">{entry.name}</span>
            <TransportBadge transport={entry.transport} />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">{entry.description}</p>
        </div>
      </div>

      {showParam && entry.requires_param && (
        <div className="mt-2.5">
          <label className="mb-1 block text-[10px] font-medium text-muted-foreground/60">{entry.requires_param.label}</label>
          <input
            value={param}
            onChange={(e) => setParam(e.target.value)}
            placeholder={entry.requires_param.placeholder}
            autoFocus
            className="w-full rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-[#ff8f3f]/40"
          />
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-500/20 bg-red-500/8 px-2 py-1.5 text-[10px] text-red-300/80">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        {entry.docs_url ? (
          <a
            href={entry.docs_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/45 transition-colors hover:text-foreground"
          >
            <ExternalLink className="h-2.5 w-2.5" />
            Docs
          </a>
        ) : (
          <span />
        )}
        <button
          onClick={handleClick}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#ff8f3f] px-3 py-1.5 text-[11px] font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          {showParam && entry.requires_param ? 'Confirm install' : 'Install'}
        </button>
      </div>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

export function McpStoreView({ onExitFullscreen }: { onExitFullscreen?: () => void } = {}) {
  const [servers, setServers] = useState<HermesMcpServerInfo[]>([]);
  const [catalog, setCatalog] = useState<HermesMcpCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [s, c] = await Promise.all([fetchHermesMcpServers(), fetchHermesMcpCatalog()]);
      setServers(s);
      setCatalog(c);
    } catch (err) {
      setLoadError(err instanceof HermesApiError ? err.message : 'Could not reach the bridge.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installedNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers]);
  const available = useMemo(() => catalog.filter((e) => !installedNames.has(e.name)), [catalog, installedNames]);

  const handleInstall = useCallback(
    async (id: string, param?: string) => {
      setBusyId(id);
      setErrors((e) => ({ ...e, [id]: '' }));
      try {
        await installHermesMcpServer(id, param);
        await reload();
      } catch (err) {
        setErrors((e) => ({ ...e, [id]: err instanceof HermesApiError ? err.message : 'Install failed' }));
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const handleUninstall = useCallback(
    async (name: string) => {
      if (!confirm(`Uninstall the "${name}" MCP server from your hermes-agent?`)) return;
      setBusyId(name);
      try {
        await uninstallHermesMcpServer(name);
        await reload();
      } catch (err) {
        setLoadError(err instanceof HermesApiError ? err.message : 'Uninstall failed');
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <PlugZap className="h-4 w-4" style={{ color: ACCENT }} />
          <span className="text-[13px] font-semibold text-foreground">MCP Store</span>
          <span className="text-[11px] font-mono text-muted-foreground/50">{servers.length} installed</span>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
          <button
            onClick={() => void reload()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {onExitFullscreen && (
            <button
              onClick={onExitFullscreen}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-background/85 hover:text-foreground"
              title="Exit fullscreen — back to chat"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Exit fullscreen
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto max-w-5xl space-y-8">
          {loadError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-3 py-2.5 text-[12px] text-red-300/80">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {loadError}
            </div>
          )}

          {/* Installed */}
          <section>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Installed</h2>
              <span className="text-[11px] text-muted-foreground/40">{servers.length}</span>
            </div>
            {servers.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/40 py-10">
                <Network className="mb-2 h-6 w-6 text-muted-foreground/30" />
                <p className="text-[12px] text-muted-foreground/50">No MCP servers installed for your hermes-agent yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {servers.map((s) => (
                  <InstalledCard
                    key={s.name}
                    server={s}
                    busy={busyId === s.name}
                    onUninstall={() => void handleUninstall(s.name)}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Available */}
          <section>
            <div className="mb-1 flex items-baseline gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">Available to install</h2>
              <span className="text-[11px] text-muted-foreground/40">{available.length}</span>
            </div>
            <p className="mb-3 text-[11px] text-muted-foreground/45">
              A hand-picked starter set. Installing adds the server to your agent's config and reloads it.
            </p>
            {available.length === 0 && !loading ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/40 py-8 text-[12px] text-muted-foreground/50">
                <Check className="h-4 w-4" style={{ color: ACCENT }} />
                Everything in the catalog is already installed.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {available.map((e) => (
                  <AvailableCard
                    key={e.id}
                    entry={e}
                    busy={busyId === e.id}
                    error={errors[e.id]}
                    onInstall={(param) => void handleInstall(e.id, param)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
