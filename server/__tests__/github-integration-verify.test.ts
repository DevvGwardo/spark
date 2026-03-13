import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repoVerifierMocks = vi.hoisted(() => ({
  verifyRepoChanges: vi.fn(),
}))

vi.mock('../repo-verifier', () => ({
  verifyRepoChanges: repoVerifierMocks.verifyRepoChanges,
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

describe('GitHub verification route', () => {
  beforeEach(() => {
    repoVerifierMocks.verifyRepoChanges.mockResolvedValue({
      summary: {
        status: 'passed',
        findings: 0,
        commandsRun: 2,
        commandsFailed: 0,
      },
      review: {
        status: 'passed',
        summary: 'No actionable issues found.',
        findings: [],
      },
      commands: [],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('verifies staged repo changes through the shared helper', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'verify-changes',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          baseBranch: 'main',
          provider: 'openai',
          model: 'gpt-5.2',
          apiKey: 'provider-key',
          files: [
            {
              path: 'src/App.tsx',
              action: 'edit',
              content: 'export default function App() { return null }',
              originalContent: 'export default function App() { return <div /> }',
            },
          ],
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.summary.status).toBe('passed')
      expect(repoVerifierMocks.verifyRepoChanges).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'octo',
          repo: 'cloudchat',
          pat: 'ghp_test',
          baseBranch: 'main',
          provider: 'openai',
          model: 'gpt-5.2',
          apiKey: 'provider-key',
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('resolves the branch before reading the recursive repo tree', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/branches/main')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            commit: {
              commit: {
                tree: {
                  sha: 'tree-sha-123',
                },
              },
            },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url.includes('/git/trees/tree-sha-123?recursive=1')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            tree: [
              { path: 'src/App.tsx', type: 'blob', sha: 'blob-sha', size: 10 },
            ],
            truncated: false,
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    })

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'read-tree',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          branch: 'main',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.items).toEqual([
        { path: 'src/App.tsx', type: 'file', sha: 'blob-sha', size: 10 },
      ])
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/repos/octo/cloudchat/branches/main'),
        expect.any(Object),
      )
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/repos/octo/cloudchat/git/trees/tree-sha-123?recursive=1'),
        expect.any(Object),
      )
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })

  it('reads files from the requested ref when one is provided', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/contents/src/App.tsx?ref=feature%2Fbranch')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            content: Buffer.from('export default function App() {}').toString('base64'),
            sha: 'blob-sha',
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    })

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'read-file',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          path: 'src/App.tsx',
          ref: 'feature/branch',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.content).toContain('export default function App() {}')
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/contents/src/App.tsx?ref=feature%2Fbranch'),
        expect.any(Object),
      )
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })

  it('lists repository issues with pagination metadata', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/search/issues?')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            total_count: 63,
            incomplete_results: false,
            items: [
              {
                id: 101,
                number: 17,
                title: 'Fix flaky preview loading',
                body: 'Steps to reproduce...',
                html_url: 'https://github.com/octo/cloudchat/issues/17',
                state: 'open',
                comments: 4,
                created_at: '2026-03-10T10:00:00Z',
                updated_at: '2026-03-11T09:00:00Z',
                user: {
                  login: 'octocat',
                  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
                },
                labels: [
                  { id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' },
                ],
              },
            ],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    })

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'list-issues',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          page: 2,
          sort: 'updated',
          direction: 'desc',
          state: 'open',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.totalCount).toBe(63)
      expect(body.page).toBe(2)
      expect(body.totalPages).toBe(3)
      expect(body.hasPreviousPage).toBe(true)
      expect(body.hasNextPage).toBe(true)
      expect(body.issues).toEqual([
        expect.objectContaining({
          number: 17,
          title: 'Fix flaky preview loading',
        }),
      ])
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/search/issues?q=repo%3Aocto%2Fcloudchat'),
        expect.any(Object),
      )
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })

  it('creates cross-repo pull requests from a fork when a base repo is provided', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/repos/devgwardo/cloudchat-fork/git/ref/heads/main')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            object: { sha: 'base-sha-123' },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url.includes('/repos/devgwardo/cloudchat-fork/git/refs')) {
        return Promise.resolve(new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }))
      }

      if (url.includes('/repos/devgwardo/cloudchat-fork/contents/src/App.tsx?ref=issue-17')) {
        return Promise.resolve(new Response('Not found', { status: 404 }))
      }

      if (url.includes('/repos/devgwardo/cloudchat-fork/contents/src/App.tsx')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }

      if (url.includes('/repos/octo/cloudchat/pulls')) {
        expect(init?.body).toContain('"head":"devgwardo:issue-17"')
        expect(init?.body).toContain('"base":"main"')
        return Promise.resolve(
          new Response(JSON.stringify({
            number: 44,
            html_url: 'https://github.com/octo/cloudchat/pull/44',
            title: 'Fix issue 17',
            body: 'Implements the fix',
            state: 'open',
            draft: false,
            head: { ref: 'issue-17' },
            base: { ref: 'main' },
          }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    })

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'create-pr',
          pat: 'ghp_test',
          owner: 'devgwardo',
          repo: 'cloudchat-fork',
          baseOwner: 'octo',
          baseRepo: 'cloudchat',
          title: 'Fix issue 17',
          body: 'Implements the fix',
          branch: 'issue-17',
          baseBranch: 'main',
          files: [
            {
              path: 'src/App.tsx',
              action: 'edit',
              content: 'export default function App() { return null }',
            },
          ],
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.pr.baseRepo).toBe('octo/cloudchat')
      expect(body.pr.headRepo).toBe('devgwardo/cloudchat-fork')
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/repos/devgwardo/cloudchat-fork/git/ref/heads/main'),
        expect.any(Object),
      )
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/repos/octo/cloudchat/pulls'),
        expect.objectContaining({
          method: 'POST',
        }),
      )
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })
})
