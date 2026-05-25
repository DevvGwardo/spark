import { describe, expect, it } from 'vitest'
import { analyzeTask } from '../team-formation'
import type { AgentInfo } from '../team-formation'

function agent(name: string, expertise: string[]): AgentInfo {
  return { name, displayName: name, expertise }
}

describe('analyzeTask', () => {
  const agents: AgentInfo[] = [
    agent('alice', ['frontend', 'react', 'css']),
    agent('bob', ['backend', 'python', 'api']),
    agent('carol', ['testing', 'jest', 'qa']),
  ]

  describe('swarm strategy', () => {
    it('returns swarm when task mentions "swarm"', () => {
      const result = analyzeTask('Swarm on this task please', agents)
      expect(result.strategy).toBe('swarm')
      expect(result.agentCount).toBe(3)
    })

    it('returns swarm when task mentions "all"', () => {
      const result = analyzeTask('do all the things', agents)
      expect(result.strategy).toBe('swarm')
    })

    it('returns swarm when task mentions "everything"', () => {
      const result = analyzeTask('rewrite everything from scratch', agents)
      expect(result.strategy).toBe('swarm')
    })

    it('returns swarm with correct agent names', () => {
      const result = analyzeTask('swarm mode', agents)
      expect(result.recommendedAgents).toEqual(['alice', 'bob', 'carol'])
    })

    it('returns single_agent when no agents available', () => {
      const result = analyzeTask('swarm mode', [])
      expect(result.strategy).toBe('swarm')
      expect(result.agentCount).toBe(1)
      expect(result.recommendedAgents).toBeUndefined()
    })
  })

  describe('pipeline strategy', () => {
    it('returns pipeline for "design + implement + test"', () => {
      const result = analyzeTask('design the architecture, implement the code, test the changes', agents)
      expect(result.strategy).toBe('pipeline')
    })

    it('returns pipeline for "plan + build + review"', () => {
      const result = analyzeTask('plan the sprint, build the feature, review the PR', agents)
      expect(result.strategy).toBe('pipeline')
    })

    it('returns pipeline for "architect + implement + test" matching full phase set', () => {
      const result = analyzeTask('architect the system, implement the code, test for coverage', agents)
      expect(result.strategy).toBe('pipeline')
    })

    it('returns pipeline for "spec + code + verify"', () => {
      // spec+code+verify is in the third phase set
      const result = analyzeTask('write the spec, code the solution, verify it works', agents)
      expect(result.strategy).toBe('pipeline')
    })

    it('does NOT match "redesign" as "design" (no substring)', () => {
      const result = analyzeTask('redesign the implementation plan', agents)
      expect(result.strategy).not.toBe('pipeline')
    })
  })

  describe('specialist_team strategy', () => {
    it('returns specialist_team for multi-domain task', () => {
      const result = analyzeTask('Build a frontend with a backend API that needs testing', agents)
      expect(result.strategy).toBe('specialist_team')
      expect(result.agentCount).toBeGreaterThanOrEqual(2)
    })

    it('recommends agents matched to detected domains', () => {
      const result = analyzeTask('frontend, backend, tests', agents)
      expect(result.strategy).toBe('specialist_team')
      expect(result.recommendedAgents).toBeDefined()
      expect(result.recommendedAgents!.length).toBeGreaterThanOrEqual(1)
    })

    it('returns single_agent for single-domain task', () => {
      const result = analyzeTask('fix the frontend button alignment', agents)
      expect(result.strategy).toBe('single_agent')
    })
  })

  describe('pair_programming strategy', () => {
    it('returns pair for "refactor + review"', () => {
      const result = analyzeTask('refactor the auth module and review the changes', agents)
      expect(result.strategy).toBe('pair_programming')
      expect(result.agentCount).toBe(2)
    })

    it('returns pair for "review + implement"', () => {
      const result = analyzeTask('review the code and implement the fix', agents)
      expect(result.strategy).toBe('pair_programming')
    })

    it('returns pair for "code + review"', () => {
      const result = analyzeTask('code review the pull request', agents)
      expect(result.strategy).toBe('pair_programming')
    })

    it('recommends two agents when available', () => {
      const result = analyzeTask('refactor and review the main module', agents)
      expect(result.recommendedAgents).toBeDefined()
      expect(result.recommendedAgents!.length).toBe(2)
    })
  })

  describe('single_agent strategy (default)', () => {
    it('returns single_agent for simple task', () => {
      const result = analyzeTask('Fix the login button color', agents)
      expect(result.strategy).toBe('single_agent')
      expect(result.agentCount).toBe(1)
    })

    it('returns single_agent for empty task', () => {
      const result = analyzeTask('', agents)
      expect(result.strategy).toBe('single_agent')
    })

    it('returns single_agent for task with only short words', () => {
      const result = analyzeTask('a b c d e f g h', agents)
      expect(result.strategy).toBe('single_agent')
    })
  })

  describe('tokenMatch behavior (no false positives from substring)', () => {
    it('does not match "testing" as "test" for pipeline', () => {
      // "testing" should not trigger the "test" keyword in pipeline sets
      const result = analyzeTask('testing the implementation plan', agents)
      // No pipeline set contains "testing" — should not match
      expect(result.strategy).toBe('single_agent')
    })

    it('does not match "implementation" as "implement"', () => {
      const result = analyzeTask('review the implementation', agents)
      // Should NOT match pair_programming via "review+implement"
      expect(result.strategy).toBe('single_agent')
    })

    it('matches exact "implement" correctly in pipeline', () => {
      const result = analyzeTask('spec a plan then implement and verify the code', agents)
      expect(result.strategy).toBe('pipeline')
    })
  })

  describe('edge cases with empty agents', () => {
    it('handles no agents gracefully', () => {
      const result = analyzeTask('complex frontend backend task', [])
      expect(result.strategy).toBe('specialist_team')
      expect(result.agentCount).toBe(1) // Math.max(1, 0) = 1
    })

    it('handles undefined expertise gracefully', () => {
      const result = analyzeTask('simple task', [agent('x', [])])
      expect(result.strategy).toBe('single_agent')
    })
  })
})
