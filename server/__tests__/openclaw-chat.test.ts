import type { AddressInfo } from 'net'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openclawMocks = vi.hoisted(() => ({
  getOpenClawModels: vi.fn(),
  runOpenClawTurn: vi.fn(),
}))

const cloneManagerMocks = vi.hoisted(() => ({
  ensureRepoClone: vi.fn(),
}))

vi.mock('../openclaw', () => ({
  getOpenClawModels: openclawMocks.getOpenClawModels,
  runOpenClawTurn: openclawMocks.runOpenClawTurn,
}))

vi.mock('../repo-clone-manager', () => ({
  ensureRepoClone: cloneManagerMocks.ensureRepoClone,
}))

async function createTestServer() {
  const { createApp } = await import('../index')
  const app = createApp()

  return await new Promise<{
    close: () => Promise<void>
    url: string
  }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error)
                return
              }
              closeResolve()
            })
          }),
      })
    })
  })
}

describe('OpenClaw provider chat route', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    openclawMocks.runOpenClawTurn.mockResolvedValue({
      text: 'ok',
      model: 'kimi-coding/k2p5',
      usage: {
        input: 12,
        output: 2,
        total: 14,
      },
      durationMs: 1500,
    })

    openclawMocks.getOpenClawModels.mockResolvedValue({
      defaultModel: 'kimi-coding/k2p5',
      models: ['kimi-coding/k2p5', 'google/gemini-2.5-pro'],
    })
    cloneManagerMocks.ensureRepoClone.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  })

  function createLocalRepoClone() {
    const repoDir = mkdtempSync(join(tmpdir(), 'cloudchat-openclaw-'))
    mkdirSync(join(repoDir, '.git'))
    tempDirs.push(repoDir)
    return repoDir
  }

  it('routes chat requests through OpenClaw and emits an AI SDK data stream', async () => {
    const repoDir = createLocalRepoClone()
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          conversation_id: 'conv-123',
          system_prompt: 'Be concise.',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            localPath: repoDir,
          },
          repo_edit_intent: false,
          repo_file_tree: ['src/App.tsx', 'src/hooks/useChat.ts'],
          messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
          ],
        }),
      })

      const body = await response.text()

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-vercel-ai-data-stream')).toBe('v1')
      expect(body).toContain('0:"ok"')
      expect(body).toContain('finishReason')
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Reply with exactly: ok',
          model: 'default',
          sessionId: 'conv-123',
          cwd: repoDir,
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('You are working on the GitHub repository octo/cloudchat.'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('read-only repository help'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('src/App.tsx'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining(repoDir),
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('auto-clones the attached repository for OpenClaw when a GitHub token is available', async () => {
    cloneManagerMocks.ensureRepoClone.mockResolvedValue({
      exists: true,
      path: '/tmp/cloudchat-managed-clone',
    })

    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
          },
          messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
          ],
        }),
      })

      expect(response.ok).toBe(true)
      expect(cloneManagerMocks.ensureRepoClone).toHaveBeenCalledWith({
        owner: 'octo',
        repo: 'cloudchat',
        pat: 'ghp_validtokenformat1234567890abcdef12345',
        branch: 'main',
      })
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/tmp/cloudchat-managed-clone',
          systemPrompt: expect.stringContaining('/tmp/cloudchat-managed-clone'),
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('prefers the PAT-backed managed clone over an attached local path for OpenClaw', async () => {
    const repoDir = createLocalRepoClone()
    cloneManagerMocks.ensureRepoClone.mockResolvedValue({
      exists: true,
      path: '/tmp/cloudchat-pat-clone',
    })

    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          github_pat: 'ghp_validtokenformat1234567890abcdef12345',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
            default_branch: 'main',
            localPath: repoDir,
          },
          messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
          ],
        }),
      })

      expect(response.ok).toBe(true)
      expect(cloneManagerMocks.ensureRepoClone).toHaveBeenCalledWith({
        owner: 'octo',
        repo: 'cloudchat',
        pat: 'ghp_validtokenformat1234567890abcdef12345',
        branch: 'main',
      })
      expect(openclawMocks.runOpenClawTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/tmp/cloudchat-pat-clone',
          systemPrompt: expect.stringContaining('/tmp/cloudchat-pat-clone'),
        }),
      )
      expect(openclawMocks.runOpenClawTurn).not.toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: repoDir,
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('returns 422 when OpenClaw repo mode has neither a token nor a verified local clone', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          model: 'default',
          activeRepo: {
            owner: 'octo',
            name: 'cloudchat',
          },
          messages: [
            { role: 'user', content: 'Analyze the codebase' },
          ],
        }),
      })

      expect(response.status).toBe(422)
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining('GitHub token is missing or invalid'),
      })
      expect(openclawMocks.runOpenClawTurn).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })

  it('validates OpenClaw without requiring an API key', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/validate-key`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'openclaw',
          api_key: '',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body).toEqual({
        valid: true,
        defaultModel: 'kimi-coding/k2p5',
        models: ['kimi-coding/k2p5', 'google/gemini-2.5-pro'],
      })
      expect(openclawMocks.getOpenClawModels).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })
})
