import { useState } from 'react';
import {
  Activity,
  Archive,
  Brain,
  ExternalLink,
  HardDrive,
  Cable,
  KeyRound,
  Loader2,
  Monitor,
  Package,
  PawPrint,
  Plug,
  RefreshCw,
  Scissors,
  Shield,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { fetchSkillBundle, type CheckpointEntry, type HermesPlugin, type SkillBundle } from '@/lib/hermes-api';
import {
  useCheckpoints,
  useComputerUseStatus,
  useCreateSkillBundle,
  useCuratorStatus,
  useDeleteSkillBundle,
  useDoctorComputerUse,
  useDoctorHooks,
  useGatewayCapabilities,
  useHermesDashboardUrl,
  useHooksStatus,
  useInsights,
  useInstallComputerUse,
  useLspStatus,
  useMemoryStatus,
  usePetsGallery,
  usePetsStatus,
  usePluginsStatus,
  usePruneCheckpoints,
  useReloadSkillBundles,
  useRestoreCheckpoint,
  useRunCurator,
  useSecretsStatus,
  useSecurityAudit,
  useSelectPet,
  useSkillBundles,
  useTogglePlugin,
} from '@/lib/hermes-queries';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { openExternalUrl } from '@/lib/open-external';
import { cn } from '@/lib/utils';
import { useHermesStore } from '@/stores/hermes-store';
import { HermesProjectsSwitcher } from './HermesProjectsSwitcher';

const PLUGINS_LIMIT = 120;

/**
 * Dense ops cards for the System sidebar — memory provider, checkpoints,
 * curator, computer-use, bundles, and usage insights.
 */
export function HermesOpsExtras() {
  // Every status source degrades to its "Unavailable" copy on failure, so
  // query errors are deliberately not surfaced here — `error` is reserved for
  // the action handlers below, the only failures the user needs to see.
  const memoryQuery = useMemoryStatus();
  const checkpointsQuery = useCheckpoints();
  const curatorQuery = useCuratorStatus();
  const computerQuery = useComputerUseStatus();
  const gatewayQuery = useGatewayCapabilities();
  const primaryQueries = [memoryQuery, checkpointsQuery, curatorQuery, computerQuery, gatewayQuery];
  // The secondary cards (several are slow CLI shell-outs) wait for the primary
  // batch so the cards that matter most paint first.
  const primarySettled = primaryQueries.every((q) => !q.isPending || q.fetchStatus === 'idle');
  const secondary = { enabled: primarySettled };
  const bundlesQuery = useSkillBundles(secondary);
  const insightsQuery = useInsights(7, secondary);
  const petsQuery = usePetsStatus(secondary);
  const pluginsQuery = usePluginsStatus(PLUGINS_LIMIT, secondary);
  const hooksQuery = useHooksStatus(secondary);
  const lspQuery = useLspStatus(secondary);
  const secretsQuery = useSecretsStatus(secondary);
  const dashboardQuery = useHermesDashboardUrl(secondary);

  const memory = memoryQuery.data ?? null;
  const checkpoints = checkpointsQuery.data ?? null;
  const curator = curatorQuery.data ?? null;
  const computer = computerQuery.data ?? null;
  const gateway = gatewayQuery.data ?? null;
  const bundles = bundlesQuery.data ?? [];
  const insights = insightsQuery.data ?? '';
  const pets = petsQuery.data ?? null;
  const pluginsStatus = pluginsQuery.data ?? null;
  const plugins = pluginsStatus?.plugins ?? [];
  const pluginsSummary = pluginsStatus
    ? { total: pluginsStatus.total, enabled: pluginsStatus.enabled_count }
    : null;
  const hooks = hooksQuery.data ?? null;
  const lsp = lspQuery.data ?? null;
  const secrets = secretsQuery.data ?? null;
  const dashboardUrl = dashboardQuery.data ?? null;
  const loading = primaryQueries.some((q) => q.isFetching);

  const pruneMutation = usePruneCheckpoints();
  const restoreMutation = useRestoreCheckpoint();
  const curatorMutation = useRunCurator();
  const installCuMutation = useInstallComputerUse();
  const doctorCuMutation = useDoctorComputerUse();
  const doctorHooksMutation = useDoctorHooks();
  const togglePluginMutation = useTogglePlugin(PLUGINS_LIMIT);
  const securityMutation = useSecurityAudit();
  const selectPetMutation = useSelectPet();
  const createBundleMutation = useCreateSkillBundle();
  const deleteBundleMutation = useDeleteSkillBundle();
  const reloadBundlesMutation = useReloadSkillBundles();
  const security = securityMutation.data ?? null;

  const [bundlesOpen, setBundlesOpen] = useState(false);
  const [bundleDetail, setBundleDetail] = useState<SkillBundle | null>(null);
  const [bundleName, setBundleName] = useState('');
  const [bundleSkills, setBundleSkills] = useState('');
  const [doctorReport, setDoctorReport] = useState<string>('');
  const [hooksReport, setHooksReport] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  /** Last action failure, or a client-side validation message. */
  const [error, setError] = useState<unknown>(null);
  const [petsOpen, setPetsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [petId, setPetId] = useState('');
  const petGallery = usePetsGallery(24, { enabled: petsOpen }).data ?? [];
  const useRuns = useHermesStore((s) => s.useRuns);
  const setUseRuns = useHermesStore((s) => s.setUseRuns);
  const computerEnabled = useHermesStore((s) => s.toolsets.computer);
  const chatTransportLabel = useRuns
    ? computerEnabled
      ? 'runs requested (blocked by Computer Use → agent-loop)'
      : 'runs (gateway when request supports it)'
    : 'agent-loop (default)';

  const load = () => {
    setError(null);
    for (const q of [
      ...primaryQueries,
      bundlesQuery, insightsQuery, petsQuery, pluginsQuery, hooksQuery, lspQuery, secretsQuery, dashboardQuery,
    ]) {
      void q.refetch();
    }
  };

  /** Run one action with the shared busy/error bookkeeping. */
  const runAction = async (key: string, action: () => Promise<unknown>, clearError = true) => {
    setBusy(key);
    if (clearError) setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const onPrune = () => runAction('prune', () => pruneMutation.mutateAsync(), false);

  const onRestore = (entry: CheckpointEntry) =>
    runAction(`restore-${entry.index}`, () =>
      restoreMutation.mutateAsync({ index: entry.index, workdir: checkpoints?.workdir ?? undefined }),
    );

  const onCurator = () => runAction('curator', () => curatorMutation.mutateAsync(), false);

  const onInstallCu = () =>
    runAction('cu-install', async () => {
      const res = await installCuMutation.mutateAsync();
      setDoctorReport(res.output || '');
    }, false);

  const onDoctorCu = () =>
    runAction('cu-doctor', async () => {
      const res = await doctorCuMutation.mutateAsync();
      setDoctorReport(res.report || '');
    }, false);

  const onDoctorHooks = () =>
    runAction('hooks-doctor', async () => {
      const res = await doctorHooksMutation.mutateAsync();
      setHooksReport(res.report || '');
    });

  const onTogglePlugin = (plugin: HermesPlugin) =>
    runAction(`plugin-${plugin.name}`, () => togglePluginMutation.mutateAsync(plugin));

  const onSecurityAudit = () => runAction('security', () => securityMutation.mutateAsync());

  const onSelectPet = async (id?: string) => {
    const chosen = (id ?? petId).trim();
    if (!chosen) {
      setError('Enter a pet id');
      return;
    }
    await runAction('pet', async () => {
      await selectPetMutation.mutateAsync(chosen);
      setPetId('');
    });
  };

  const onOpenDashboard = () => {
    const url = dashboardUrl || 'http://127.0.0.1:9119';
    openExternalUrl(url);
  };

  const onShowBundle = (name: string) =>
    runAction(`bundle-show-${name}`, async () => {
      const res = await fetchSkillBundle(name);
      if (!res.ok || !res.bundle) {
        throw new Error(res.error || 'Bundle not found');
      }
      setBundleDetail(res.bundle);
      setBundlesOpen(true);
    });

  const onCreateBundle = async () => {
    const name = bundleName.trim();
    const skills = bundleSkills
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name || !skills.length) {
      setError('Bundle name and at least one skill id required');
      return;
    }
    await runAction('bundle-create', async () => {
      const res = await createBundleMutation.mutateAsync({ name, skills });
      setBundleName('');
      setBundleSkills('');
      setBundleDetail(res.bundle);
    });
  };

  const onDeleteBundle = (name: string) =>
    runAction(`bundle-del-${name}`, async () => {
      await deleteBundleMutation.mutateAsync(name);
      if (bundleDetail?.name === name) {
        setBundleDetail(null);
      }
    });

  const onReloadBundles = () => runAction('bundle-reload', () => reloadBundlesMutation.mutateAsync());

  if (memoryQuery.isPending && checkpointsQuery.isPending) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground/60">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading ops…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/50">
          Hermes ops
        </span>
        <button
          type="button"
          onClick={load}
          className="rounded p-1 text-muted-foreground/50 hover:text-foreground"
          title="Refresh ops"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>

      <HermesErrorState error={error} variant="inline" />

      <HermesProjectsSwitcher />

      {dashboardUrl && (
        <OpsCard
          icon={ExternalLink}
          title="Hermes dashboard"
          body={dashboardUrl.replace(/^https?:\/\//, '')}
          actionLabel="Open"
          onAction={onOpenDashboard}
        />
      )}

      <OpsCard
        icon={KeyRound}
        title="Secrets managers"
        body={
          secrets
            ? secrets.any_enabled
              ? `${secrets.providers.filter((p) => p.enabled).map((p) => p.label).join(', ')} enabled`
              : secrets.any_configured
                ? `${secrets.providers.filter((p) => p.configured).map((p) => p.label).join(', ')} configured`
                : 'Bitwarden / 1Password not configured'
            : 'Unavailable'
        }
      />

      {secrets && secrets.providers.length > 0 && (
        <ul className="space-y-1 rounded-md border border-border/40 bg-background/40 p-2.5">
          {secrets.providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70"
            >
              <span className="font-medium text-foreground/80">{provider.label}</span>
              <span className="truncate font-mono text-[9px]">
                {provider.enabled ? 'enabled' : provider.configured ? 'configured' : 'off'}
                {provider.token_in_env ? ' · token in env' : ''}
                {provider.binary ? ` · ${provider.binary}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      <OpsCard
        icon={Shield}
        title="Security audit"
        body={
          security
            ? security.finding_count
              ? `${security.finding_count} finding${security.finding_count === 1 ? '' : 's'} · ${security.total_components_scanned} scanned · C${security.severity_counts.critical ?? 0} H${security.severity_counts.high ?? 0}`
              : security.total_components_scanned
                ? `${security.total_components_scanned} components · clean`
                : security.summary
                  ? 'Audit complete (see report)'
                  : 'No findings'
            : 'Run OSV vulnerability scan'
        }
        actionLabel={busy === 'security' ? 'Scanning…' : security ? 'Rescan' : 'Run audit'}
        onAction={() => void onSecurityAudit()}
        actionDisabled={busy === 'security'}
      />

      {security && security.findings.length > 0 && (
        <ul className="max-h-36 space-y-1 overflow-auto rounded-md border border-border/40 bg-background/40 p-2.5">
          {security.findings.slice(0, 8).map((finding) => (
            <li key={`${finding.vuln_id}-${finding.package}`} className="text-[10px] text-muted-foreground/70">
              <span
                className={cn(
                  'mr-1 font-mono text-[9px] uppercase',
                  finding.severity === 'CRITICAL' || finding.severity === 'HIGH'
                    ? 'text-red-400/90'
                    : 'text-amber-400/80',
                )}
              >
                {finding.severity}
              </span>
              <span className="font-mono text-foreground/80">{finding.package}</span>
              {finding.version ? `@${finding.version}` : ''}
              {finding.summary ? (
                <span className="text-muted-foreground/55"> · {finding.summary.slice(0, 100)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {security?.summary && !security.findings.length && (
        <pre className="max-h-24 overflow-auto rounded-md border border-border/40 bg-background/40 p-2 font-mono text-[10px] text-muted-foreground/70 whitespace-pre-wrap">
          {security.summary.slice(0, 1200)}
        </pre>
      )}

      <OpsCard
        icon={Brain}
        title="Memory"
        body={
          memory
            ? `Provider: ${memory.provider || 'built-in only'}${
                memory.plugin_available === false ? ' · plugin unavailable' : ''
              }`
            : 'Unavailable'
        }
      />

      <OpsCard
        icon={HardDrive}
        title="Checkpoints"
        body={
          checkpoints
            ? `${checkpoints.total_size || '—'} · ${checkpoints.projects?.length ?? 0} projects${
                checkpoints.entries?.length
                  ? ` · ${checkpoints.entries.length} restorable`
                  : checkpoints.workdir
                    ? ' · none for workdir'
                    : ''
              }`
            : 'Unavailable'
        }
        actionLabel={busy === 'prune' ? 'Pruning…' : 'Prune'}
        onAction={checkpoints?.available ? () => void onPrune() : undefined}
        actionDisabled={busy === 'prune'}
      />

      <OpsCard
        icon={Sparkles}
        title="Curator"
        body={
          curator
            ? `${curator.enabled ? 'On' : 'Off'} · last ${curator.last_run || 'never'} · ${curator.runs ?? 0} runs`
            : 'Unavailable'
        }
        actionLabel={busy === 'curator' ? 'Running…' : 'Run now'}
        onAction={() => void onCurator()}
        actionDisabled={busy === 'curator'}
      />

      <OpsCard
        icon={Monitor}
        title="Computer use"
        body={
          computer
            ? computer.installed
              ? 'cua-driver installed'
              : 'Not installed — install or doctor below'
            : 'Unavailable'
        }
        actionLabel={
          busy === 'cu-install'
            ? 'Installing…'
            : computer?.installed
              ? busy === 'cu-doctor'
                ? 'Doctor…'
                : 'Doctor'
              : 'Install'
        }
        onAction={
          computer?.installed
            ? () => void onDoctorCu()
            : () => void onInstallCu()
        }
        actionDisabled={busy === 'cu-install' || busy === 'cu-doctor'}
      />

      <OpsCard
        icon={Plug}
        title="Plugins"
        body={
          pluginsSummary
            ? `${pluginsSummary.enabled}/${pluginsSummary.total} enabled`
            : plugins.length
              ? `${plugins.filter((p) => p.enabled).length}/${plugins.length} enabled`
              : 'Unavailable'
        }
        actionLabel={pluginsOpen ? 'Hide' : 'Show'}
        onAction={() => setPluginsOpen((o) => !o)}
      />

      {pluginsOpen && plugins.length > 0 && (
        <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
          <ul className="max-h-40 space-y-1 overflow-auto">
            {plugins.slice(0, 24).map((plugin) => (
              <li
                key={plugin.name}
                className="flex items-center justify-between gap-2 rounded border border-border/30 bg-background/30 px-2 py-1"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-[10px] text-foreground/85">{plugin.name}</div>
                  <div className="truncate text-[10px] text-muted-foreground/55">
                    {plugin.enabled ? 'enabled' : plugin.status}
                    {plugin.source ? ` · ${plugin.source}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onTogglePlugin(plugin)}
                  disabled={busy === `plugin-${plugin.name}`}
                  className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {busy === `plugin-${plugin.name}` ? '…' : plugin.enabled ? 'Off' : 'On'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <OpsCard
        icon={Cable}
        title="Shell hooks"
        body={
          hooks
            ? `${hooks.total} configured${hooks.issue_hints ? ` · ${hooks.issue_hints} warning${hooks.issue_hints === 1 ? '' : 's'}` : ''}`
            : 'Unavailable'
        }
        actionLabel={busy === 'hooks-doctor' ? 'Doctor…' : 'Doctor'}
        onAction={() => void onDoctorHooks()}
        actionDisabled={busy === 'hooks-doctor'}
      />

      {hooks && hooks.hooks.length > 0 && (
        <ul className="space-y-1 rounded-md border border-border/40 bg-background/40 p-2.5">
          {hooks.hooks.slice(0, 6).map((hook) => (
            <li key={`${hook.event}-${hook.command}`} className="text-[10px] text-muted-foreground/70">
              <span className="font-mono text-foreground/75">[{hook.event}]</span>{' '}
              {hook.command.replace(/^\/Users\/[^/]+/, '~')}
              {hook.allowed ? '' : ' · not allowed'}
              {hook.warning ? (
                <span className="text-amber-400/80"> · {hook.warning}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {hooksReport && (
        <pre className="max-h-28 overflow-auto rounded-md border border-border/40 bg-background/40 p-2 font-mono text-[10px] text-muted-foreground/70 whitespace-pre-wrap">
          {hooksReport.slice(0, 2000)}
        </pre>
      )}

      <OpsCard
        icon={Stethoscope}
        title="LSP"
        body={
          lsp
            ? `${lsp.enabled ? 'On' : 'Off'} · ${lsp.installed_count} installed · ${lsp.active_clients} active${
                lsp.missing_count ? ` · ${lsp.missing_count} missing` : ''
              }`
            : 'Unavailable'
        }
      />

      {doctorReport && (
        <pre className="max-h-28 overflow-auto rounded-md border border-border/40 bg-background/40 p-2 font-mono text-[10px] text-muted-foreground/70 whitespace-pre-wrap">
          {doctorReport.slice(0, 2000)}
        </pre>
      )}

      <div className="rounded-md border border-border/40 bg-background/40">
        <button
          type="button"
          onClick={() => {
            setPetsOpen((open) => !open);
          }}
          aria-expanded={petsOpen}
          className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
              <PawPrint className="h-3 w-3 shrink-0" />
              Pets
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground/70">
              {pets
                ? pets.configured || pets.show
                  ? pets.show || pets.config.name || 'Active pet'
                  : 'No pet selected'
                : 'Unavailable'}
            </p>
          </div>
          <span className="text-[10px] text-muted-foreground/50">{petsOpen ? 'Hide' : 'Show'}</span>
        </button>
        {petsOpen && (
          <div className="space-y-1.5 border-t border-border/30 px-2.5 py-2">
            {petGallery.length > 0 && (
              <ul className="max-h-28 space-y-1 overflow-auto">
                {petGallery.slice(0, 12).map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => void onSelectPet(entry.id)}
                      disabled={busy === 'pet'}
                      className="flex w-full items-center justify-between gap-2 rounded border border-border/30 bg-background/30 px-2 py-1 text-left hover:border-border/50 disabled:opacity-50"
                    >
                      <span className="truncate font-mono text-[10px] text-foreground/85">{entry.id}</span>
                      <span className="truncate text-[10px] text-muted-foreground/55">
                        {entry.label || entry.kind}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              value={petId}
              onChange={(e) => setPetId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSelectPet();
              }}
              placeholder="pet id (e.g. boba)"
              className="w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary/30"
            />
            <button
              type="button"
              onClick={() => void onSelectPet()}
              disabled={busy === 'pet' || !petId.trim()}
              className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {busy === 'pet' ? 'Selecting…' : 'Select pet'}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/40 bg-background/40">
        <button
          type="button"
          onClick={() => setBundlesOpen((o) => !o)}
          aria-expanded={bundlesOpen}
          className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
              <Package className="h-3 w-3 shrink-0" />
              Skill bundles
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground/70">
              {bundles.length
                ? `${bundles.length} installed · ${bundles.map((b) => b.name).join(', ')}`
                : 'None installed'}
            </p>
          </div>
          <span className="text-[10px] text-muted-foreground/50">{bundlesOpen ? 'Hide' : 'Show'}</span>
        </button>
        {bundlesOpen && (
          <div className="space-y-1.5 border-t border-border/30 px-2.5 py-2">
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={() => void onReloadBundles()}
                disabled={busy === 'bundle-reload'}
                className="rounded border border-border/40 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {busy === 'bundle-reload' ? '…' : 'Reload'}
              </button>
            </div>
            {bundles.length > 0 && (
              <ul className="max-h-32 space-y-1 overflow-auto">
                {bundles.map((bundle) => (
                  <li
                    key={bundle.path}
                    className="flex items-center justify-between gap-2 rounded border border-border/30 bg-background/30 px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => void onShowBundle(bundle.name)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate font-mono text-[10px] text-foreground/85">/{bundle.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground/55">
                        {bundle.skills.length ? bundle.skills.join(', ') : 'no skills'}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDeleteBundle(bundle.name)}
                      disabled={busy === `bundle-del-${bundle.name}`}
                      className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      {busy === `bundle-del-${bundle.name}` ? '…' : 'Del'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {bundleDetail && (
              <div className="rounded border border-border/30 bg-background/25 p-2 text-[10px] text-muted-foreground/70">
                <div className="font-mono text-foreground/85">/{bundleDetail.name}</div>
                {bundleDetail.description ? (
                  <p className="mt-1 leading-snug">{bundleDetail.description}</p>
                ) : null}
                <ul className="mt-1 space-y-0.5">
                  {bundleDetail.skills.map((skill) => (
                    <li key={skill} className="font-mono text-[9px]">· {skill}</li>
                  ))}
                </ul>
              </div>
            )}
            <input
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              placeholder="bundle name (slash command)"
              className="w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary/30"
            />
            <input
              value={bundleSkills}
              onChange={(e) => setBundleSkills(e.target.value)}
              placeholder="skill ids (comma-separated)"
              className="w-full rounded-md border border-border/40 bg-background/60 px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary/30"
            />
            <button
              type="button"
              onClick={() => void onCreateBundle()}
              disabled={busy === 'bundle-create' || !bundleName.trim() || !bundleSkills.trim()}
              className="rounded-md border border-border/40 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {busy === 'bundle-create' ? 'Creating…' : 'Create bundle'}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
              <Activity className="h-3 w-3 shrink-0" />
              Gateway /v1
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground/75">
              {gateway
                ? gateway.reachable
                  ? `chat default: ${chatTransportLabel} · gateway reports runs=${gateway.run_submission ? 'yes' : 'no'} · ${gateway.base_url}`
                  : `Unreachable · ${gateway.error || 'start hermes gateway'}`
                : 'Unavailable'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setUseRuns(!useRuns)}
            aria-pressed={useRuns}
            title={
              useRuns
                ? 'Using gateway /v1/runs when the request supports it (Computer Use is disabled while Runs is on)'
                : 'Use gateway /v1/runs for Hermes chat when the request supports it. Enabling this turns off Computer Use.'
            }
            className={cn(
              'shrink-0 rounded-md border px-2 py-1 text-[10px] transition-colors',
              useRuns
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border/50 text-muted-foreground hover:text-foreground',
            )}
          >
            Runs
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground/55">
          {useRuns
            ? 'Runs is on — Computer Use stays off so chat can use the gateway. Repo-mode, custom tools, and other parity gaps still fall back to the agent loop.'
            : 'Use gateway /v1/runs when the request supports it. Enabling Runs turns off Computer Use (no screenshots on the runs path).'}
          {' '}
          Mid-turn reconnect still uses background partial polling; the /api/hermes/chat/stream resume buffer is server-ready but not wired into the AI SDK chat client yet.
        </p>
      </div>

      {insights && (
        <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
            <Scissors className="h-3 w-3" />
            Insights (7d)
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-muted-foreground/70">
            {insights.slice(0, 2500)}
          </pre>
        </div>
      )}

      {checkpoints && checkpoints.entries && checkpoints.entries.length > 0 && (
        <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
              <Archive className="h-3 w-3 shrink-0" />
              Restore
            </div>
            {checkpoints.workdir && (
              <span
                className="truncate font-mono text-[9px] text-muted-foreground/45"
                title={checkpoints.workdir}
              >
                {checkpoints.workdir.replace(/^\/Users\/[^/]+/, '~')}
              </span>
            )}
          </div>
          <ul className="space-y-1">
            {checkpoints.entries.slice(0, 8).map((entry) => (
              <li
                key={`${entry.index}-${entry.path}`}
                className="flex items-center justify-between gap-2 rounded border border-border/30 bg-background/30 px-2 py-1"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-[10px] text-foreground/85">
                    <span className="text-muted-foreground/50">#{entry.index}</span>{' '}
                    {entry.short_hash || entry.path.slice(0, 8)}
                    {entry.files_changed ? (
                      <span className="text-muted-foreground/45"> · {entry.files_changed} files</span>
                    ) : null}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground/60">
                    {entry.label}
                    {entry.mtime ? ` · ${entry.mtime}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onRestore(entry)}
                  disabled={busy === `restore-${entry.index}`}
                  className="shrink-0 rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {busy === `restore-${entry.index}` ? '…' : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {checkpoints && checkpoints.projects.length > 0 && (
        <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
            <Archive className="h-3 w-3" />
            Recent workdirs
          </div>
          <ul className="space-y-1">
            {checkpoints.projects.slice(0, 6).map((p) => (
              <li key={p.workdir} className="truncate font-mono text-[10px] text-muted-foreground/70">
                <span className={p.state === 'orphan' ? 'text-amber-400/80' : 'text-emerald-400/70'}>
                  {p.state}
                </span>{' '}
                {p.workdir.replace(/^\/Users\/[^/]+/, '~')}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function OpsCard({
  icon: Icon,
  title,
  body,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  icon: typeof Brain;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/45">
            <Icon className="h-3 w-3 shrink-0" />
            {title}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground/75">{body}</p>
        </div>
        {onAction && actionLabel && (
          <button
            type="button"
            onClick={onAction}
            disabled={actionDisabled}
            className="shrink-0 rounded-md border border-border/50 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
