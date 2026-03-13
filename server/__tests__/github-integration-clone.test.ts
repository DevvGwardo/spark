import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cloneManagerMocks = vi.hoisted(() => ({
  ensureRepoClone: vi.fn(),
  forkRepository: vi.fn(),
  getManagedRepoClone: vi.fn(),
}))

vi.mock('../repo-clone-manager', () => ({
  ensureRepoClone: cloneManagerMocks.ensureRepoClone,
  forkRepository: cloneManagerMocks.forkRepository,
  getManagedRepoClone: cloneManagerMocks.getManagedRepoClone,
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

describe('GitHub clone routes', () => {
  beforeEach(() => {
    cloneManagerMocks.ensureRepoClone.mockResolvedValue({
      exists: true,
      path: '/Users/devgwardo/.cloudchat/repos/octo/cloudchat',
    })
    cloneManagerMocks.getManagedRepoClone.mockResolvedValue({
      exists: true,
      path: '/Users/devgwardo/.cloudchat/repos/octo/cloudchat',
    })
    cloneManagerMocks.forkRepository.mockResolvedValue({
      owner: 'devgwardo',
      repo: 'cloudchat',
      fullName: 'devgwardo/cloudchat',
      defaultBranch: 'main',
      htmlUrl: 'https://github.com/devgwardo/cloudchat',
      clone: {
        exists: true,
        path: '/Users/devgwardo/.cloudchat/repos/devgwardo/cloudchat',
      },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns local clone metadata when cloning a repository', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'clone-repo',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          branch: 'main',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(cloneManagerMocks.ensureRepoClone).toHaveBeenCalledWith({
        owner: 'octo',
        repo: 'cloudchat',
        pat: 'ghp_test',
        branch: 'main',
      })
      expect(body.clone.path).toContain('/octo/cloudchat')
      expect(body.repo.localClone.exists).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('returns the forked working copy metadata after forking a repository', async () => {
    cloneManagerMocks.getManagedRepoClone.mockResolvedValue({
      exists: true,
      path: '/Users/devgwardo/.cloudchat/repos/devgwardo/cloudchat',
    })

    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'fork-repo',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          branch: 'main',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(cloneManagerMocks.forkRepository).toHaveBeenCalledWith({
        owner: 'octo',
        repo: 'cloudchat',
        pat: 'ghp_test',
        branch: 'main',
      })
      expect(body.repo.full_name).toBe('devgwardo/cloudchat')
      expect(body.sourceRepo.fullName).toBe('octo/cloudchat')
      expect(body.repo.localClone.path).toContain('/devgwardo/cloudchat')
    } finally {
      await server.close()
    }
  })
})
