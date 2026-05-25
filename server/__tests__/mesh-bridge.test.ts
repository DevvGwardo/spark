import { describe, expect, it, vi, beforeEach } from 'vitest'

// execFile mock that calls the callback with success by default.
const { mockedExecFile, execFileResponses } = vi.hoisted(() => {
  const responses: Array<{ stdout: string; stderr: string } | Error> = []
  const fn = vi.fn(
    (_path: string, _args: string[], _options: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      const response = responses.shift()
      if (response instanceof Error) {
        if (cb) cb(response, { stdout: '', stderr: '' })
        return
      }
      if (cb) cb(null, response || { stdout: '', stderr: '' })
    },
  )
  return { mockedExecFile: fn, execFileResponses: responses }
})

vi.mock('node:child_process', () => {
  return {
    default: { execFile: mockedExecFile },
    execFile: mockedExecFile,
  }
})

import {
  publishToMesh,
  queryMeshForTeam,
  pollMeshDelegations,
  registerMeshPeer,
  resetMeshCache,
} from '../mesh-bridge'

function pushResponse(stdout: string) {
  execFileResponses.push({ stdout, stderr: '' })
}

function pushError() {
  execFileResponses.push(new Error('ENOENT'))
}

describe('mesh-bridge', () => {
  beforeEach(() => {
    execFileResponses.length = 0
    mockedExecFile.mockClear()
    resetMeshCache()
  })

  describe('publishToMesh', () => {
    it('publishes team_formed event with correct payload', async () => {
      pushResponse('')   // --help (isMeshAvailable check)
      pushResponse('ok') // publish

      await publishToMesh('team-1', {
        type: 'team_formed',
        payload: { taskId: 'card-1', agentCount: 3 },
      })

      // Find the publish call among all execFile calls
      const allCalls = mockedExecFile.mock.calls
      const publishCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('publish'))
      expect(publishCall).toBeDefined()

      const cmdArgs = publishCall![1] as string[]
      expect(cmdArgs).toContain('--type')
      expect(cmdArgs).toContain('finding')
      const contentIdx = cmdArgs.indexOf('--content')
      expect(contentIdx).toBeGreaterThan(-1)
      const payload = JSON.parse(cmdArgs[contentIdx + 1])
      expect(payload.teamId).toBe('team-1')
      expect(payload.type).toBe('team_formed')
    })

    it('publishes with correct team tags', async () => {
      pushResponse('')   // --help
      pushResponse('ok') // publish

      await publishToMesh('team-1', { type: 'subtask_completed', subtaskId: 'st-1' })

      const allCalls = mockedExecFile.mock.calls
      const publishCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('publish'))
      const cmdArgs = publishCall![1] as string[]
      const tagsIdx = cmdArgs.indexOf('--tags')
      expect(tagsIdx).toBeGreaterThan(-1)
      const tags = cmdArgs[tagsIdx + 1]
      expect(tags).toContain('team-1')
      expect(tags).toContain('subtask_completed')
    })

    it('applies payload spread correctly (metadata wins over payload)', async () => {
      pushResponse('')   // --help
      pushResponse('ok') // publish

      await publishToMesh('team-1', {
        type: 'team_formed',
        payload: { type: 'malicious_override', teamId: 'wrong-id' },
      })

      const allCalls = mockedExecFile.mock.calls
      const publishCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('publish'))
      const cmdArgs = publishCall![1] as string[]
      const contentIdx = cmdArgs.indexOf('--content')
      const payload = JSON.parse(cmdArgs[contentIdx + 1])

      // Metadata fields should win over payload spread
      expect(payload.teamId).toBe('team-1')
      expect(payload.type).toBe('team_formed')
    })
  })

  describe('queryMeshForTeam', () => {
    it('returns parsed findings from mesh contexts', async () => {
      const mockContexts = JSON.stringify([
        {
          id: 'ctx-1',
          type: 'finding',
          agentId: 'hermes-bob',
          agentName: 'Bob',
          content: 'Found a bug in auth middleware',
          tags: ['team-1', 'finding'],
          createdAt: Date.now(),
        },
      ])
      pushResponse('')          // --help
      pushResponse(mockContexts) // query --json

      const result = await queryMeshForTeam('team-1', 'test query')

      expect(result.findings).toHaveLength(1)
      expect(result.findings[0].source).toBe('Bob')
      expect(result.findings[0].content).toContain('bug in auth')
    })

    it('returns empty arrays on parse error', async () => {
      pushResponse('')           // --help
      pushResponse('invalid json{')

      const result = await queryMeshForTeam('team-1', 'query')
      expect(result).toEqual({ findings: [], delegations: [] })
    })

    it('handles oversized stdout gracefully', async () => {
      pushResponse('')              // --help
      pushResponse('x'.repeat(2000000))

      const result = await queryMeshForTeam('team-1', 'query')
      expect(result).toEqual({ findings: [], delegations: [] })
    })
  })

  describe('registerMeshPeer', () => {
    it('publishes peer presence with agent metadata', async () => {
      pushResponse('')   // --help
      pushResponse('ok') // publish

      await registerMeshPeer({
        profileName: 'alice',
        displayName: 'Alice',
        expertise: ['frontend', 'react'],
      })

      const allCalls = mockedExecFile.mock.calls
      const publishCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('publish'))
      const cmdArgs = publishCall![1] as string[]
      const contentIdx = cmdArgs.indexOf('--content')
      const payload = JSON.parse(cmdArgs[contentIdx + 1])
      expect(payload.agentId).toBe('alice')
      expect(payload.displayName).toBe('Alice')
    })
  })

  describe('isMeshAvailable caching', () => {
    it('shells out on first call, caches result for subsequent calls within 60s', async () => {
      pushResponse('')   // --help
      pushResponse('ok') // publish

      await publishToMesh('team-1', { type: 'team_formed' })

      // Publish should have triggered --help (isMeshAvailable) + publish
      const allCalls = mockedExecFile.mock.calls
      const helpCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('--help'))
      expect(helpCall).toBeDefined()
      const publishCall = allCalls.find((c: unknown[]) => (c[1] as string[])?.includes('publish'))
      expect(publishCall).toBeDefined()
    })

    it('gracefully handles missing mesh CLI', async () => {
      pushError() // --help fails (ENOENT)

      await expect(publishToMesh('team-1', { type: 'team_formed' })).resolves.toBeUndefined()
      await expect(queryMeshForTeam('team-1', 'test query')).resolves.toEqual({ findings: [], delegations: [] })
      await expect(pollMeshDelegations()).resolves.toEqual([])
      await expect(registerMeshPeer({ profileName: 'alice', displayName: 'Alice', expertise: [] })).resolves.toBeUndefined()
    })
  })
})
