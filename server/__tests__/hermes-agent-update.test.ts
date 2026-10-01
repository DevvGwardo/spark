// @vitest-environment node
/**
 * Pinned-tag Hermes update (spec 3.5): detection, the move-to-tag command
 * sequence, patch re-apply + verify, rollback on patch failure, the bridge
 * restart through the supervisor, and the platform-aware `hermes` path.
 *
 * Git is a scripted fake — no real git, no network, nothing under ~/.hermes.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  HERMES_AGENT_VERSION_TAG,
  applyHermesPatch,
  compareReleaseTags,
  findHermesPatch,
  hermesAgentBin,
  latestReleaseTag,
  type GitRun,
} from '../../shared/hermes-agent'
import {
  detectCheckout,
  listRemoteReleaseTags,
  moveToTag,
  planPinnedUpdate,
  restartBridgeAndVerify,
  type Exec,
  type RestartableBridge,
} from '../lib/hermes-agent-update'

const PATCH = '/spark/patches/hermes-api-server-runs-parity.patch'
const DIR = '/home/u/.hermes/hermes-agent'

/**
 * A tiny model of the checkout: HEAD, whether the patch is applied, and which
 * refs the patch applies cleanly to. Every git call is recorded.
 */
function fakeRepo(opts: {
  head?: string
  branch?: string
  tags?: Record<string, string> // sha → tag at that sha
  patched?: boolean
  patchAppliesTo?: string[] // shas the patch applies to
  dirty?: string
  shallow?: boolean
  failFetch?: boolean
  remoteTags?: string[]
}) {
  const state = {
    head: opts.head ?? 'sha-old',
    branch: opts.branch ?? 'HEAD',
    patched: opts.patched ?? true,
    tags: { 'sha-old': 'v2026.7.20', 'sha-new': 'v2026.9.24', ...opts.tags } as Record<string, string>,
  }
  const tagToSha = () => Object.fromEntries(Object.entries(state.tags).map(([s, t]) => [t, s]))
  const appliesTo = opts.patchAppliesTo ?? ['sha-old', 'sha-new']
  const calls: string[][] = []
  const fail = (msg: string) => Promise.reject(Object.assign(new Error(msg), { stderr: msg }))

  const exec: Exec = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe('git')
    calls.push(args)
    const ok = (stdout = '') => Promise.resolve({ stdout, stderr: '' })
    const a = args.filter((x) => x !== '-c' && x !== 'advice.detachedHead=false')
    const cmd = a.join(' ')
    if (cmd === 'rev-parse --abbrev-ref HEAD') return ok(state.branch + '\n')
    if (cmd === 'rev-parse HEAD') return ok(state.head + '\n')
    if (cmd === 'rev-parse --is-shallow-repository') return ok(opts.shallow ? 'true\n' : 'false\n')
    if (cmd === 'describe --tags --exact-match HEAD') {
      const t = state.tags[state.head]
      return t ? ok(t + '\n') : fail('fatal: no tag exactly matches')
    }
    if (cmd.startsWith('ls-remote')) {
      return ok((opts.remoteTags ?? []).map((t, i) => `abc${i}\trefs/tags/${t}`).join('\n') + '\n')
    }
    if (cmd === `apply --reverse --check ${PATCH}`) return state.patched ? ok() : fail('reverse check failed')
    if (cmd === `apply --reverse ${PATCH}`) {
      if (!state.patched) return fail('not applied')
      state.patched = false
      return ok()
    }
    if (cmd === `apply --check ${PATCH}`) {
      return !state.patched && appliesTo.includes(state.head) ? ok() : fail('error: patch does not apply')
    }
    if (cmd === `apply ${PATCH}`) {
      if (state.patched || !appliesTo.includes(state.head)) return fail('error: patch does not apply')
      state.patched = true
      return ok()
    }
    if (cmd === 'status --porcelain --untracked-files=no') return ok(opts.dirty ?? '')
    if (a[0] === 'fetch') return opts.failFetch ? fail('network down') : ok()
    if (a[0] === 'checkout') {
      const ref = a[a.length - 1]
      const sha = ref.startsWith('refs/tags/') ? tagToSha()[ref.slice('refs/tags/'.length)] : ref
      if (!sha) return fail(`unknown ref ${ref}`)
      if (state.patched && !a.includes('--force')) return fail('local changes would be overwritten')
      state.head = sha
      if (a.includes('--force')) state.patched = false
      return ok()
    }
    return fail(`unexpected git ${cmd}`)
  }) as unknown as Exec

  const git: GitRun = async (args) => (await exec('git', args, { cwd: DIR })).stdout
  return { state, exec, git, calls }
}

describe('hermesAgentBin: platform-aware resolver', () => {
  it('uses venv/bin/hermes on POSIX', () => {
    expect(hermesAgentBin('/a', 'darwin')).toBe(join('/a', 'venv', 'bin', 'hermes'))
    expect(hermesAgentBin('/a', 'linux')).toBe(join('/a', 'venv', 'bin', 'hermes'))
  })

  it('uses venv\\Scripts\\hermes.exe on win32', () => {
    expect(hermesAgentBin('/a', 'win32')).toBe(join('/a', 'venv', 'Scripts', 'hermes.exe'))
  })

  it('findHermesPatch returns the first existing candidate', () => {
    expect(findHermesPatch(['/x', '/y', '/z'], (p) => p !== '/x')).toBe('/y')
    expect(findHermesPatch(['/x'], () => false)).toBeNull()
  })
})

describe('release tag ordering', () => {
  it('compares numerically and picks the latest release tag', () => {
    expect(compareReleaseTags('v2026.10.1', 'v2026.9.24')).toBeGreaterThan(0)
    expect(compareReleaseTags('v2026.7.20', 'v2026.07.20')).toBe(0)
    expect(latestReleaseTag(['v2026.7.20', 'nightly', 'v2026.10.1', 'v2026.9.24'])).toBe('v2026.10.1')
    expect(latestReleaseTag(['nightly'])).toBeNull()
  })
})

describe('detectCheckout: pinned detection', () => {
  it('detached HEAD at a tag is pinned', async () => {
    const { git } = fakeRepo({})
    expect(await detectCheckout(git)).toEqual({ branch: 'HEAD', detached: true, tag: HERMES_AGENT_VERSION_TAG, pinned: true })
  })

  it('a branch checkout is not pinned and never runs describe', async () => {
    const { git, calls } = fakeRepo({ branch: 'main' })
    expect(await detectCheckout(git)).toEqual({ branch: 'main', detached: false, tag: null, pinned: false })
    expect(calls.some((c) => c[0] === 'describe')).toBe(false)
  })

  it('detached HEAD off any tag is not pinned', async () => {
    const { git } = fakeRepo({ head: 'sha-random' })
    expect((await detectCheckout(git)).pinned).toBe(false)
  })

  it('plans "move to tag" for the latest release newer than the current tag', async () => {
    const { git } = fakeRepo({ remoteTags: ['v2026.7.20', 'v2026.9.24', 'v2026.8.1', 'foo'] })
    const tags = await listRemoteReleaseTags(git)
    expect(tags).toEqual(['v2026.7.20', 'v2026.9.24', 'v2026.8.1', 'foo'])
    expect(planPinnedUpdate('v2026.7.20', tags)).toEqual({ latestTag: 'v2026.9.24', targetTag: 'v2026.9.24' })
    expect(planPinnedUpdate('v2026.9.24', tags)).toEqual({ latestTag: 'v2026.9.24', targetTag: null })
  })
})

describe('applyHermesPatch', () => {
  it('is idempotent and verifies with a reverse check', async () => {
    const already = fakeRepo({ patched: true })
    expect(await applyHermesPatch(already.git, PATCH)).toEqual({ ok: true, alreadyApplied: true })

    const fresh = fakeRepo({ patched: false })
    expect(await applyHermesPatch(fresh.git, PATCH)).toEqual({ ok: true })
    expect(fresh.calls.map((c) => c.join(' '))).toEqual([
      `apply --reverse --check ${PATCH}`,
      `apply --check ${PATCH}`,
      `apply ${PATCH}`,
      `apply --reverse --check ${PATCH}`,
    ])
  })
})

describe('moveToTag', () => {
  it('runs remove patch → fetch tag → detached checkout → re-apply + verify → deps', async () => {
    const repo = fakeRepo({ shallow: true })
    const reinstallDeps = vi.fn(async () => {})
    const steps: string[] = []
    const result = await moveToTag(
      { agentDir: DIR, exec: repo.exec, patchPath: PATCH, reinstallDeps, onStep: (_n, l) => steps.push(l) },
      'v2026.7.20',
      'v2026.9.24',
    )

    expect(result).toEqual({
      ok: true,
      previousRef: 'sha-old',
      previousTag: 'v2026.7.20',
      newTag: 'v2026.9.24',
      rolledBack: false,
      patchApplied: true,
    })
    expect(repo.state).toMatchObject({ head: 'sha-new', patched: true })
    expect(reinstallDeps).toHaveBeenCalledTimes(1)
    expect(repo.calls.map((c) => c.join(' '))).toEqual([
      'rev-parse HEAD',
      `apply --reverse --check ${PATCH}`,
      `apply --reverse --check ${PATCH}`,
      `apply --reverse ${PATCH}`,
      'status --porcelain --untracked-files=no',
      'rev-parse --is-shallow-repository',
      'fetch --depth 1 --no-tags origin tag v2026.9.24',
      '-c advice.detachedHead=false checkout --detach refs/tags/v2026.9.24',
      `apply --reverse --check ${PATCH}`,
      `apply --check ${PATCH}`,
      `apply ${PATCH}`,
      `apply --reverse --check ${PATCH}`,
    ])
    // Never a main fast-forward, merge, or reset.
    expect(repo.calls.some((c) => c.includes('merge') || c.includes('origin/main') || c.includes('reset'))).toBe(false)
    expect(steps).toContain('Re-applying Spark patch...')
  })

  it('omits --depth on a full clone', async () => {
    const repo = fakeRepo({ shallow: false })
    await moveToTag({ agentDir: DIR, exec: repo.exec, patchPath: PATCH }, 'v2026.7.20', 'v2026.9.24')
    expect(repo.calls).toContainEqual(['fetch', '--no-tags', 'origin', 'tag', 'v2026.9.24'])
  })

  it('rolls back to the previous ref and re-applies the patch when it does not apply to the new tag', async () => {
    const repo = fakeRepo({ patchAppliesTo: ['sha-old'] })
    const reinstallDeps = vi.fn(async () => {})
    const result = await moveToTag(
      { agentDir: DIR, exec: repo.exec, patchPath: PATCH, reinstallDeps },
      'v2026.7.20',
      'v2026.9.24',
    )

    expect(result.ok).toBe(false)
    expect(result.rolledBack).toBe(true)
    expect(result.patchApplied).toBe(true)
    expect(result.error).toMatch(/does not apply to v2026\.9\.24.*Rolled back to v2026\.7\.20/)
    expect(repo.state).toMatchObject({ head: 'sha-old', patched: true })
    expect(repo.calls).toContainEqual(['-c', 'advice.detachedHead=false', 'checkout', '--force', '--detach', 'sha-old'])
    expect(reinstallDeps).not.toHaveBeenCalled()
  })

  it('rolls back when the dependency reinstall fails', async () => {
    const repo = fakeRepo({})
    const result = await moveToTag(
      { agentDir: DIR, exec: repo.exec, patchPath: PATCH, reinstallDeps: async () => { throw new Error('pip exploded') } },
      'v2026.7.20',
      'v2026.9.24',
    )
    expect(result).toMatchObject({ ok: false, rolledBack: true })
    expect(result.error).toMatch(/pip exploded/)
    expect(repo.state).toMatchObject({ head: 'sha-old', patched: true })
  })

  it('reports a failed rollback when the patch no longer applies to the old ref either', async () => {
    const repo = fakeRepo({ patchAppliesTo: [] })
    const result = await moveToTag({ agentDir: DIR, exec: repo.exec, patchPath: PATCH }, 'v2026.7.20', 'v2026.9.24')
    expect(result).toMatchObject({ ok: false, rolledBack: false })
    expect(result.error).toMatch(/Rollback to v2026\.7\.20 also failed/)
    expect(repo.state.head).toBe('sha-old')
  })

  it('refuses (and restores the patch) when there are other local changes', async () => {
    const repo = fakeRepo({ dirty: ' M agent/core.py\n' })
    const result = await moveToTag({ agentDir: DIR, exec: repo.exec, patchPath: PATCH }, 'v2026.7.20', 'v2026.9.24')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/local changes besides the Spark patch/)
    expect(repo.state).toMatchObject({ head: 'sha-old', patched: true })
    expect(repo.calls.some((c) => c[0] === 'fetch' || c.includes('checkout'))).toBe(false)
  })

  it('restores the patch when the tag fetch fails', async () => {
    const repo = fakeRepo({ failFetch: true })
    const result = await moveToTag({ agentDir: DIR, exec: repo.exec, patchPath: PATCH }, 'v2026.7.20', 'v2026.9.24')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Failed to fetch v2026\.9\.24/)
    expect(repo.state).toMatchObject({ head: 'sha-old', patched: true })
  })
})

describe('restartBridgeAndVerify', () => {
  function fakeBridge(after: Record<string, unknown> | null, status: 'started' | 'failed' = 'started'): RestartableBridge & {
    restart: ReturnType<typeof vi.fn>
  } {
    let restarted = false
    return {
      restart: vi.fn(async () => {
        restarted = true
        return status === 'failed' ? { status, message: 'boom' } : { status }
      }),
      diag: vi.fn(async () => (restarted ? after : { pid: 100, token_matches: true, hermes_agent_version: '2026.7.20' })),
    }
  }

  it('restarts through the supervisor and verifies /diag reports the new version', async () => {
    const bridge = fakeBridge({ pid: 200, token_matches: true, hermes_agent_version: '2026.9.24' })
    const report = await restartBridgeAndVerify(bridge, 'v2026.9.24')
    expect(bridge.restart).toHaveBeenCalledTimes(1)
    expect(report).toEqual({ attempted: true, ok: true, pid: 200, hermesAgentVersion: '2026.9.24' })
  })

  it('flags a version mismatch, an unchanged pid, and a lost ownership', async () => {
    expect((await restartBridgeAndVerify(fakeBridge({ pid: 200, token_matches: true, hermes_agent_version: '2026.7.20' }), 'v2026.9.24')).message)
      .toMatch(/expected v2026\.9\.24/)
    expect((await restartBridgeAndVerify(fakeBridge({ pid: 100, token_matches: true }))).message).toMatch(/pid 100 unchanged/)
    expect((await restartBridgeAndVerify(fakeBridge({ pid: 200, token_matches: false }))).ok).toBe(false)
  })

  it('accepts a bridge that does not report the agent version', async () => {
    expect((await restartBridgeAndVerify(fakeBridge({ pid: 200, token_matches: true }), 'v2026.9.24')).ok).toBe(true)
  })

  it('surfaces a failed restart and a missing supervisor', async () => {
    expect(await restartBridgeAndVerify(fakeBridge(null, 'failed'))).toEqual({ attempted: true, ok: false, message: 'boom' })
    expect(await restartBridgeAndVerify(null)).toMatchObject({ attempted: false, ok: false })
  })
})
