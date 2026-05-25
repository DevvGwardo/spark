import { create } from 'zustand';
import { getApiBaseUrl } from '@/lib/api';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TeamAgent {
  /** Maps from server profileName */
  id: string;
  /** Maps from server displayName */
  name: string;
  status: 'idle' | 'working' | 'blocked' | 'done';
  currentSubtask?: string;
}

export interface Subtask {
  id: string;
  title: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'done' | 'blocked' | 'review';
  assignedAgent?: string;
  result?: string;
  dependencies: string[];
}

export interface ContextEntry {
  id: string;
  type: 'finding' | 'decision' | 'question' | 'artifact' | 'handoff';
  content: string;
  author: string;
  timestamp: number;
}

export interface Delegation {
  from: string;
  to: string;
  subtaskId: string;
  status: string;
}

export interface Team {
  id: string;
  name: string;
  status: 'forming' | 'active' | 'synthesizing' | 'done' | 'paused';
  agents: TeamAgent[];
  subtasks: Subtask[];
  context: ContextEntry[];
  delegations: Delegation[];
}

// ─── API response type helpers ──────────────────────────────────────────────

interface ApiActiveTeam {
  id: string;
  taskId: string;
  agentCount: number;
  status: string;
  createdAt: number;
}

interface ApiAgentData {
  profileName: string;
  displayName: string;
  expertise: string[];
  status: string;
  currentSubtask?: string | null;
}

interface ApiSubtaskData {
  id: string;
  title: string;
  description: string;
  assignedTo: string | null;
  dependencies: string[];
  status: string;
  result: string | null;
}

interface ApiDelegationData {
  id: string;
  fromAgent: string;
  toAgent: string;
  subtaskId: string;
  status: string;
  handoffContext?: string;
  result?: string | null;
}

interface ApiContextEntry {
  id: string;
  teamId: string;
  type: string;
  content: string;
  author: string;
  importance: number;
  tags: string[];
  timestamp: number;
}

interface ApiTeamDetail {
  id: string;
  taskId: string;
  agents: ApiAgentData[];
  subtasks: ApiSubtaskData[];
  delegations: ApiDelegationData[];
  status: string;
  sharedContext: Record<string, unknown>;
  createdAt: number;
}

// ─── Mapping helpers ────────────────────────────────────────────────────────

const TEAM_STATUS_MAP: Record<string, Team['status']> = {
  forming: 'forming',
  active: 'active',
  synthesizing: 'synthesizing',
  done: 'done',
  paused: 'paused',
};

function mapAgent(a: ApiAgentData): TeamAgent {
  return {
    id: a.profileName,
    name: a.displayName || a.profileName,
    status: (['idle', 'working', 'blocked', 'done'].includes(a.status)
      ? a.status : 'idle') as TeamAgent['status'],
    currentSubtask: a.currentSubtask ?? undefined,
  };
}

function mapSubtask(s: ApiSubtaskData): Subtask {
  return {
    id: s.id,
    title: s.title,
    status: (['pending', 'assigned', 'in_progress', 'done', 'blocked', 'review'].includes(s.status)
      ? s.status : 'pending') as Subtask['status'],
    assignedAgent: s.assignedTo ?? undefined,
    result: s.result ?? undefined,
    dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
  };
}

function mapDelegation(d: ApiDelegationData): Delegation {
  return {
    from: d.fromAgent,
    to: d.toAgent,
    subtaskId: d.subtaskId,
    status: d.status,
  };
}

function mapContextEntry(e: ApiContextEntry): ContextEntry {
  const validTypes = ['finding', 'decision', 'question', 'artifact', 'handoff'];
  return {
    id: e.id,
    type: validTypes.includes(e.type) ? e.type as ContextEntry['type'] : 'finding',
    content: e.content,
    author: e.author,
    timestamp: e.timestamp,
  };
}

function makeTeamName(taskId: string | undefined, id: string): string {
  return taskId ? `Team - ${taskId.slice(0, 12)}` : `Team - ${id.slice(0, 12)}`;
}

// ─── Store ─────────────────────────────────────────────────────────────────

interface TeamState {
  teams: Team[];
  selectedTeamId: string | null;
  loading: boolean;
  polling: boolean;
  pollingIntervalId: ReturnType<typeof setInterval> | null;
  error: string | null;
  fetchTeams: () => Promise<void>;
  fetchTeamDetail: (id: string) => Promise<void>;
  fetchTeamContext: (id: string) => Promise<ContextEntry[]>;
  createTeam: (taskId: string, task: string) => Promise<Team | null>;
  dispatchTeam: (id: string) => Promise<void>;
  pauseTeam: (id: string) => Promise<void>;
  resumeTeam: (id: string) => Promise<void>;
  reassignSubtask: (teamId: string, subtaskId: string, newAgent: string) => Promise<void>;
  setSelectedTeamId: (id: string | null) => void;
  startPolling: () => void;
  stopPolling: () => void;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

/** Update summary fields from the /active endpoint without overwriting detail data. */
function mergeActiveTeam(
  prev: Team[],
  active: ApiActiveTeam,
): Team[] {
  const existing = prev.find((t) => t.id === active.id);
  if (existing) {
    // Preserve agents/subtasks/context/delegations from detail, update status
    return prev.map((t) =>
      t.id === active.id
        ? { ...t, status: TEAM_STATUS_MAP[active.status] || t.status }
        : t,
    );
  }
  // New team — add skeleton
  return [
    ...prev,
    {
      id: active.id,
      name: makeTeamName(active.taskId, active.id),
      status: TEAM_STATUS_MAP[active.status] || 'forming',
      agents: [],
      subtasks: [],
      context: [],
      delegations: [],
    },
  ];
}

function mapTeamDetail(api: ApiTeamDetail): Team {
  return {
    id: api.id,
    name: makeTeamName(api.taskId, api.id),
    status: TEAM_STATUS_MAP[api.status] || 'forming',
    agents: (api.agents ?? []).map(mapAgent),
    subtasks: (api.subtasks ?? []).map(mapSubtask),
    context: [],
    delegations: (api.delegations ?? []).map(mapDelegation),
  };
}

export const useTeamStore = create<TeamState>()((set, get) => ({
  teams: [],
  selectedTeamId: null,
  loading: false,
  polling: false,
  pollingIntervalId: null,
  error: null,

  fetchTeams: async () => {
    set({ loading: true, error: null });
    try {
      const [activeData, completedData] = await Promise.all([
        apiFetch('/api/hermes/team/active'),
        apiFetch('/api/hermes/team/completed').catch(() => ({ teams: [] })),
      ]);

      const activeTeams: ApiActiveTeam[] = activeData.teams ?? [];
      const completedTeams: ApiActiveTeam[] = completedData.teams ?? [];

      set((s) => {
        let teams = s.teams;
        // Merge active teams (preserving detail data)
        teams = activeTeams.reduce((acc, t) => mergeActiveTeam(acc, t), teams);
        // Merge completed teams
        teams = completedTeams.reduce((acc, t) => mergeActiveTeam(acc, t), teams);
        return { teams };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch teams';
      set({ error: msg });
    } finally {
      set({ loading: false });
    }
  },

  fetchTeamDetail: async (id) => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch(`/api/hermes/team/${encodeURIComponent(id)}`);
      const apiTeam = data.team as ApiTeamDetail;
      const team = mapTeamDetail(apiTeam);

      set((s) => ({
        teams: s.teams.some((t) => t.id === id)
          ? s.teams.map((existing) =>
              existing.id === id ? team : existing,
            )
          : [...s.teams, team],
        selectedTeamId: id,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch team detail';
      set({ error: msg });
    } finally {
      set({ loading: false });
    }
  },

  fetchTeamContext: async (id) => {
    try {
      const data = await apiFetch(`/api/hermes/team/${encodeURIComponent(id)}/context`);
      const entries: ApiContextEntry[] = data.entries ?? [];
      const mapped = entries.map(mapContextEntry);

      // Merge into store
      set((s) => ({
        teams: s.teams.map((t) =>
          t.id === id ? { ...t, context: mapped } : t,
        ),
      }));

      return mapped;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fetch team context';
      set({ error: msg });
      return [];
    }
  },

  createTeam: async (taskId, task) => {
    set({ error: null });
    try {
      const data = await apiFetch('/api/hermes/team/create', {
        method: 'POST',
        body: JSON.stringify({ cardId: taskId, title: task }),
      });
      const t = data.team as ApiTeamDetail;
      const team: Team = {
        id: t.id,
        name: task.slice(0, 40),
        status: TEAM_STATUS_MAP[t.status] || 'forming',
        agents: (t.agents ?? []).map(mapAgent),
        subtasks: (t.subtasks ?? []).map(mapSubtask),
        context: [],
        delegations: (t.delegations ?? []).map(mapDelegation),
      };
      set((s) => ({ teams: [...s.teams, team] }));
      return team;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create team';
      set({ error: msg });
      return null;
    }
  },

  dispatchTeam: async (id) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/team/${encodeURIComponent(id)}/dispatch`, {
        method: 'POST',
      });
      await get().fetchTeamDetail(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to dispatch team';
      set({ error: msg });
    }
  },

  pauseTeam: async (id) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/team/${encodeURIComponent(id)}/pause`, {
        method: 'POST',
      });
      set((s) => ({
        teams: s.teams.map((t) => t.id === id ? { ...t, status: 'paused' as const } : t),
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to pause team';
      set({ error: msg });
    }
  },

  resumeTeam: async (id) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/team/${encodeURIComponent(id)}/resume`, {
        method: 'POST',
      });
      await get().fetchTeamDetail(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to resume team';
      set({ error: msg });
    }
  },

  reassignSubtask: async (teamId, subtaskId, newAgent) => {
    set({ error: null });
    try {
      await apiFetch(`/api/hermes/team/${encodeURIComponent(teamId)}/reassign`, {
        method: 'POST',
        body: JSON.stringify({ subtaskId, newAgent }),
      });
      await get().fetchTeamDetail(teamId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to reassign subtask';
      set({ error: msg });
    }
  },

  setSelectedTeamId: (id) => set({ selectedTeamId: id }),

  startPolling: () => {
    const { polling, pollingIntervalId } = get();
    if (polling) return;
    if (pollingIntervalId) clearInterval(pollingIntervalId);

    const id = setInterval(() => {
      get().fetchTeams().catch(() => {});
    }, 5000);
    set({ polling: true, pollingIntervalId: id });

    // Fire immediately
    get().fetchTeams().catch(() => {});
  },

  stopPolling: () => {
    const { pollingIntervalId } = get();
    if (pollingIntervalId) {
      clearInterval(pollingIntervalId);
    }
    set({ polling: false, pollingIntervalId: null });
  },
}));
