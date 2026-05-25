import React, { useEffect, useState } from 'react';
import {
  Users, Loader2, Play, Pause, ArrowRight, CheckCircle2,
  Circle, AlertCircle, Clock, GitBranch, ChevronRight,
  ChevronDown, RefreshCw,
} from 'lucide-react';
import { useTeamStore, type Team, type TeamAgent, type Subtask } from '@/stores/team-store';
import { cn } from '@/lib/utils';

// ─── Helpers ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  forming: 'text-blue-400',
  active: 'text-emerald-400',
  synthesizing: 'text-amber-400',
  done: 'text-zinc-500',
  paused: 'text-violet-400',
};

const STATUS_BG: Record<string, string> = {
  forming: 'bg-blue-500/15 border-blue-500/25',
  active: 'bg-emerald-500/15 border-emerald-500/25',
  synthesizing: 'bg-amber-500/15 border-amber-500/25',
  done: 'bg-zinc-500/15 border-zinc-500/25',
  paused: 'bg-violet-500/15 border-violet-500/25',
};

function agentStatusIcon(status: TeamAgent['status']) {
  switch (status) {
    case 'idle': return <Circle className="h-3 w-3 text-zinc-500" />;
    case 'working': return <Loader2 className="h-3 w-3 animate-spin text-blue-400" />;
    case 'blocked': return <AlertCircle className="h-3 w-3 text-red-400" />;
    case 'done': return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
  }
}

function subtaskStatusLabel(status: Subtask['status']): { label: string; color: string } {
  switch (status) {
    case 'pending': return { label: 'Pending', color: 'text-zinc-500' };
    case 'assigned': return { label: 'Assigned', color: 'text-blue-400' };
    case 'in_progress': return { label: 'In Progress', color: 'text-amber-400' };
    case 'done': return { label: 'Done', color: 'text-emerald-400' };
    case 'blocked': return { label: 'Blocked', color: 'text-red-400' };
    case 'review': return { label: 'Review', color: 'text-cyan-400' };
    default: return { label: String(status), color: 'text-zinc-500' };
  }
}

// ─── Team Card Component ───────────────────────────────────────────────────

function TeamCard({
  team,
  expanded,
  onToggle,
}: {
  team: Team;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { dispatchTeam, pauseTeam, resumeTeam } = useTeamStore();
  const [actionLoading, setActionLoading] = useState(false);

  const subtaskDone = team.subtasks.filter((s) => s.status === 'done').length;
  const subtaskTotal = team.subtasks.length;
  const progressPct = subtaskTotal > 0 ? Math.round((subtaskDone / subtaskTotal) * 100) : 0;

  const handleDispatch = async () => {
    setActionLoading(true);
    await dispatchTeam(team.id);
    setActionLoading(false);
  };

  const handlePause = async () => {
    setActionLoading(true);
    await pauseTeam(team.id);
    setActionLoading(false);
  };

  const handleResume = async () => {
    setActionLoading(true);
    await resumeTeam(team.id);
    setActionLoading(false);
  };

  return (
    <div className="rounded-lg border border-[#2F2F2F] bg-[hsl(var(--card))]/40 overflow-hidden">
      {/* Header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-[hsl(var(--muted))]/30 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[hsl(var(--text-primary))]">
            {team.name}
          </span>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold border', STATUS_BG[team.status] || '')}>
            <span className={STATUS_COLORS[team.status]}>{team.status}</span>
          </span>
        </div>
      </button>

      {/* Summary row */}
      <div className="flex items-center gap-3 px-3 pb-2 text-[10px] text-muted-foreground/60">
        <span className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          {team.agents.length} agent{team.agents.length !== 1 ? 's' : ''}
        </span>
        {subtaskTotal > 0 && (
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {subtaskDone}/{subtaskTotal} subtasks
          </span>
        )}
      </div>

      {/* Progress bar */}
      {subtaskTotal > 0 && (
        <div className="px-3 pb-2">
          <div className="h-1 w-full rounded-full bg-[hsl(var(--muted))]/50 overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-500/60 transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-1 border-t border-[#2F2F2F]/50 px-3 py-1.5">
        {team.status === 'forming' && (
          <button
            onClick={(e) => { e.stopPropagation(); void handleDispatch(); }}
            disabled={actionLoading}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
          >
            {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Dispatch
          </button>
        )}
        {team.status === 'active' && (
          <button
            onClick={(e) => { e.stopPropagation(); void handlePause(); }}
            disabled={actionLoading}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
          >
            {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
            Pause
          </button>
        )}
        {team.status === 'paused' && (
          <button
            onClick={(e) => { e.stopPropagation(); void handleResume(); }}
            disabled={actionLoading}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
          >
            {actionLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            Resume
          </button>
        )}
        <span className="ml-auto text-[9px] text-muted-foreground/40 font-mono" title={`Team ID: ${team.id}`}>{team.id.slice(0, 10)}…</span>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[#2F2F2F]/50">
          {/* Agents */}
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground/50">Agents</span>
            <div className="mt-1 space-y-1">
              {team.agents.length === 0 && (
                <p className="text-[11px] text-muted-foreground/40 italic">No agents assigned</p>
              )}
              {team.agents.map((agent) => (
                <div key={agent.id || agent.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-[hsl(var(--muted))]/20">
                  {agentStatusIcon(agent.status)}
                  <span className="flex-1 text-[12px] text-[hsl(var(--text-primary))] font-medium">
                    {agent.name}
                  </span>
                  <span className={cn('text-[10px]', STATUS_COLORS[agent.status] || 'text-muted-foreground/50')}>
                    {agent.status}
                  </span>
                  {agent.currentSubtask && (
                    <span className="text-[9px] text-muted-foreground/40 font-mono truncate max-w-[100px]">
                      {agent.currentSubtask.slice(0, 12)}…
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Subtasks */}
          <div className="border-t border-[#2F2F2F]/50 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground/50">Subtasks</span>
            <div className="mt-1 space-y-1">
              {team.subtasks.length === 0 && (
                <p className="text-[11px] text-muted-foreground/40 italic">No subtasks decomposed yet</p>
              )}
              {team.subtasks.map((st) => {
                const { label, color } = subtaskStatusLabel(st.status);
                return (
                  <div key={st.id} className="rounded-md px-2 py-1.5 bg-[hsl(var(--muted))]/20">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('text-[11px] font-medium', color)}>{label}</span>
                      <span className="flex-1 text-[11px] text-[hsl(var(--text-primary))] truncate">{st.title}</span>
                      {st.assignedAgent && (
                        <span className="text-[9px] text-muted-foreground/40 font-mono">{st.assignedAgent}</span>
                      )}
                    </div>
                    {st.dependencies.length > 0 && (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {st.dependencies.map((dep) => (
                          <span key={dep} className="rounded bg-amber-500/10 px-1 py-0.5 text-[8px] text-amber-400/70 font-mono">
                            awaits: {dep.slice(0, 20)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Delegations */}
          {team.delegations.length > 0 && (
            <div className="border-t border-[#2F2F2F]/50 px-3 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground/50">Delegations</span>
              <div className="mt-1 space-y-1">
                {team.delegations.map((d, i) => (
                  <div key={i} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 bg-[hsl(var(--muted))]/20 text-[11px]">
                    <span className="font-medium text-blue-400">{d.from}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                    <span className="font-medium text-emerald-400">{d.to}</span>
                    <span className="ml-auto text-[9px] font-mono text-muted-foreground/40">{d.status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Team Panel ────────────────────────────────────────────────────────────

export function TeamPanel() {
  const { teams, loading, error, fetchTeams, startPolling, stopPolling, polling } = useTeamStore();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetchTeams().catch(() => {});
    startPolling();
    return () => stopPolling();
  }, [fetchTeams, startPolling, stopPolling]);

  const doneTeams = teams.filter((t) => t.status === 'done');
  const activeTeams = teams.filter((t) => t.status !== 'done');

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">Teams</span>
          <span className="text-[11px] font-mono text-[#555555]">{teams.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => fetchTeams().catch(() => {})}
            className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground transition-colors"
            title="Refresh teams"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          <span className={cn(
            'inline-flex items-center rounded-full px-1.5 py-0.5 text-[8px] font-medium',
            polling ? 'bg-emerald-500/15 text-emerald-400' : 'bg-zinc-500/15 text-zinc-400'
          )}>
            {polling ? 'Live' : 'Off'}
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-3 mb-2 flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400/80">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {loading && teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40 mb-2" />
            <span className="text-[12px] text-muted-foreground/60">Loading teams…</span>
          </div>
        ) : teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <Users className="h-8 w-8 text-muted-foreground/30 mb-3" />
            <p className="text-[13px] font-medium text-muted-foreground/70 mb-1">No teams yet</p>
            <p className="text-[11px] text-muted-foreground/50 text-center">
              Teams are created when the orchestrator dispatches a complex task.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {/* Active teams */}
            {activeTeams.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground/50 px-0.5">
                  Active ({activeTeams.length})
                </span>
                {activeTeams.map((team) => (
                  <TeamCard
                    key={team.id}
                    team={team}
                    expanded={expandedId === team.id}
                    onToggle={() => setExpandedId(expandedId === team.id ? null : team.id)}
                  />
                ))}
              </div>
            )}

            {/* Done teams */}
            {doneTeams.length > 0 && (
              <div className="space-y-1.5 pt-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-muted-foreground/50 px-0.5">
                  Completed ({doneTeams.length})
                </span>
                {doneTeams.map((team) => (
                  <TeamCard
                    key={team.id}
                    team={team}
                    expanded={expandedId === team.id}
                    onToggle={() => setExpandedId(expandedId === team.id ? null : team.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
