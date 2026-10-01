import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { BookOpenText, Check, Download, Loader2, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import type { HubSkill } from '@/lib/hermes-api';
import {
  useDeleteHermesSkill,
  useHermesSkillDetail,
  useHermesSkills,
  useInstallHubSkill,
  useSkillsHub,
} from '@/lib/hermes-queries';
import { HermesErrorState } from '@/components/hermes/HermesErrorState';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { filterSkills, formatBytes } from './hermesSidebarUtils';

type SkillsTab = 'installed' | 'hub';

const HUB_INSTALL_SUCCESS_MS = 2000;

const HUB_SOURCE_LABELS: Record<HubSkill['source'], string> = {
  'built-in': 'Built-in',
  optional: 'Optional',
  community: 'Community',
  anthropic: 'Anthropic',
  lobehub: 'LobeHub',
};

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function TokenBadge({ tokens }: { tokens: number }) {
  const color =
    tokens < 3000 ? 'text-green-400/75'
    : tokens < 10000 ? 'text-yellow-400/75'
    : 'text-red-400/75';
  return (
    <span className={cn('inline-block rounded px-1 py-0.5 font-mono text-[9px] font-medium tracking-wide', color)}>
      ~{formatTokens(tokens)} tok
    </span>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/35" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-border/40 bg-background/40 py-2 pl-9 pr-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-primary/30"
      />
    </div>
  );
}

function HubBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium', className)}>
      {children}
    </span>
  );
}

export function HermesSkillsPanel() {
  const [tab, setTab] = useState<SkillsTab>('installed');
  // `undefined` = nothing chosen yet (follow the first skill); `null` = collapsed.
  const [requestedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const [installedQuery, setInstalledQuery] = useState('');
  const [hubQuery, setHubQuery] = useState('');
  const [hubCategory, setHubCategory] = useState('all');
  /** Install/delete failures; load failures come from the queries. */
  const [hubActionError, setHubActionError] = useState<unknown>(null);
  const [installedActionError, setInstalledActionError] = useState<unknown>(null);
  const [installingSkillName, setInstallingSkillName] = useState<string | null>(null);
  const [justInstalledSkillName, setJustInstalledSkillName] = useState<string | null>(null);
  const deferredInstalledQuery = useDeferredValue(installedQuery);
  const deferredHubQuery = useDeferredValue(hubQuery);

  const skillsQuery = useHermesSkills();
  const skills = useMemo(() => skillsQuery.data ?? [], [skillsQuery.data]);
  // Keep the selection while it still exists; otherwise fall back to the first skill.
  const selectedId = requestedId === null
    ? null
    : requestedId !== undefined && skills.some((skill) => skill.id === requestedId)
      ? requestedId
      : (skills[0]?.id ?? null);
  const detailQuery = useHermesSkillDetail(selectedId);
  // The hub is only fetched once its tab has been opened.
  const hubQueryResult = useSkillsHub({ enabled: tab === 'hub' });
  const hubSkills = useMemo(() => hubQueryResult.data ?? [], [hubQueryResult.data]);
  const installMutation = useInstallHubSkill();
  const deleteMutation = useDeleteHermesSkill();

  const loading = skillsQuery.isFetching;
  const detailLoading = detailQuery.isFetching;
  const hubLoading = hubQueryResult.isFetching;
  const installedError = installedActionError ?? detailQuery.error ?? skillsQuery.error;
  const hubError = hubActionError ?? hubQueryResult.error;

  useEffect(() => {
    if (!justInstalledSkillName) return;
    const timeoutId = window.setTimeout(() => {
      setJustInstalledSkillName((current) => current === justInstalledSkillName ? null : current);
    }, HUB_INSTALL_SUCCESS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [justInstalledSkillName]);

  const filteredSkills = useMemo(
    () => filterSkills(skills, deferredInstalledQuery),
    [deferredInstalledQuery, skills],
  );

  const hubCategories = useMemo(() => {
    const categories = new Set<string>();
    for (const skill of hubSkills) {
      if (skill.category) {
        categories.add(skill.category);
      }
    }
    return ['all', ...Array.from(categories).sort((left, right) => left.localeCompare(right))];
  }, [hubSkills]);

  useEffect(() => {
    if (hubCategory === 'all') return;
    if (hubCategories.includes(hubCategory)) return;
    setHubCategory('all');
  }, [hubCategories, hubCategory]);

  const filteredHubSkills = useMemo(() => {
    const normalized = deferredHubQuery.trim().toLowerCase();
    return hubSkills.filter((skill) => {
      if (hubCategory !== 'all' && skill.category !== hubCategory) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const haystack = `${skill.name} ${skill.description} ${skill.category} ${skill.source}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [deferredHubQuery, hubCategory, hubSkills]);

  const refetchSkills = skillsQuery.refetch;
  const refetchHub = hubQueryResult.refetch;
  const handleRefresh = useCallback(() => {
    if (tab === 'hub') {
      setHubActionError(null);
      void refetchHub();
      return;
    }
    setInstalledActionError(null);
    void refetchSkills();
  }, [refetchHub, refetchSkills, tab]);

  const installHubSkill = installMutation.mutateAsync;
  const handleInstall = useCallback(async (skillName: string) => {
    setInstallingSkillName(skillName);
    setJustInstalledSkillName(null);
    try {
      await installHubSkill(skillName);
      setHubActionError(null);
      setJustInstalledSkillName(skillName);
    } catch (err) {
      setHubActionError(err);
    } finally {
      setInstallingSkillName((current) => current === skillName ? null : current);
    }
  }, [installHubSkill]);

  const deleteSkill = deleteMutation.mutateAsync;
  const handleDelete = useCallback((skillId: string) => {
    setInstalledActionError(null);
    deleteSkill(skillId).catch((err: unknown) => setInstalledActionError(err));
  }, [deleteSkill]);

  const headerSubtitle = tab === 'hub'
    ? `${hubSkills.length} discoverable skill${hubSkills.length === 1 ? '' : 's'}`
    : `${skills.length} installed under ~/.hermes/skills`;

  const refreshSpinning = tab === 'hub' ? hubLoading : loading;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Skills</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {headerSubtitle}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title={tab === 'hub' ? 'Refresh skills hub' : 'Refresh skills'}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshSpinning && 'animate-spin')} />
        </button>
      </div>

      <div className="flex gap-1 px-3 pb-2">
        <button
          onClick={() => setTab('installed')}
          className={cn(
            'rounded-lg px-3 py-1 text-[11px] font-medium transition-colors',
            tab === 'installed'
              ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
              : 'text-muted-foreground/60 hover:bg-background/30 hover:text-foreground'
          )}
        >
          Installed
        </button>
        <button
          onClick={() => setTab('hub')}
          className={cn(
            'rounded-lg px-3 py-1 text-[11px] font-medium transition-colors',
            tab === 'hub'
              ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
              : 'text-muted-foreground/60 hover:bg-background/30 hover:text-foreground'
          )}
        >
          Browse Hub
        </button>
      </div>

      {tab === 'installed' ? (
        <>
          <div className="px-3 pb-2">
            <SearchField
              value={installedQuery}
              onChange={setInstalledQuery}
              placeholder="Search skills"
            />
          </div>

          <HermesErrorState
            error={installedError}
            onRetry={handleRefresh}
            fallbackMessage="Failed to load Hermes skills"
            className="mx-3 mb-2"
          />

          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {skillsQuery.isPending && !installedError ? (
              <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground/60">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Indexing skills...
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="rounded-xl border border-border/30 bg-background/30 p-4 text-[12px] text-muted-foreground/55">
                No skills match "{deferredInstalledQuery}".
              </div>
            ) : (
              <div className="space-y-2">
                {filteredSkills.map((skill) => {
                  const expanded = selectedId === skill.id;
                  const detail = expanded ? detailQuery.data : undefined;
                  return (
                    <div
                      key={skill.id}
                      className={cn(
                        'rounded-xl border transition-colors',
                        expanded
                          ? 'border-primary/30 bg-primary/[0.07]'
                          : 'border-border/30 bg-background/30 hover:bg-[hsl(var(--sidebar-active))]'
                      )}
                    >
                      <button
                        onClick={() => setSelectedId(selectedId === skill.id ? null : skill.id)}
                        className="w-full px-3 py-3 text-left"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Sparkles className="h-3.5 w-3.5 text-muted-foreground/45" />
                              <span className="truncate text-[12px] font-medium text-foreground">{skill.name}</span>
                              {skill.estimated_tokens != null && (
                                <TokenBadge tokens={skill.estimated_tokens} />
                              )}
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">{skill.summary}</p>
                          </div>
                          <div className="text-right text-[9px] uppercase tracking-[0.18em] text-muted-foreground/35">
                            <div>{skill.category}</div>
                            <div className="mt-1 normal-case tracking-normal">
                              {skill.modified_at ? relativeTime(skill.modified_at) : '—'}
                            </div>
                          </div>
                        </div>
                      </button>

                      {expanded && (
                        <div className="border-t border-border/30 px-3 pb-3 pt-2">
                          {detailLoading && !detail ? (
                            <div className="flex items-center text-[11px] text-muted-foreground/60">
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              Loading skill body...
                            </div>
                          ) : detail ? (
                            <>
                              <div className="mb-2 flex items-center justify-between gap-3 text-[10px] text-muted-foreground/45">
                                <span className="truncate">{detail.path}</span>
                                <div className="flex flex-wrap items-center gap-3">
                                  {detail.size_bytes != null && (
                                    <span title="File size">{formatBytes(detail.size_bytes)}</span>
                                  )}
                                  <span>{detail.line_count} lines</span>
                                  {detail.estimated_tokens != null && (
                                    <span title="Estimated tokens (~4 chars per token)">~{formatTokens(detail.estimated_tokens)} tokens</span>
                                  )}

                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      if (confirm('Remove this skill?')) {
                                        handleDelete(skill.id);
                                      }
                                    }}
                                    className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-red-400/60 transition-colors hover:bg-red-500/20 hover:text-red-400"
                                    title="Uninstall skill"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                              <div className="max-h-[260px] overflow-y-auto rounded-xl border border-border/30 bg-[#111111]/70 p-3">
                                <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-foreground/86">
                                  {detail.content}
                                </pre>
                              </div>
                            </>
                          ) : (
                            <div className="flex items-center gap-2 rounded-lg bg-background/40 px-3 py-2 text-[11px] text-muted-foreground/55">
                              <BookOpenText className="h-3.5 w-3.5" />
                              Select to load this skill.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="px-3 pb-2">
            <SearchField
              value={hubQuery}
              onChange={setHubQuery}
              placeholder="Search the skills hub"
            />
          </div>

          <div className="flex gap-1 overflow-x-auto px-3 pb-2">
            {hubCategories.map((category) => (
              <button
                key={category}
                onClick={() => setHubCategory(category)}
                className={cn(
                  'whitespace-nowrap rounded-lg px-3 py-1 text-[11px] font-medium transition-colors',
                  hubCategory === category
                    ? 'bg-[hsl(var(--sidebar-active))] text-foreground'
                    : 'text-muted-foreground/60 hover:bg-background/30 hover:text-foreground'
                )}
              >
                {category === 'all' ? 'All' : category}
              </button>
            ))}
          </div>

          <HermesErrorState
            error={hubError}
            onRetry={handleRefresh}
            fallbackMessage="Failed to load the skills hub"
            className="mx-3 mb-2"
          />

          <div className="flex-1 overflow-y-auto px-3 pb-3">
            {hubQueryResult.isPending && !hubError ? (
              <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground/60">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading skills hub...
              </div>
            ) : filteredHubSkills.length === 0 ? (
              <div className="rounded-xl border border-border/30 bg-background/30 p-4 text-[12px] text-muted-foreground/55">
                No hub skills match the current filters.
              </div>
            ) : (
              <div className="space-y-2">
                {filteredHubSkills.map((skill) => {
                  const isInstalling = installingSkillName === skill.name;
                  const wasJustInstalled = justInstalledSkillName === skill.name;
                  const isInstalled = skill.installed || wasJustInstalled;
                  return (
                    <div
                      key={`${skill.source}:${skill.name}`}
                      className="rounded-xl border border-border/30 bg-background/30 p-3 transition-colors hover:bg-[hsl(var(--sidebar-active))]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-3.5 w-3.5 text-muted-foreground/45" />
                            <span className="truncate text-[12px] font-medium text-foreground">{skill.name}</span>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/60">{skill.description}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <HubBadge className="border-border/40 bg-background/40 text-muted-foreground/70">
                              {skill.category}
                            </HubBadge>
                            <HubBadge className="border-primary/20 bg-primary/10 text-primary">
                              {HUB_SOURCE_LABELS[skill.source]}
                            </HubBadge>
                          </div>
                        </div>

                        <button
                          onClick={() => { void handleInstall(skill.name); }}
                          disabled={Boolean(installingSkillName) || isInstalled}
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors',
                            isInstalled
                              ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20'
                              : 'bg-primary/[0.12] text-primary ring-1 ring-primary/20 hover:bg-primary/[0.18]',
                            (Boolean(installingSkillName) || isInstalled) && 'cursor-default'
                          )}
                        >
                          {isInstalling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : isInstalled ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {isInstalling ? 'Installing...' : isInstalled ? 'Installed' : 'Install'}
                          </span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
