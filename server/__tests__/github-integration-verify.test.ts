import type { AddressInfo } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const repoVerifierMocks = vi.hoisted(() => ({
  verifyRepoChanges: vi.fn(),
  generatePrMetadata: vi.fn(),
}))

vi.mock('../repo-verifier', () => ({
  verifyRepoChanges: repoVerifierMocks.verifyRepoChanges,
  generatePrMetadata: repoVerifierMocks.generatePrMetadata,
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
          allProviders: {
            openai: { apiKey: 'provider-key', model: 'gpt-5.2' },
            anthropic: { apiKey: 'ant-key', model: 'claude-sonnet-4-5' },
          },
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
          allProviders: {
            openai: { apiKey: 'provider-key', model: 'gpt-5.2' },
            anthropic: { apiKey: 'ant-key', model: 'claude-sonnet-4-5' },
          },
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

  it('creates repository issues and returns the normalized payload', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.endsWith('/repos/octo/cloudchat/issues')) {
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe(JSON.stringify({
          title: 'Add issue creation',
          body: 'Users should be able to open issues from the repo browser.',
        }))

        return Promise.resolve(
          new Response(JSON.stringify({
            id: 301,
            number: 28,
            title: 'Add issue creation',
            body: 'Users should be able to open issues from the repo browser.',
            html_url: 'https://github.com/octo/cloudchat/issues/28',
            state: 'open',
            comments: 0,
            created_at: '2026-03-13T14:22:00Z',
            updated_at: '2026-03-13T14:22:00Z',
            user: {
              login: 'octocat',
              avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
            },
            labels: [],
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
          action: 'create-issue',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          title: 'Add issue creation',
          body: 'Users should be able to open issues from the repo browser.',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.issue).toEqual(expect.objectContaining({
        number: 28,
        title: 'Add issue creation',
        state: 'open',
      }))
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })

  it('builds repo activity from recent commits so external repos still render the graph', async () => {
    const today = new Date()
    today.setUTCHours(12, 0, 0, 0)
    const earlierToday = new Date(today)
    earlierToday.setUTCHours(9, 0, 0, 0)
    const laterToday = new Date(today)
    laterToday.setUTCHours(18, 30, 0, 0)
    const twoDaysAgo = new Date(today)
    twoDaysAgo.setUTCDate(today.getUTCDate() - 2)

    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/repos/upstream/remote-chat/commits?')) {
        const parsed = new URL(url)
        expect(parsed.searchParams.get('per_page')).toBe('100')
        expect(parsed.searchParams.get('page')).toBe('1')

        return Promise.resolve(
          new Response(JSON.stringify([
            {
              commit: {
                committer: {
                  date: earlierToday.toISOString(),
                },
              },
            },
            {
              commit: {
                committer: {
                  date: laterToday.toISOString(),
                },
              },
            },
            {
              commit: {
                committer: {
                  date: twoDaysAgo.toISOString(),
                },
              },
            },
          ]), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url.includes('/search/issues?')) {
        const parsed = new URL(url)
        const query = parsed.searchParams.get('q') || ''

        if (query.includes('is:issue')) {
          return Promise.resolve(
            new Response(JSON.stringify({ total_count: 11 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }

        if (query.includes('is:pr')) {
          return Promise.resolve(
            new Response(JSON.stringify({ total_count: 7 }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
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
          action: 'repo-activity',
          pat: 'ghp_test',
          owner: 'upstream',
          repo: 'remote-chat',
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.days).toHaveLength(30)
      expect(body.totalCommits).toBe(3)
      expect(body.openedIssues).toBe(11)
      expect(body.openedPullRequests).toBe(7)
      expect(body.days[27]).toBe(1)
      expect(body.days[29]).toBe(2)
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

  it('creates draft pull requests and encodes staged file paths', async () => {
    const server = await createTestServer()
    const originalFetch = global.fetch
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith(server.url)) {
        return originalFetch(input as Parameters<typeof fetch>[0], init)
      }

      if (url.includes('/repos/octo/cloudchat/git/ref/heads/main')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            object: { sha: 'base-sha-999' },
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }

      if (url.includes('/repos/octo/cloudchat/git/refs')) {
        return Promise.resolve(new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } }))
      }

      if (url.includes('/repos/octo/cloudchat/contents/docs/Release%20Notes%20%231.md?ref=draft-pr')) {
        return Promise.resolve(new Response('Not found', { status: 404 }))
      }

      if (url.includes('/repos/octo/cloudchat/contents/docs/Release%20Notes%20%231.md')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      }

      if (url.includes('/repos/octo/cloudchat/pulls')) {
        expect(init?.body).toContain('"draft":true')
        return Promise.resolve(
          new Response(JSON.stringify({
            number: 55,
            html_url: 'https://github.com/octo/cloudchat/pull/55',
            title: 'docs: add release notes',
            body: 'Tracks the Hermes-generated draft PR flow',
            state: 'open',
            draft: true,
            head: { ref: 'draft-pr' },
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
          owner: 'octo',
          repo: 'cloudchat',
          title: 'docs: add release notes',
          body: 'Tracks the Hermes-generated draft PR flow',
          branch: 'draft-pr',
          baseBranch: 'main',
          draft: true,
          files: [
            {
              path: 'docs/Release Notes #1.md',
              action: 'create',
              content: '# Release notes',
            },
          ],
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.pr.draft).toBe(true)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/contents/docs/Release%20Notes%20%231.md?ref=draft-pr'),
        expect.any(Object),
      )
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/contents/docs/Release%20Notes%20%231.md'),
        expect.objectContaining({
          method: 'PUT',
        }),
      )
    } finally {
      fetchMock.mockRestore()
      await server.close()
    }
  })

  it('generates PR metadata through the shared helper', async () => {
    repoVerifierMocks.generatePrMetadata.mockResolvedValue({
      title: 'feat: add dark mode support',
      body: '## Summary\n- Added dark mode toggle\n- Updated theme tokens',
    })

    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'generate-pr-metadata',
          pat: 'ghp_test',
          owner: 'octo',
          repo: 'cloudchat',
          provider: 'hermes',
          model: 'llama-4-maverick',
          apiKey: 'or-key',
          allProviders: {
            openai: { apiKey: 'openai-key', model: 'gpt-5.4' },
          },
          files: [
            {
              path: 'src/theme.ts',
              action: 'edit',
              content: 'export const dark = true;',
              originalContent: 'export const dark = false;',
            },
          ],
        }),
      })

      const body = await response.json()

      expect(response.ok).toBe(true)
      expect(body.title).toBe('feat: add dark mode support')
      expect(body.body).toContain('dark mode')
      expect(repoVerifierMocks.generatePrMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'hermes',
          model: 'llama-4-maverick',
          apiKey: 'or-key',
          owner: 'octo',
          repo: 'cloudchat',
          allProviders: {
            openai: { apiKey: 'openai-key', model: 'gpt-5.4' },
          },
        }),
      )
    } finally {
      await server.close()
    }
  })

  it('returns 400 when generate-pr-metadata is called without files', async () => {
    const server = await createTestServer()

    try {
      const response = await fetch(`${server.url}/functions/v1/github-integration`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'generate-pr-metadata',
          pat: 'ghp_test',
          files: [],
        }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBeDefined()
    } finally {
      await server.close()
    }
  })
})
