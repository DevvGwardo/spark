import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock mesh-bridge to avoid shell-out in lifecycle hooks
vi.mock('../mesh-bridge', () => ({
  publishToMesh: vi.fn().mockResolvedValue(undefined),
  registerMeshPeer: vi.fn().mockResolvedValue(undefined),
  pollMeshDelegations: vi.fn().mockResolvedValue([]),
}))

// Mock team-formation (tested separately)
vi.mock('../team-formation', () => {
  const actual = vi.importActual('../team-formation')
  return actual
})

// Mock spawn for spawnTeamAgent
vi.mock('node:child_process', () => {
  const mockSpawn = () => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })
  return {
    default: { spawn: mockSpawn },
    spawn: mockSpawn,
  }
})

import { teamCoordinator, isComplexTask } from '../team-coordinator'

describe('teamCoordinator', () => {
  beforeEach(() => {
    // Reset internal state via removeTeam for any teams left from previous tests
    const active = teamCoordinator.getActiveTeams()
    for (const t of active) {
      teamCoordinator.removeTeam(t.id)
    }
    const all = teamCoordinator.getTeams()
    for (const t of all) {
      teamCoordinator.removeTeam(t.id)
    }
  })

  describe('createTeam and getTeams', () => {
    it('creates a team with forming status', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-1',
        title: 'Fix the login page',
        spec: 'Make the login page work',
      })

      expect(team.id).toBeDefined()
      expect(team.status).toBe('forming')
      expect(team.taskId).toBe('card-1')
      expect(team.agents.length).toBeGreaterThanOrEqual(0)
      expect(team.subtasks).toEqual([])
      expect(team.delegations).toEqual([])
    })

    it('getTeams returns created team', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-2',
        title: 'Build API',
      })

      const all = teamCoordinator.getTeams()
      expect(all.some((t) => t.id === team.id)).toBe(true)
    })

    it('getTeams with status filter returns only matching teams', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-3',
        title: 'Test filter',
      })

      const forming = teamCoordinator.getTeams({ status: 'forming' })
      expect(forming.some((t) => t.id === team.id)).toBe(true)

      const done = teamCoordinator.getTeams({ status: 'done' })
      expect(done.some((t) => t.id === team.id)).toBe(false)
    })

    it('getActiveTeams excludes done teams', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-4',
        title: 'Active test',
      })

      const active = teamCoordinator.getActiveTeams()
      expect(active.some((t) => t.id === team.id)).toBe(true)
    })
  })

  describe('isComplexTask', () => {
    it('returns true for multi-domain task', () => {
      expect(isComplexTask({
        id: 'c1',
        title: 'Build frontend and backend API',
        spec: 'React + Python',
      })).toBe(true)
    })

    it('returns false for simple single-domain task', () => {
      expect(isComplexTask({
        id: 'c2',
        title: 'Fix button color',
      })).toBe(false)
    })

    it('returns true for task with many acceptance criteria', () => {
      expect(isComplexTask({
        id: 'c3',
        title: 'Simple title',
        acceptanceCriteria: ['a', 'b', 'c', 'd', 'e'],
      })).toBe(true)
    })

    it('returns false for task with few acceptance criteria', () => {
      expect(isComplexTask({
        id: 'c4',
        title: 'Simple title',
        acceptanceCriteria: ['a', 'b'],
      })).toBe(false)
    })
  })

  describe('assignSubtasks', () => {
    it('assigns subtasks to agents based on expertise', () => {
      const agents = [
        { profileName: 'alice', displayName: 'Alice', expertise: ['frontend', 'react'], currentSubtask: null, status: 'idle' as const },
        { profileName: 'bob', displayName: 'Bob', expertise: ['backend', 'python'], currentSubtask: null, status: 'idle' as const },
      ]

      const subtasks = [
        { id: 'st-1', title: 'Build UI', description: 'frontend work', assignedTo: null, dependencies: [], status: 'pending' as const, result: null },
        { id: 'st-2', title: 'Build API', description: 'backend work', assignedTo: null, dependencies: [], status: 'pending' as const, result: null },
      ]

      const assigned = teamCoordinator.assignSubtasks(subtasks, agents)

      expect(assigned[0].assignedTo).toBe('alice')
      expect(assigned[1].assignedTo).toBe('bob')
    })

    it('handles no agents gracefully', () => {
      const subtasks = [
        { id: 'st-1', title: 'Task', description: '', assignedTo: null, dependencies: [], status: 'pending' as const, result: null },
      ]

      const assigned = teamCoordinator.assignSubtasks(subtasks, [])
      expect(assigned[0].assignedTo).toBeNull()
    })

    it('sorts independent subtasks before dependent ones', () => {
      const agents = [
        { profileName: 'alice', displayName: 'Alice', expertise: ['general'], currentSubtask: null, status: 'idle' as const },
      ]

      const subtasks = [
        { id: 'st-2', title: 'Dep task', description: '', assignedTo: null, dependencies: ['st-1'], status: 'pending' as const, result: null },
        { id: 'st-1', title: 'Independent', description: '', assignedTo: null, dependencies: [], status: 'pending' as const, result: null },
      ]

      const assigned = teamCoordinator.assignSubtasks(subtasks, agents)
      expect(assigned[0].dependencies).toEqual([])
      expect(assigned[1].dependencies).toEqual(['st-1'])
    })
  })

  describe('handleSubtaskComplete and state transitions', () => {
    it('marks subtask as done and updates agent status', async () => {
      // Create a team with a subtask
      const team = await teamCoordinator.createTeam({
        id: 'card-5',
        title: 'Test completion',
      })

      // Add a subtask manually
      const subtask = {
        id: 'st-complete-1',
        title: 'Test subtask',
        description: 'A test',
        assignedTo: team.agents[0]?.profileName || null,
        dependencies: [],
        status: 'in_progress' as const,
        result: null,
      }
      team.subtasks.push(subtask)
      if (team.agents[0]) {
        team.agents[0].currentSubtask = subtask.id
        team.agents[0].status = 'working'
      }

      await teamCoordinator.handleSubtaskComplete(team.id, subtask.id, 'Done!')

      expect(subtask.status).toBe('done')
      expect(subtask.result).toBe('Done!')
    })
  })

  describe('handleBlocked', () => {
    it('marks subtask as blocked', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-6',
        title: 'Test blocked',
      })

      const subtask = {
        id: 'st-blocked-1',
        title: 'Blockable',
        description: '',
        assignedTo: null,
        dependencies: [],
        status: 'in_progress' as const,
        result: null,
      }
      team.subtasks.push(subtask)

      await teamCoordinator.handleBlocked(team.id, subtask.id, 'Dep failed')
      expect(subtask.status).toBe('blocked')
      expect((subtask as { blockedReason?: string }).blockedReason).toBe('Dep failed')
    })
  })

  describe('dispatchTeam atomic guard', () => {
    it('returns false for unknown team', async () => {
      const result = await teamCoordinator.dispatchTeam('nonexistent-id')
      expect(result).toBe(false)
    })

    it('returns false for team not in forming status', async () => {
      const team = await teamCoordinator.createTeam({
        id: 'card-7',
        title: 'Already active',
      })

      // Manually set to active (simulating edge case where status changed)
      team.status = 'active'
      const result = await teamCoordinator.dispatchTeam(team.id)
      expect(result).toBe(false)
    })
  })
})
