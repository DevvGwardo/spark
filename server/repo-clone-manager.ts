import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { access, mkdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export interface ManagedRepoClone {
  exists: boolean
  path: string | null
}

interface EnsureRepoCloneInput {
  owner: string
  repo: string
  pat: string
  branch?: string
}

type ForkRepositoryInput = EnsureRepoCloneInput

export interface ForkRepositoryResult {
  owner: string
  repo: string
  fullName: string
  defaultBranch: string
  htmlUrl: string
  clone: ManagedRepoClone
}

const MANAGED_REPOS_ROOT = join(homedir(), '.cloudchat', 'repos')

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getRepoDir(owner: string, repo: string) {
  return join(MANAGED_REPOS_ROOT, sanitizeSegment(owner), sanitizeSegment(repo))
}

function runGit(args: string[], cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: 'pipe',
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `git ${args[0]} failed with exit code ${code ?? 1}`))
    })
  })
}

async function ensureRepoDirectory(owner: string, repo: string) {
  const repoDir = getRepoDir(owner, repo)
  await mkdir(join(MANAGED_REPOS_ROOT, sanitizeSegment(owner)), { recursive: true })

  if (existsSync(repoDir) && !existsSync(join(repoDir, '.git'))) {
    // The app owns this directory; clear incomplete clones before retrying.
    await rm(repoDir, { recursive: true, force: true })
  }

  return repoDir
}

async function waitForRepository(owner: string, repo: string, headers: Record<string, string>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
    if (response.ok) {
      return await response.json() as {
        default_branch?: string
        full_name?: string
        html_url?: string
        owner?: { login?: string }
        name?: string
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }

  throw new Error(`Timed out waiting for GitHub to finish preparing ${owner}/${repo}`)
}

export async function getManagedRepoClone(owner: string, repo: string): Promise<ManagedRepoClone> {
  const repoDir = getRepoDir(owner, repo)
  try {
    await access(join(repoDir, '.git'))
    return { exists: true, path: repoDir }
  } catch {
    return { exists: false, path: null }
  }
}

export async function ensureRepoClone({ owner, repo, pat, branch }: EnsureRepoCloneInput): Promise<ManagedRepoClone> {
  const existing = await getManagedRepoClone(owner, repo)
  if (existing.exists) {
    return existing
  }

  const repoDir = await ensureRepoDirectory(owner, repo)
  const cloneUrl = `https://x-access-token:${pat}@github.com/${owner}/${repo}.git`
  const cloneArgs = ['clone', '--depth', '1']
  if (branch) {
    cloneArgs.push('--branch', branch)
  }
  cloneArgs.push(cloneUrl, repoDir)

  await runGit(cloneArgs)

  // Strip the token from the saved remote URL after cloning.
  await runGit(['remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`], repoDir).catch(() => {})

  return { exists: true, path: repoDir }
}

export async function forkRepository({ owner, repo, pat, branch }: ForkRepositoryInput): Promise<ForkRepositoryResult> {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'CloudChat-App',
    'Content-Type': 'application/json',
  }

  const forkResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/forks`, {
    method: 'POST',
    headers,
  })

  if (!forkResponse.ok && forkResponse.status !== 202) {
    const error = await forkResponse.text()
    throw new Error(`Failed to fork repository: ${error}`)
  }

  const initialFork = await forkResponse.json() as {
    owner?: { login?: string }
    name?: string
    full_name?: string
    default_branch?: string
    html_url?: string
  }

  const forkOwner = initialFork.owner?.login
  const forkName = initialFork.name

  if (!forkOwner || !forkName) {
    throw new Error('GitHub did not return the fork repository details')
  }

  const readyFork = await waitForRepository(forkOwner, forkName, headers)
  const clone = await ensureRepoClone({
    owner: forkOwner,
    repo: forkName,
    pat,
    branch: branch || readyFork.default_branch,
  })

  return {
    owner: forkOwner,
    repo: forkName,
    fullName: readyFork.full_name || `${forkOwner}/${forkName}`,
    defaultBranch: readyFork.default_branch || branch || 'main',
    htmlUrl: readyFork.html_url || `https://github.com/${forkOwner}/${forkName}`,
    clone,
  }
}
