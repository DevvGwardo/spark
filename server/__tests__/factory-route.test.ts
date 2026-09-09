// @vitest-environment node
import type { AddressInfo } from 'net'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Factory routes persist jobs + enqueue agent tasks on disk. Point all
// host-dependent paths (jobs dir, agent-tasks log, factory checkout,
// kanban DB) at a fresh tmp dir per test so we never touch the real
// ~/.cache, ~/.agent-tasks, ~/software-factory, or ~/.hermes/kanban.db.
let tmpDir: string
let jobsFile: string
let tasksLog: string

async function createTestServer() {
  const { createApp } = await import('../index')
  const app = createApp()

  return await new Promise<{
    close: () => Promise<void>
    url: string
  }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
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

describe('factory routes', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'factory-test-'))
    jobsFile = join(tmpDir, 'jobs.json')
    tasksLog = join(tmpDir, 'tasks.jsonl')
    process.env.FACTORY_JOBS_DIR = tmpDir
    process.env.AGENT_TASKS_DIR = tmpDir
    // fake factory checkout: <tmp>/factory/package.json
    const factoryDir = join(tmpDir, 'factory')
    mkdirSync(factoryDir, { recursive: true })
    writeFileSync(join(factoryDir, 'package.json'), JSON.stringify({ name: 'factory' }))
    process.env.FACTORY_DIR = factoryDir
    // seed a tiny kanban DB with one task per lane
    const kanbanDb = join(tmpDir, 'kanban.db')
    const db = new DatabaseSync(kanbanDb)
    try {
      db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL)')
      const insert = db.prepare('INSERT INTO tasks (id, status) VALUES (?, ?)')
      insert.run('t1', 'todo')
      insert.run('t2', 'doing')
      insert.run('t3', 'done')
    } finally {
      db.close()
    }
    process.env.KANBAN_DB = kanbanDb
    server = await createTestServer()
  })

  afterEach(async () => {
    await server.close()
    delete process.env.FACTORY_JOBS_DIR
    delete process.env.AGENT_TASKS_DIR
    delete process.env.FACTORY_DIR
    delete process.env.KANBAN_DB
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('status reports factory presence and queue length', async () => {
    const res = await fetch(`${server.url}/api/factory/status`)
    const body = (await res.json()) as { ok: boolean; factory: string; harness: string; queue: number }
    expect(res.ok).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.factory).toBe('installed')
    expect(body.queue).toBe(0)
  })

  it('status reports factory missing when the checkout is absent', async () => {
    rmSync(process.env.FACTORY_DIR as string, { recursive: true, force: true })
    const res = await fetch(`${server.url}/api/factory/status`)
    const body = (await res.json()) as { ok: boolean; factory: string; queue: number }
    expect(res.ok).toBe(true)
    expect(body.factory).toBe('missing')
  })

  it('dispatch creates a job, persists it, and enqueues an agent task', async () => {
    const res = await fetch(`${server.url}/api/factory/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'build the thing', workdir: '/tmp/factory-work' }),
    })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as {
      ok: boolean
      job: { jobId: string; stage: string; task: string; workdir: string }
      enqueued: boolean
    }
    expect(body.ok).toBe(true)
    expect(body.enqueued).toBe(true)
    expect(body.job.task).toBe('build the thing')
    expect(body.job.stage).toBe('queued')

    // job persisted to disk (issue #1: jobs Map is no longer in-memory only),
    // and the on-disk stage matches the post-enqueue stage (not stale `intake`)
    expect(existsSync(jobsFile)).toBe(true)
    const persisted = JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobId: string; stage: string }[]
    const persistedJob = persisted.find(j => j.jobId === body.job.jobId)
    expect(persistedJob).toBeDefined()
    expect(persistedJob?.stage).toBe('queued')

    // agent task enqueued as a `create` event the task-worker actually reads
    // (issue #3: schema mirrors ~/.agent-tasks/bin/task cmd_add)
    expect(existsSync(tasksLog)).toBe(true)
    const event = JSON.parse(readFileSync(tasksLog, 'utf8')) as {
      event: string; id: string; desc: string; agent: string
    }
    expect(event.event).toBe('create')
    expect(event.id).toBe(body.job.jobId)
    expect(event.desc).toBe('build the thing')
    expect(event.agent).toBe('hermes-local')

    // job file fallback removed — the loose .json the old code wrote must not exist
    expect(existsSync(join(tmpDir, `${body.job.jobId}.json`))).toBe(false)
  })

  it('dispatch rejects empty task', async () => {
    const res = await fetch(`${server.url}/api/factory/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('dispatch guard: isLoopbackAddress rejects LAN/mapped addresses (issue #4)', async () => {
    // The route guard reads socket.remoteAddress; a genuinely non-loopback
    // client can't be simulated from the same host, so pin the guard function
    // the route delegates to.
    const { isLoopbackAddress } = await import('../index')
    expect(isLoopbackAddress('192.168.1.50')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.50')).toBe(false)
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('kanban/sync reports lane counts from the shared kanban DB (issue #5)', async () => {
    const res = await fetch(`${server.url}/api/factory/kanban/sync`, { method: 'POST' })
    expect(res.ok).toBe(true)
    const body = (await res.json()) as {
      ok: boolean
      kanban: string
      lanes: Record<string, number>
      total: number
    }
    expect(body.ok).toBe(true)
    expect(body.total).toBe(3)
    expect(body.lanes).toEqual({ todo: 1, doing: 1, done: 1 })
  })

  it('kanban/sync 404s when the kanban DB is absent', async () => {
    rmSync(process.env.KANBAN_DB as string, { force: true })
    const res = await fetch(`${server.url}/api/factory/kanban/sync`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
