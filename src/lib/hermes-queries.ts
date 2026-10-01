/**
 * React Query layer over `hermes-api.ts` (hardening spec Phase 6.1).
 *
 * One query-key factory and one hook per resource the Hermes sidebar panels
 * use. Query functions are the existing `hermes-api` functions, so transport,
 * profile header, timeouts and error shape stay in one place.
 *
 * Every key is scoped by the active Hermes profile: the API answers per
 * `X-Hermes-Profile`, so switching profile must never serve another profile's
 * cache.
 *
 * Queries also respect `BridgeReadyContext`. Inside a `<BridgeGate>` they run
 * only while the bridge is usable, so a restarting bridge pauses polling rather
 * than making every panel fail on its own. Outside a gate the context defaults
 * to "ready" and the hooks behave like plain `useQuery`.
 */
import { createContext, useContext, useRef } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  HermesApiError,
  activateHermesProject,
  bindHermesProjectBoard,
  createHermesProject,
  createSkillBundle,
  deleteHermesSkill,
  deleteSkillBundle,
  disablePlugin,
  doctorComputerUse,
  doctorHooks,
  enablePlugin,
  fetchCheckpoints,
  fetchComputerUseStatus,
  fetchCuratorStatus,
  fetchGatewayCapabilities,
  fetchHermesDashboardUrl,
  fetchHermesMcpCatalog,
  fetchHermesMcpServers,
  fetchHermesProjects,
  fetchHermesSkillDetail,
  fetchHermesSkills,
  fetchHermesSystem,
  fetchHermesWorkspaceFile,
  fetchHermesWorkspaceFiles,
  fetchHermesWorkspaceOverview,
  fetchHermesWorkspaceUsage,
  fetchHooksStatus,
  fetchInsights,
  fetchLspStatus,
  fetchMemoryStatus,
  fetchPetsGallery,
  fetchPetsStatus,
  fetchPluginsStatus,
  fetchSecretsStatus,
  fetchSecurityAudit,
  fetchSkillBundles,
  fetchSkillsHub,
  forkHermesSession,
  getSession,
  installComputerUse,
  installHermesMcpServer,
  installHubSkill,
  pruneCheckpoints,
  reloadSkillBundles,
  restoreCheckpoint,
  runCurator,
  selectPet,
  uninstallHermesMcpServer,
  updateHermesWorkspaceFile,
  type HermesPlugin,
  type HermesProjectsList,
  type HermesSessionDetail,
  type HermesWorkspaceFile,
  type HermesWorkspaceFileSummary,
  type HooksStatus,
  type HubSkill,
  type PluginsStatus,
  type SkillBundle,
} from './hermes-api';
import { useProfilesStore } from '@/stores/profiles-store';
import {
  fetchBridgeReadiness,
  readinessPollInterval,
  type BridgeReadinessResult,
  type BridgeReadinessState,
} from './bridge-readiness';

// ─── Keys ─────────────────────────────────────────────────────────────────

export const hermesKeys = {
  /** Every Hermes query for a profile — invalidate this to refetch a whole profile. */
  all: (profile: string) => ['hermes', profile] as const,

  overview: (p: string) => ['hermes', p, 'workspace', 'overview'] as const,
  usage: (p: string) => ['hermes', p, 'workspace', 'usage'] as const,
  system: (p: string) => ['hermes', p, 'workspace', 'system'] as const,
  dashboardUrl: (p: string) => ['hermes', p, 'dashboard-url'] as const,

  files: (p: string) => ['hermes', p, 'workspace', 'files'] as const,
  file: (p: string, key: string) => ['hermes', p, 'workspace', 'files', key] as const,
  memoryStatus: (p: string) => ['hermes', p, 'memory', 'status'] as const,

  skills: (p: string) => ['hermes', p, 'skills', 'installed'] as const,
  skill: (p: string, id: string) => ['hermes', p, 'skills', 'detail', id] as const,
  skillsHub: (p: string) => ['hermes', p, 'skills', 'hub'] as const,
  bundles: (p: string) => ['hermes', p, 'skills', 'bundles'] as const,

  mcpServers: (p: string) => ['hermes', p, 'mcp', 'servers'] as const,
  mcpCatalog: (p: string) => ['hermes', p, 'mcp', 'catalog'] as const,

  projects: (p: string) => ['hermes', p, 'projects'] as const,

  checkpoints: (p: string) => ['hermes', p, 'checkpoints'] as const,
  curator: (p: string) => ['hermes', p, 'curator'] as const,
  computerUse: (p: string) => ['hermes', p, 'computer-use'] as const,
  gatewayCapabilities: (p: string) => ['hermes', p, 'gateway', 'capabilities'] as const,
  insights: (p: string, days: number) => ['hermes', p, 'insights', days] as const,
  pets: (p: string) => ['hermes', p, 'pets', 'status'] as const,
  petsGallery: (p: string, limit: number) => ['hermes', p, 'pets', 'gallery', limit] as const,
  plugins: (p: string, limit: number) => ['hermes', p, 'plugins', limit] as const,
  hooks: (p: string) => ['hermes', p, 'hooks'] as const,
  lsp: (p: string) => ['hermes', p, 'lsp'] as const,
  secrets: (p: string) => ['hermes', p, 'secrets'] as const,

  session: (p: string, id: string) => ['hermes', p, 'sessions', 'detail', id] as const,
  activeSessionDetails: (p: string, ids: readonly string[]) =>
    ['hermes', p, 'sessions', 'active-details', ids.join(',')] as const,
  sessionsPoll: (p: string) => ['hermes', p, 'sessions', 'poll'] as const,
} as const;

/** Readiness is about the bridge process, not a profile — one shared key. */
export const bridgeReadinessKey = ['bridge', 'readiness'] as const;

// ─── Shared behavior ──────────────────────────────────────────────────────

/**
 * Whether Hermes queries may run. `<BridgeGate>` provides `false` while the
 * bridge is starting/restarting/offline; the default keeps hooks usable
 * outside a gate (settings pages, tests).
 */
export const BridgeReadyContext = createContext<boolean>(true);

export function useBridgeQueriesEnabled(): boolean {
  return useContext(BridgeReadyContext);
}

export function useActiveHermesProfile(): string {
  return useProfilesStore((s) => s.activeProfile || 'default');
}

/** Poll at most this often; the poll pauses while the window is hidden. */
export interface PollOptions {
  refetchInterval?: number | false;
}

type HermesQueryOptions<T> = Omit<UseQueryOptions<T, Error, T, QueryKey>, 'queryKey' | 'queryFn'> & PollOptions;

/**
 * Panels used to fetch once on mount and never retry, and showed the failure
 * immediately. Keep that: no automatic retries (the error UI offers Retry when
 * the code says it could work), no refetch-on-focus storms in Electron, and a
 * short stale window so remounting a tab shows cached data instantly while it
 * refreshes in the background.
 */
const HERMES_QUERY_DEFAULTS = {
  retry: false,
  refetchOnWindowFocus: false,
  staleTime: 10_000,
  refetchIntervalInBackground: false,
} as const;

function useHermesQuery<T>(
  queryKey: QueryKey,
  queryFn: () => Promise<T>,
  options: HermesQueryOptions<T> = {},
) {
  const bridgeReady = useBridgeQueriesEnabled();
  const { enabled = true, ...rest } = options;
  return useQuery<T, Error, T, QueryKey>({
    ...HERMES_QUERY_DEFAULTS,
    ...rest,
    queryKey,
    queryFn,
    enabled: bridgeReady && enabled !== false,
  });
}

function invalidate(qc: QueryClient, ...keys: QueryKey[]) {
  return Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}

// ─── Bridge readiness ─────────────────────────────────────────────────────

/**
 * Polls bridge readiness: ~2s while the bridge is coming up, 15s once it is
 * ready. Not gated (it is what drives the gate) and shared by every consumer —
 * the gate, the header pill — through the one cache entry.
 */
export function useBridgeReadiness(options: { enabled?: boolean } = {}) {
  // The health fallback needs the last state to tell "reconnecting" from
  // "never started"; read it from the cache rather than component state so
  // every consumer agrees.
  const qc = useQueryClient();
  const previousRef = useRef<BridgeReadinessState | undefined>(undefined);
  return useQuery<BridgeReadinessResult>({
    queryKey: bridgeReadinessKey,
    queryFn: async () => {
      const previous =
        qc.getQueryData<BridgeReadinessResult>(bridgeReadinessKey)?.state ?? previousRef.current;
      const result = await fetchBridgeReadiness(previous);
      previousRef.current = result.state;
      return result;
    },
    enabled: options.enabled ?? true,
    retry: false,
    staleTime: 1_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => readinessPollInterval(query.state.data?.state),
  });
}

// ─── Workspace ────────────────────────────────────────────────────────────

export function useHermesWorkspaceOverview(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesWorkspaceOverview>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.overview(p), fetchHermesWorkspaceOverview, options);
}

export function useHermesWorkspaceUsage(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesWorkspaceUsage>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.usage(p), fetchHermesWorkspaceUsage, options);
}

export function useHermesSystem(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesSystem>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.system(p), fetchHermesSystem, options);
}

/** The Hermes dashboard URL, or `null` when the bridge doesn't report one. */
export function useHermesDashboardUrl(options?: HermesQueryOptions<string | null>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.dashboardUrl(p),
    async () => {
      const dash = await fetchHermesDashboardUrl();
      return dash.ok && dash.url ? dash.url : null;
    },
    { staleTime: 5 * 60_000, ...options },
  );
}

// ─── Memory files ─────────────────────────────────────────────────────────

export function useHermesWorkspaceFiles(options?: HermesQueryOptions<HermesWorkspaceFileSummary[]>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.files(p), fetchHermesWorkspaceFiles, options);
}

export function useHermesWorkspaceFile(fileKey: string | null, options?: HermesQueryOptions<HermesWorkspaceFile>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.file(p, fileKey ?? ''),
    () => fetchHermesWorkspaceFile(fileKey as string),
    { ...options, enabled: Boolean(fileKey) && (options?.enabled ?? true) },
  );
}

export function useMemoryStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchMemoryStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.memoryStatus(p), fetchMemoryStatus, options);
}

export function useUpdateWorkspaceFile() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (vars: { fileKey: string; content: string; version?: string | null }) =>
      updateHermesWorkspaceFile(vars.fileKey, vars.content, vars.version),
    onSuccess: (updated, vars) => {
      qc.setQueryData(hermesKeys.file(p, vars.fileKey), updated);
      qc.setQueryData<HermesWorkspaceFileSummary[]>(hermesKeys.files(p), (files) =>
        files?.map((file) => (file.key === vars.fileKey ? updated : file)),
      );
    },
    onError: (err, vars) => {
      // 409: the file changed on disk. The response carries the latest version;
      // load it so the next save is against the right `version`.
      if (err instanceof HermesApiError && err.status === 409) {
        const latest = err.data.file as HermesWorkspaceFile | undefined;
        if (latest) {
          qc.setQueryData(hermesKeys.file(p, vars.fileKey), latest);
          qc.setQueryData<HermesWorkspaceFileSummary[]>(hermesKeys.files(p), (files) =>
            files?.map((file) => (file.key === vars.fileKey ? latest : file)),
          );
        }
      }
    },
  });
}

// ─── Skills ───────────────────────────────────────────────────────────────

export function useHermesSkills(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesSkills>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.skills(p), fetchHermesSkills, options);
}

export function useHermesSkillDetail(skillId: string | null, options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesSkillDetail>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.skill(p, skillId ?? ''),
    () => fetchHermesSkillDetail(skillId as string),
    // A skill body only changes when the skill is reinstalled, which
    // invalidates it explicitly.
    { staleTime: 5 * 60_000, ...options, enabled: Boolean(skillId) && (options?.enabled ?? true) },
  );
}

export function useSkillsHub(options?: HermesQueryOptions<HubSkill[]>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.skillsHub(p), fetchSkillsHub, { staleTime: 5 * 60_000, ...options });
}

export function useInstallHubSkill() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (skillName: string) => installHubSkill(skillName),
    onSuccess: (_data, skillName) => {
      qc.setQueryData<HubSkill[]>(hermesKeys.skillsHub(p), (skills) =>
        skills?.map((skill) => (skill.name === skillName ? { ...skill, installed: true } : skill)),
      );
      void invalidate(qc, hermesKeys.skills(p));
    },
  });
}

export function useDeleteHermesSkill() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (skillId: string) => deleteHermesSkill(skillId),
    onSuccess: (_data, skillId) => {
      qc.removeQueries({ queryKey: hermesKeys.skill(p, skillId) });
      void invalidate(qc, hermesKeys.skills(p), hermesKeys.skillsHub(p));
    },
  });
}

export function useSkillBundles(options?: HermesQueryOptions<SkillBundle[]>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.bundles(p), async () => (await fetchSkillBundles()).bundles ?? [], options);
}

/** Bundle mutations all answer with the full list; write it straight into the cache. */
function useBundlesMutation<V, R extends { ok: boolean; error?: string; bundles?: SkillBundle[] }>(
  fn: (vars: V) => Promise<R>,
  failure: string,
) {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: async (vars: V) => {
      const res = await fn(vars);
      if (!res.ok) throw new Error(res.error || failure);
      return res;
    },
    onSuccess: (res) => {
      qc.setQueryData(hermesKeys.bundles(p), res.bundles || []);
    },
  });
}

export function useCreateSkillBundle() {
  return useBundlesMutation(createSkillBundle, 'Create failed');
}

export function useDeleteSkillBundle() {
  return useBundlesMutation(deleteSkillBundle, 'Delete failed');
}

export function useReloadSkillBundles() {
  return useBundlesMutation((_: void) => reloadSkillBundles(), 'Reload failed');
}

// ─── MCP ──────────────────────────────────────────────────────────────────

export function useHermesMcpServers(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesMcpServers>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.mcpServers(p), fetchHermesMcpServers, options);
}

export function useHermesMcpCatalog(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchHermesMcpCatalog>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.mcpCatalog(p), fetchHermesMcpCatalog, { staleTime: 5 * 60_000, ...options });
}

export function useInstallHermesMcpServer() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (catalogId: string) => installHermesMcpServer(catalogId),
    onSuccess: () => invalidate(qc, hermesKeys.mcpServers(p)),
  });
}

export function useUninstallHermesMcpServer() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (name: string) => uninstallHermesMcpServer(name),
    onSuccess: () => invalidate(qc, hermesKeys.mcpServers(p)),
  });
}

// ─── Projects ─────────────────────────────────────────────────────────────

export function useHermesProjects(options?: HermesQueryOptions<HermesProjectsList>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.projects(p), () => fetchHermesProjects(), options);
}

/**
 * Project mutations answer with the full list (and the new active slug); the
 * response replaces the cached list so the switcher updates without a refetch.
 */
function useProjectsMutation<V, R extends HermesProjectsList>(
  fn: (vars: V) => Promise<R>,
  failure: string,
  /** Active slug to assume when the response omits `active_slug`. */
  fallbackActive: (vars: V, res: R, current: HermesProjectsList | undefined) => string | null,
) {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: async (vars: V) => {
      const res = await fn(vars);
      if (res.ok === false) throw new Error(res.error || failure);
      return res;
    },
    onSuccess: (res, vars) => {
      qc.setQueryData<HermesProjectsList>(hermesKeys.projects(p), (current) => ({
        ...(current ?? { ok: true }),
        ...res,
        projects: res.projects || [],
        active_slug: res.active_slug ?? fallbackActive(vars, res, current),
      }));
    },
  });
}

export function useActivateHermesProject() {
  return useProjectsMutation(
    (project: string) => activateHermesProject(project),
    'Failed to switch project',
    (project) => project,
  );
}

export function useCreateHermesProject() {
  return useProjectsMutation(createHermesProject, 'Create failed', (_vars, res) => res.created_slug ?? null);
}

export function useBindHermesProjectBoard() {
  return useProjectsMutation(
    bindHermesProjectBoard,
    'Bind failed',
    (_vars, _res, current) => current?.active_slug ?? null,
  );
}

// ─── Ops (System → Hermes ops) ────────────────────────────────────────────

export function useCheckpoints(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchCheckpoints>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.checkpoints(p), () => fetchCheckpoints(), options);
}

export function useCuratorStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchCuratorStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.curator(p), fetchCuratorStatus, options);
}

export function useComputerUseStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchComputerUseStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.computerUse(p), fetchComputerUseStatus, options);
}

export function useGatewayCapabilities(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchGatewayCapabilities>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.gatewayCapabilities(p), fetchGatewayCapabilities, { staleTime: 60_000, ...options });
}

export function useInsights(days: number, options?: HermesQueryOptions<string>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.insights(p, days), async () => (await fetchInsights(days)).report || '', {
    staleTime: 5 * 60_000,
    ...options,
  });
}

export function usePetsStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchPetsStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.pets(p), fetchPetsStatus, options);
}

export function usePetsGallery(limit: number, options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchPetsGallery>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.petsGallery(p, limit), () => fetchPetsGallery(limit), {
    staleTime: 5 * 60_000,
    ...options,
  });
}

export function usePluginsStatus(limit: number, options?: HermesQueryOptions<PluginsStatus>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.plugins(p, limit), () => fetchPluginsStatus(limit), options);
}

export function useHooksStatus(options?: HermesQueryOptions<HooksStatus>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.hooks(p), fetchHooksStatus, options);
}

export function useLspStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchLspStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.lsp(p), fetchLspStatus, options);
}

export function useSecretsStatus(options?: HermesQueryOptions<Awaited<ReturnType<typeof fetchSecretsStatus>>>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(hermesKeys.secrets(p), fetchSecretsStatus, options);
}

export function usePruneCheckpoints() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: () => pruneCheckpoints(),
    onSuccess: () => invalidate(qc, hermesKeys.checkpoints(p)),
  });
}

export function useRestoreCheckpoint() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: async (vars: { index: number; workdir?: string }) => {
      const result = await restoreCheckpoint(vars.index, vars.workdir);
      if (!result.ok) throw new Error(result.error || 'Restore failed');
      return result;
    },
    onSuccess: () => invalidate(qc, hermesKeys.checkpoints(p)),
  });
}

export function useRunCurator() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: () => runCurator(),
    onSuccess: () => invalidate(qc, hermesKeys.curator(p)),
  });
}

export function useInstallComputerUse() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: () => installComputerUse(),
    onSuccess: (res) => {
      if (res.status) qc.setQueryData(hermesKeys.computerUse(p), res.status);
    },
  });
}

export function useDoctorComputerUse() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: () => doctorComputerUse(),
    onSuccess: (res) => {
      if (res.status) qc.setQueryData(hermesKeys.computerUse(p), res.status);
    },
  });
}

export function useDoctorHooks() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: () => doctorHooks(),
    onSuccess: (res) => {
      qc.setQueryData<HooksStatus>(hermesKeys.hooks(p), {
        ok: res.ok,
        total: res.hooks?.length ?? 0,
        issue_hints: res.issue_count,
        hooks: res.hooks || [],
      });
    },
  });
}

export function useTogglePlugin(limit: number) {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (plugin: HermesPlugin) => (plugin.enabled ? disablePlugin(plugin.name) : enablePlugin(plugin.name)),
    onSuccess: (res) => {
      qc.setQueryData<PluginsStatus>(hermesKeys.plugins(p, limit), (current) => ({
        ...(current as PluginsStatus),
        ...res,
        plugins: res.plugins || [],
        total: res.total ?? res.plugins?.length ?? 0,
        enabled_count: res.enabled_count ?? 0,
      }));
    },
  });
}

export function useSelectPet() {
  const qc = useQueryClient();
  const p = useActiveHermesProfile();
  return useMutation({
    mutationFn: (petId: string) => selectPet(petId),
    onSuccess: (res) => {
      qc.setQueryData(hermesKeys.pets(p), res.status);
    },
  });
}

/** On-demand OSV scan — slow and user-triggered, so a mutation rather than a query. */
export function useSecurityAudit() {
  return useMutation({ mutationFn: () => fetchSecurityAudit() });
}

// ─── Sessions ─────────────────────────────────────────────────────────────

export function useHermesSession(sessionId: string | null, options?: HermesQueryOptions<HermesSessionDetail>) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.session(p, sessionId ?? ''),
    () => getSession(sessionId as string),
    { ...options, enabled: Boolean(sessionId) && (options?.enabled ?? true) },
  );
}

/** Details for every active session, keyed by id. */
export function useHermesActiveSessionDetails(
  sessionIds: readonly string[],
  options?: HermesQueryOptions<Record<string, HermesSessionDetail>>,
) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.activeSessionDetails(p, sessionIds),
    async () => {
      const details = await Promise.all(sessionIds.map((id) => getSession(id)));
      return Object.fromEntries(details.map((detail) => [detail.id, detail]));
    },
    // Keep the previous set on screen while a changed id list loads.
    { placeholderData: keepPreviousData, ...options },
  );
}

/**
 * Drive a store-owned refresh (the paginated sessions list lives in
 * `sessions-store` because it is shared with the session history view) on the
 * same visibility-aware schedule as every other Hermes poll.
 */
export function useHermesSessionsPoll(refresh: () => Promise<unknown>, options: PollOptions & { enabled?: boolean }) {
  const p = useActiveHermesProfile();
  return useHermesQuery(
    hermesKeys.sessionsPoll(p),
    async () => {
      await refresh();
      return Date.now();
    },
    // Seeded and never stale, so mounting doesn't fire a refresh on top of
    // the panel's own first-page load — only the interval does.
    { ...options, initialData: () => Date.now(), staleTime: Infinity },
  );
}

export function useForkHermesSession() {
  return useMutation({ mutationFn: (sessionId: string) => forkHermesSession(sessionId) });
}
