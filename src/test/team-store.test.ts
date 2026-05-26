import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useTeamStore } from '@/stores/team-store';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock getApiBaseUrl
vi.mock('@/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
}));

function makeActiveTeam(id: string, status: string, taskId?: string) {
  return { id, taskId: taskId || '', agentCount: 2, status, createdAt: Date.now(), };
}

function makeTeamDetail(id: string, status: string, taskId?: string) {
  return {
    team: {
      id,
      taskId: taskId || '',
      agents: [
        { profileName: 'alice', displayName: 'Alice', expertise: ['frontend'], status: 'idle', currentSubtask: null },
        { profileName: 'bob', displayName: 'Bob', expertise: ['backend'], status: 'idle', currentSubtask: null },
      ],
      subtasks: [
        { id: 'st-1', title: 'Build UI', description: '', assignedTo: 'alice', dependencies: [], status: 'pending', result: null },
      ],
      delegations: [],
      status,
      sharedContext: {},
      createdAt: Date.now(),
    },
  };
}

describe('useTeamStore', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    useTeamStore.setState({
      teams: [],
      selectedTeamId: null,
      loading: false,
      polling: false,
      pollingIntervalId: null,
      error: null,
    });
  });

  describe('fetchTeams', () => {
    it('fetches active and completed teams', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            teams: [makeActiveTeam('team-1', 'active')],
            total: 1,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            teams: [makeActiveTeam('team-2', 'done')],
            total: 1,
          }),
        });

      await useTeamStore.getState().fetchTeams();

      const { teams } = useTeamStore.getState();
      expect(teams).toHaveLength(2);
      expect(teams.some((t) => t.id === 'team-1' && t.status === 'active')).toBe(true);
      expect(teams.some((t) => t.id === 'team-2' && t.status === 'done')).toBe(true);
    });

    it('preserves detail data when polling merges active summary', async () => {
      // First, load detail data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeTeamDetail('team-3', 'active')),
      });

      await useTeamStore.getState().fetchTeamDetail('team-3');

      // Now poll with active summary
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ teams: [makeActiveTeam('team-3', 'active')], total: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ teams: [], total: 0 }),
        });

      await useTeamStore.getState().fetchTeams();

      const { teams } = useTeamStore.getState();
      const team = teams.find((t) => t.id === 'team-3')!;
      expect(team.agents).toHaveLength(2);
      expect(team.subtasks).toHaveLength(1);
      expect(team.agents[0].name).toBe('Alice');
      expect(team.agents[1].id).toBe('bob');
      expect(team.subtasks[0].title).toBe('Build UI');
    });

    it('creates skeleton for new teams discovered via active endpoint', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ teams: [makeActiveTeam('team-4', 'forming')], total: 1 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ teams: [], total: 0 }),
        });

      await useTeamStore.getState().fetchTeams();

      const { teams } = useTeamStore.getState();
      const team = teams.find((t) => t.id === 'team-4')!;
      expect(team.status).toBe('forming');
      expect(team.agents).toEqual([]);
      expect(team.subtasks).toEqual([]);
    });

    it('handles failed completed endpoint gracefully', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ teams: [makeActiveTeam('team-5', 'active')], total: 1 }),
        })
        .mockRejectedValueOnce(new Error('Network error'));

      await useTeamStore.getState().fetchTeams();

      const { teams, error } = useTeamStore.getState();
      expect(teams).toHaveLength(1);
      expect(error).toBeNull();
    });
  });

  describe('fetchTeamDetail', () => {
    it('maps API fields to frontend types correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeTeamDetail('team-detail-1', 'active')),
      });

      await useTeamStore.getState().fetchTeamDetail('team-detail-1');

      const { teams } = useTeamStore.getState();
      const team = teams.find((t) => t.id === 'team-detail-1')!;

      // Agent mapping
      expect(team.agents[0].id).toBe('alice');
      expect(team.agents[0].name).toBe('Alice');

      // Subtask mapping
      expect(team.subtasks[0].assignedAgent).toBe('alice');

      // Status
      expect(team.status).toBe('active');
    });

    it('sets selectedTeamId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeTeamDetail('team-detail-2', 'forming')),
      });

      await useTeamStore.getState().fetchTeamDetail('team-detail-2');
      expect(useTeamStore.getState().selectedTeamId).toBe('team-detail-2');
    });

    it('updates existing team instead of duplicating it', async () => {
      // First load the team
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeTeamDetail('team-update-1', 'active')),
      });
      await useTeamStore.getState().fetchTeamDetail('team-update-1');

      expect(useTeamStore.getState().teams).toHaveLength(1);

      // Now refresh the same team with new data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          team: {
            id: 'team-update-1',
            taskId: 'card-update',
            agents: [
              { profileName: 'charlie', displayName: 'Charlie', expertise: ['devops'], status: 'working', currentSubtask: null },
            ],
            subtasks: [],
            delegations: [],
            status: 'synthesizing',
            sharedContext: {},
            createdAt: Date.now(),
          },
        }),
      });
      await useTeamStore.getState().fetchTeamDetail('team-update-1');

      const { teams } = useTeamStore.getState();
      // Should still be 1 team, not 2
      expect(teams).toHaveLength(1);
      const team = teams[0];
      // Status should be updated
      expect(team.status).toBe('synthesizing');
      // Agents should be replaced with new data
      expect(team.agents).toHaveLength(1);
      expect(team.agents[0].id).toBe('charlie');
      expect(team.agents[0].name).toBe('Charlie');
    });
  });

  describe('fetchTeamContext', () => {
    it('merges context entries into existing team', async () => {
      // Load team detail first
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeTeamDetail('team-ctx-1', 'active')),
      });
      await useTeamStore.getState().fetchTeamDetail('team-ctx-1');

      // Load context
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          entries: [
            { id: 'ctx-1', teamId: 'team-ctx-1', type: 'finding', content: 'Found a bug', author: 'alice', importance: 2, tags: [], timestamp: Date.now() },
          ],
          total: 1,
        }),
      });

      const entries = await useTeamStore.getState().fetchTeamContext('team-ctx-1');
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('finding');
      expect(entries[0].author).toBe('alice');

      // Verify merge into store
      const team = useTeamStore.getState().teams.find((t) => t.id === 'team-ctx-1')!;
      expect(team.context).toHaveLength(1);
    });
  });

  describe('createTeam', () => {
    it('creates team and adds to store', async () => {
      const apiResponse = {
        team: {
          id: 'new-team-1',
          taskId: 'card-new',
          agents: [{ profileName: 'alice', displayName: 'Alice', expertise: ['frontend'], status: 'idle' }],
          subtasks: [],
          delegations: [],
          status: 'forming',
          createdAt: Date.now(),
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(apiResponse),
      });

      const team = await useTeamStore.getState().createTeam('card-new', 'New Task');

      expect(team).not.toBeNull();
      expect(team!.id).toBe('new-team-1');
      expect(team!.status).toBe('forming');
      expect(team!.agents).toHaveLength(1);
      expect(team!.agents[0].id).toBe('alice');

      expect(useTeamStore.getState().teams).toHaveLength(1);
    });
  });

  describe('polling lifecycle', () => {
    it('starts and stops polling', () => {
      vi.useFakeTimers();

      useTeamStore.getState().startPolling();
      expect(useTeamStore.getState().polling).toBe(true);

      useTeamStore.getState().stopPolling();
      expect(useTeamStore.getState().polling).toBe(false);

      vi.useRealTimers();
    });
  });
});
