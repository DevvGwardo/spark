import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TeamPanel } from '@/components/sidebar/TeamPanel';
import { useTeamStore } from '@/stores/team-store';

// Mock child components that may use store hooks not available in test
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Mock fetch so the panel's useEffect doesn't make real requests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('@/lib/api', () => ({
  getApiBaseUrl: () => 'http://localhost:3001',
}));

describe('TeamPanel', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    // Make fetch resolve immediately with empty data so loading doesn't stick.
    // fetchTeams calls Promise.all([active, completed]) = 2 fetch calls.
    mockFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ teams: [], total: 0 }) }),
    );

    useTeamStore.setState({
      teams: [],
      selectedTeamId: null,
      loading: false,
      polling: false,
      pollingIntervalId: null,
      error: null,
    });
  });

  it('renders empty state when no teams', async () => {
    render(<TeamPanel />);
    // Wait for the effect to settle (loading -> false after fetch resolves)
    await waitFor(() => {
      expect(screen.getByText('No teams yet')).toBeDefined();
    });
  });

  it('renders team name and status for active teams', async () => {
    useTeamStore.setState({
      teams: [
        {
          id: 'team-1',
          name: 'Team - card-abc',
          status: 'active',
          agents: [
            { id: 'alice', name: 'Alice', status: 'working' },
            { id: 'bob', name: 'Bob', status: 'idle' },
          ],
          subtasks: [
            { id: 'st-1', title: 'Build UI', status: 'in_progress', assignedAgent: 'alice', dependencies: [] },
          ],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);

    await waitFor(() => {
      expect(screen.getByText('Team - card-abc')).toBeDefined();
    });
    expect(screen.getByText('active')).toBeDefined();
    expect(screen.getByText('2 agents')).toBeDefined();
  });

  it('renders completed teams in a separate section', async () => {
    // Mock fetch to return the pre-set team so fetchTeams doesn't overwrite
    mockFetch.mockImplementation((_url: string) => {
      if (_url.includes('completed')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ teams: [{ id: 'team-done-1', taskId: '', agentCount: 0, status: 'done', createdAt: 1 }], total: 1 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ teams: [], total: 0 }) });
    });

    useTeamStore.setState({
      teams: [
        {
          id: 'team-done-1',
          name: 'Team - completed-task',
          status: 'done',
          agents: [],
          subtasks: [],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);

    await waitFor(() => {
      expect(screen.getByText((content) => content.startsWith('Completed'))).toBeDefined();
    });
    expect(screen.getByText('Team - completed-task')).toBeDefined();
  });

  it('shows Dispatch button for forming teams', async () => {
    useTeamStore.setState({
      teams: [
        {
          id: 'team-forming-1',
          name: 'Team - new',
          status: 'forming',
          agents: [{ id: 'alice', name: 'Alice', status: 'idle' }],
          subtasks: [],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);
    await waitFor(() => {
      expect(screen.getByText('Dispatch')).toBeDefined();
    });
  });

  it('shows active Pause button for active teams', async () => {
    useTeamStore.setState({
      teams: [
        {
          id: 'team-active-1',
          name: 'Team - active',
          status: 'active',
          agents: [{ id: 'alice', name: 'Alice', status: 'working' }],
          subtasks: [
            { id: 'st-1', title: 'Work', status: 'in_progress', assignedAgent: 'alice', dependencies: [] },
          ],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);

    const pauseButton = await screen.findByText('Pause');
    expect(pauseButton).toBeDefined();
    expect(pauseButton.closest('button')).not.toBeDisabled();
  });

  it('shows subtask progress and expandable detail', async () => {
    useTeamStore.setState({
      teams: [
        {
          id: 'team-progress-1',
          name: 'Team - progress',
          status: 'active',
          agents: [{ id: 'alice', name: 'Alice', status: 'working', currentSubtask: 'st-1' }],
          subtasks: [
            { id: 'st-1', title: 'Task 1', status: 'done', assignedAgent: 'alice', dependencies: [] },
            { id: 'st-2', title: 'Task 2', status: 'in_progress', assignedAgent: 'alice', dependencies: [] },
          ],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);

    await waitFor(() => {
      expect(screen.getByText('1/2 subtasks')).toBeDefined();
    });
  });

  it('shows delegation chain when present', async () => {
    // Mock fetch to preserve pre-set data
    mockFetch.mockImplementation((_url: string) => {
      if (_url.includes('active')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ teams: [{ id: 'team-deleg-1', taskId: '', agentCount: 2, status: 'active', createdAt: 1 }], total: 1 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ teams: [], total: 0 }) });
    });

    useTeamStore.setState({
      teams: [
        {
          id: 'team-deleg-1',
          name: 'Team - deleg',
          status: 'active',
          agents: [
            { id: 'alice', name: 'Alice', status: 'done' },
            { id: 'bob', name: 'Bob', status: 'working' },
          ],
          subtasks: [
            { id: 'st-1', title: 'Task', status: 'in_progress', assignedAgent: 'bob', dependencies: [] },
          ],
          context: [],
          delegations: [
            { from: 'alice', to: 'bob', subtaskId: 'st-1', status: 'accepted' },
          ],
        },
      ],
    });

    render(<TeamPanel />);

    // Click the team header to expand detail showing delegations
    const header = screen.getByText('Team - deleg');
    header.click();

    await waitFor(() => {
      expect(screen.getByText((content) => content.startsWith('Delegations'))).toBeDefined();
    });
  });

  it('handles review subtask status without crashing', async () => {
    useTeamStore.setState({
      teams: [
        {
          id: 'team-review-1',
          name: 'Team - review',
          status: 'active',
          agents: [],
          subtasks: [
            { id: 'st-1', title: 'Review me', status: 'review', dependencies: [] },
          ],
          context: [],
          delegations: [],
        },
      ],
    });

    render(<TeamPanel />);

    // Click the team header to expand detail showing subtasks
    const header = screen.getByText('Team - review');
    header.click();

    await waitFor(() => {
      expect(screen.getByText('Review me')).toBeDefined();
    });
  });
});
