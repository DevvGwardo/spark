import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { BookOpenText, Loader2, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import {
  deleteHermesSkill,
  fetchHermesSkillDetail,
  fetchHermesSkills,
  type HermesSkillDetail,
  type HermesSkillSummary,
} from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

function TokenBadge({ tokens }: { tokens: number }) {
  const color =
    tokens < 3000 ? 'text-green-400/75' :
    tokens < 10000 ? 'text-yellow-400/75' :
    'text-red-400/75';
  return (
    <span className={cn('inline-block rounded px-1 py-0.5 font-mono text-[9px] font-medium tracking-wide', color)}>
      ~{formatTokens(tokens)} tok
    </span>
  );
}

export function HermesSkillsPanel() {
  const [skills, setSkills] = useState<HermesSkillSummary[]>([]);
  const [details, setDetails] = useState<Record<string, HermesSkillDetail>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const nextSkills = await fetchHermesSkills();
      setSkills(nextSkills);
      setError(null);
      setSelectedId((current) => (
        nextSkills.some((skill) => skill.id === current)
          ? current
          : (nextSkills[0]?.id ?? null)
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Hermes skills');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSkillDetail = useCallback(async (skillId: string) => {
    setDetailLoading(true);
    try {
      const detail = await fetchHermesSkillDetail(skillId);
      setDetails((current) => current[skillId] ? current : { ...current, [skillId]: detail });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skill');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (!selectedId) return;
    if (details[selectedId]) return;
    void loadSkillDetail(selectedId);
  }, [details, loadSkillDetail, selectedId]);

  const filteredSkills = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => {
      const haystack = `${skill.name} ${skill.summary} ${skill.category} ${skill.path}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [deferredQuery, skills]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Skills</span>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/50">
            {skills.length} installed under ~/.hermes/skills
          </p>
        </div>
        <button
          onClick={() => { void loadSkills(); }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Refresh skills"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/35" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            className="w-full rounded-xl border border-border/40 bg-background/40 py-2 pl-9 pr-3 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/35 focus:border-[#ff8f3f]/30"
          />
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && skills.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground/60">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Indexing skills...
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="rounded-xl border border-border/30 bg-background/30 p-4 text-[12px] text-muted-foreground/55">
            No skills match "{deferredQuery}".
          </div>
        ) : (
          <div className="space-y-2">
            {filteredSkills.map((skill) => {
              const expanded = selectedId === skill.id;
              const detail = details[skill.id];
              return (
                <div
                  key={skill.id}
                  className={cn(
                    'rounded-xl border transition-colors',
                    expanded
                      ? 'border-[#ff8f3f]/30 bg-[#ff8f3f]/7'
                      : 'border-border/30 bg-background/30 hover:bg-[hsl(var(--sidebar-active))]'
                  )}
                >
                  <button
                    onClick={() => setSelectedId((current) => current === skill.id ? null : skill.id)}
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
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm('Remove this skill?')) {
                                    void deleteHermesSkill(skill.id).then(() => { void loadSkills(); });
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
    </div>
  );
}
