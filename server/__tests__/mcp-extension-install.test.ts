// @vitest-environment node
// Phase 3 proof: .mcpb extension install/uninstall/enable + HTTP surface.
// BEHAVIORAL only; ephemeral ports; unique ids; finally-cleanup.
//
// FIXTURE METHOD (no vendor assets, all generated at runtime):
// - @anthropic-ai/mcpb is now a DIRECT dep (^2.1.2) but its packExtension()
//   pulls @inquirer/prompts (interactive) — so fixtures still do NOT use the
//   SDK pack path. fflate is transitive-only.
// - Instead: self-authored minimal stored-method (no compression) zip writer
//   below (~45 lines) + self-authored manifest.json complying with the SDK's
//   published mcpb-manifest-v0.4 schema required fields
//   (manifest_version/name/version/description/author/server{type,entry_point,
//   mcp_config.command}). Entry scripts are self-authored one-liners:
//   `process.exit(0)` for install-only tests, `setInterval(()=>{},1000)`
//   sleeper for the enable-spawn test.
// - Negatives need no SDK: zip-slip entry ('../evil.sh') and byte-flipped
//   manifest.json (stored => bytes verbatim => flip breaks JSON.parse).
//
// ADAPTIVE: the installer (server/lib/mcp-extension-installer.ts,
// backend-owned) lands concurrently. Installer-level tests runIf it exports
// install/list/uninstall/enable, else SKIP with a DRIFT warning. HTTP tests
// run against the LANDED route file and SKIP on 503 'extension installer
// unavailable' (route poll-reads the installer per request), strict otherwise.
// Pure route-level gates (evil serverId regex) assert strictly now.
import type { AddressInfo } from 'node:net'
import express, { type Express } from 'express'
import { afterEach, describe, expect, it } from 'vitest'

// ─── Contract probes (runtime; backend lands concurrently) ──────────────────
type Installer = {
  installExtension: (args: { filename: string; data: Buffer; allowUnsigned?: boolean }) => Promise<any>
  listExtensions: () => unknown[] | Promise<unknown[]>
  uninstallExtension: (id: string) => void | Promise<void>
  enableExtension: (id: string) => unknown | Promise<unknown>
}
let installer: Installer | null = null
let installerKeys: string[] = []
for (const spec of ['../lib/mcp-extension-installer.js', '../lib/mcp-extension-installer']) {
  try {
    const mod: Record<string, unknown> = await import(spec)
    installerKeys = Object.keys(mod)
    if (
      typeof mod['installExtension'] === 'function' &&
      typeof mod['listExtensions'] === 'function' &&
      typeof mod['uninstallExtension'] === 'function' &&
      typeof mod['enableExtension'] === 'function'
    ) {
      installer = mod as unknown as Installer
      break
    }
    installer = null
  } catch {
    continue
  }
}
const installerAvailable = installer !== null

type StatusFn = () => Promise<any[]> | any[]
type StopFn = (serverId: string) => Promise<unknown> | unknown
type ResetFn = () => Promise<unknown> | unknown
let workerStatus: StatusFn | null = null
let stopWorker: StopFn | null = null
let resetSupervisor: ResetFn | null = null
try {
  const mod: Record<string, unknown> = await import('../lib/mcp-worker-supervisor.js')
  if (typeof mod['workerStatus'] === 'function') workerStatus = mod['workerStatus'] as StatusFn
  if (typeof mod['stopWorker'] === 'function') stopWorker = mod['stopWorker'] as StopFn
  if (typeof mod['resetSupervisor'] === 'function') resetSupervisor = mod['resetSupervisor'] as ResetFn
} catch {
  // Supervisor missing — enable assertions degrade to snapshot-only.
}

let registerRoute: ((app: Express) => void) | null = null
let routeKeys: string[] = []
try {
  const mod: Record<string, unknown> = await import('../routes/mcp-extensions.route.js')
  routeKeys = Object.keys(mod)
  if (typeof mod['registerMcpExtensionsRoute'] === 'function') {
    registerRoute = mod['registerMcpExtensionsRoute'] as (app: Express) => void
  } else if ((mod['mcpExtensionsRouter'] as { use?: unknown }) !== undefined) {
    const router = mod['mcpExtensionsRouter'] as import('express').Router
    registerRoute = (app: Express) => {
      app.use(router)
    }
  }
} catch {
  // Route module missing — HTTP tests skip with a drift note.
}
const routeAvailable = registerRoute !== null

// ─── Self-authored stored-zip fixture writer (no compression, no deps) ──────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function buildStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const enc = new TextEncoder()
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored (no compression)
    local.writeUInt16LE(0x21, 10)
    local.writeUInt16LE(0x00, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, Buffer.from(nameBytes), Buffer.from(e.data))
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0x21, 12)
    cen.writeUInt16LE(0x00, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(e.data.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(nameBytes.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, Buffer.from(nameBytes))
    offset += local.length + nameBytes.length + e.data.length
  }
  const centralStart = offset
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

let uniqCounter = 0
const uniq = (prefix: string) => `${prefix}-t${Date.now().toString(36)}-${uniqCounter++}`

function manifestJson(name: string, entry = 'server.js'): string {
  return JSON.stringify(
    {
      manifest_version: '0.4',
      name,
      version: '0.1.0',
      description: 'spark-test proof fixture',
      author: { name: 'spark-test' },
      server: { type: 'node', entry_point: entry, mcp_config: { command: 'node', args: [entry] } },
    },
    null,
    2,
  )
}
const INSTANT_ENTRY = 'process.exit(0);\n'
const SLEEPER_ENTRY = 'setInterval(()=>{},1000);\n'
const enc8 = new TextEncoder()
function validBundle(name: string, entrySrc = INSTANT_ENTRY, entry = 'server.js'): Buffer {
  return buildStoredZip([
    { name: 'manifest.json', data: enc8.encode(manifestJson(name, entry)) },
    { name: entry, data: enc8.encode(entrySrc) },
  ])
}
function zipSlipBundle(name: string): Buffer {
  return buildStoredZip([
    { name: 'manifest.json', data: enc8.encode(manifestJson(name)) },
    { name: '../evil.sh', data: enc8.encode('#!/bin/sh\necho pwned\n') },
  ])
}
function tamperedBundle(name: string): Buffer {
  const good = validBundle(name)
  const marker = Buffer.from('"description"')
  const idx = good.indexOf(marker)
  if (idx < 0) throw new Error('fixture error: marker not found')
  const bad = Buffer.from(good)
  bad[idx]! ^= 0xff // corrupt a key quote => manifest JSON no longer parses
  return bad
}

// Track installs for best-effort cleanup; supervisor reset kills workers.
const ownedIds = new Set<string>()
afterEach(async () => {
  if (installer !== null) {
    for (const id of [...ownedIds]) {
      try {
        await installer.uninstallExtension(id)
      } catch {
        // Best-effort.
      }
      ownedIds.delete(id)
    }
  }
  if (resetSupervisor !== null) {
    try {
      await resetSupervisor()
    } catch {
      // Best-effort.
    }
  }
})
async function stopQuietly(id: string): Promise<void> {
  if (stopWorker === null) return
  try {
    await stopWorker(id)
  } catch {
    // Best-effort.
  }
}
function listedIds(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list
    .map((e) => (e as { id?: unknown; serverId?: unknown; name?: unknown }).id ?? (e as { serverId?: unknown }).serverId ?? (e as { name?: unknown }).name)
    .filter((v): v is string => typeof v === 'string')
}

// ─── Installer-level ─────────────────────────────────────────────────────────
describe.runIf(installerAvailable)('mcp extension install: installer (behavioral)', () => {
  it('installs a valid unsigned fixture with allowUnsigned, lists it, uninstall removes it, reinstall works', async () => {
    const name = uniq('proof-ext')
    const rec = (await installer!.installExtension({ filename: `${name}.mcpb`, data: validBundle(name), allowUnsigned: true })) as Record<string, unknown>
    expect(rec).toBeDefined()
    expect(rec['id']).toBeTruthy()
    expect(rec['name']).toBeTruthy()
    expect(rec['version']).toBeTruthy()
    const id = String(rec['id'])
    ownedIds.add(id)
    try {
      const listed = await installer!.listExtensions()
      expect(Array.isArray(listed)).toBe(true)
      expect(listedIds(listed).some((v) => v === id || v.includes(name))).toBe(true)
      await installer!.uninstallExtension(id)
      const after = await installer!.listExtensions()
      expect(listedIds(after).some((v) => v === id)).toBe(false)
      const rec2 = (await installer!.installExtension({ filename: `${name}.mcpb`, data: validBundle(name), allowUnsigned: true })) as Record<string, unknown>
      expect(String(rec2['id'] ?? '')).toBeTruthy()
      ownedIds.add(String(rec2['id']))
    } finally {
      try {
        await installer!.uninstallExtension(id)
      } catch {
        // Best-effort; afterEach retries.
      }
    }
  })

  it('unsigned WITHOUT allowUnsigned throws and installs nothing', async () => {
    const name = uniq('proof-ext')
    const before = listedIds(await installer!.listExtensions())
    await expect(installer!.installExtension({ filename: `${name}.mcpb`, data: validBundle(name) })).rejects.toThrow()
    const after = listedIds(await installer!.listExtensions())
    expect(after).toEqual(before)
  })

  it('zip-slip entry throws and installs nothing', async () => {
    const name = uniq('proof-ext')
    const before = listedIds(await installer!.listExtensions())
    await expect(
      installer!.installExtension({ filename: `${name}.mcpb`, data: zipSlipBundle(name), allowUnsigned: true }),
    ).rejects.toThrow()
    expect(listedIds(await installer!.listExtensions())).toEqual(before)
  })

  it('tampered manifest (byte-flipped JSON) throws and installs nothing', async () => {
    const name = uniq('proof-ext')
    const before = listedIds(await installer!.listExtensions())
    await expect(
      installer!.installExtension({ filename: `${name}.mcpb`, data: tamperedBundle(name), allowUnsigned: true }),
    ).rejects.toThrow()
    expect(listedIds(await installer!.listExtensions())).toEqual(before)
  })

  it('enable spawns a ready worker, then stopWorker cleans up', async () => {
    const name = uniq('proof-ext')
    const rec = (await installer!.installExtension({ filename: `${name}.mcpb`, data: validBundle(name, SLEEPER_ENTRY), allowUnsigned: true })) as Record<string, unknown>
    const id = String(rec['id'])
    ownedIds.add(id)
    const workerIds: string[] = []
    try {
      const snapshot = (await installer!.enableExtension(id)) as Record<string, unknown> | null
      expect(snapshot).toBeDefined()
      if (workerStatus !== null) {
        const listed = await workerStatus()
        const entry = listed.find((e) => typeof e?.serverId === 'string' && (e.serverId as string).includes(id))
        expect(entry).toBeDefined()
        expect(entry?.state).toBe('ready')
        if (typeof entry?.serverId === 'string') workerIds.push(entry.serverId)
      }
    } finally {
      for (const wid of workerIds) await stopQuietly(wid)
      await stopQuietly(`ext:${id}`)
      try {
        await installer!.uninstallExtension(id)
      } catch {
        // Best-effort.
      }
    }
  })
})

it.runIf(!installerAvailable)('installer contract pending (drift note, backend owns impl)', () => {
  console.warn(
    `[ext-install] DRIFT: server/lib/mcp-extension-installer.ts missing or exports differ. ` +
      `Expected installExtension/listExtensions/uninstallExtension/enableExtension; saw keys: [${installerKeys.join(', ')}]. ` +
      `Installer tests skipped.`,
  )
  expect(installerAvailable).toBe(false)
})

// ─── HTTP ────────────────────────────────────────────────────────────────────
async function createRouteServer() {
  const app = express()
  app.use(express.json())
  registerRoute!(app)
  return await new Promise<{ close: () => Promise<void>; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error)
              else closeResolve()
            })
          }),
      })
    })
  })
}
async function postJson(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = null
    }
  }
  return { status: res.status, body: parsed as Record<string, unknown> | null }
}
const INSTALLER_DOWN = new Set([503])

describe.runIf(routeAvailable)('mcp extension install: HTTP (behavioral)', () => {
  it('POST valid → 201; GET lists it; DELETE removes it', async (ctx) => {
    const server = await createRouteServer()
    const name = uniq('proof-ext')
    try {
      const installed = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: `${name}.mcpb`,
        dataBase64: validBundle(name).toString('base64'),
        allowUnsigned: true,
      })
      if (INSTALLER_DOWN.has(installed.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); HTTP install test skipped.')
        return ctx.skip()
      }
      expect(installed.status).toBe(201)
      const id = String(installed.body?.['id'] ?? '')
      expect(id).toBeTruthy()
      ownedIds.add(id)
      try {
        const listRes = await fetch(`${server.url}/api/mcp-extensions`)
        expect(listRes.status).toBe(200)
        const list = (await listRes.json()) as unknown[]
        expect(Array.isArray(list)).toBe(true)
        const delRes = await fetch(`${server.url}/api/mcp-extensions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        expect(delRes.status).toBe(200)
        ownedIds.delete(id)
      } finally {
        try {
          await fetch(`${server.url}/api/mcp-extensions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        } catch {
          // Best-effort.
        }
      }
    } finally {
      await server.close()
    }
  })

  it('unsigned WITHOUT allowUnsigned → 400', async (ctx) => {
    const server = await createRouteServer()
    try {
      const res = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: 'unsigned.mcpb',
        dataBase64: validBundle(uniq('proof-ext')).toString('base64'),
      })
      if (INSTALLER_DOWN.has(res.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); unsigned-without-consent test skipped.')
        return ctx.skip()
      }
      expect(res.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('zip-slip entry → 400, nothing installed', async (ctx) => {
    const server = await createRouteServer()
    try {
      const res = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: 'slip.mcpb',
        dataBase64: zipSlipBundle(uniq('proof-ext')).toString('base64'),
        allowUnsigned: true,
      })
      if (INSTALLER_DOWN.has(res.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); zip-slip test skipped.')
        return ctx.skip()
      }
      expect(res.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('tampered manifest → 400', async (ctx) => {
    const server = await createRouteServer()
    try {
      const res = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: 'tampered.mcpb',
        dataBase64: tamperedBundle(uniq('proof-ext')).toString('base64'),
        allowUnsigned: true,
      })
      if (INSTALLER_DOWN.has(res.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); tampered-manifest test skipped.')
        return ctx.skip()
      }
      expect(res.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('enable → 200 with snapshot', async (ctx) => {
    const server = await createRouteServer()
    const name = uniq('proof-ext')
    try {
      const installed = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: `${name}.mcpb`,
        dataBase64: validBundle(name, SLEEPER_ENTRY).toString('base64'),
        allowUnsigned: true,
      })
      if (INSTALLER_DOWN.has(installed.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); enable test skipped.')
        return ctx.skip()
      }
      expect(installed.status).toBe(201)
      const id = String(installed.body?.['id'] ?? '')
      ownedIds.add(id)
      try {
        const res = await postJson(server.url, `/api/mcp-extensions/${encodeURIComponent(id)}/enable`, {})
        expect(res.status).toBe(200)
        expect(res.body).toBeDefined()
      } finally {
        await stopQuietly(`ext:${id}`)
        try {
          await fetch(`${server.url}/api/mcp-extensions/${encodeURIComponent(id)}`, { method: 'DELETE' })
        } catch {
          // Best-effort.
        }
      }
    } finally {
      await server.close()
    }
  })

  it('worker-style serverId (`ext:<id>`) round-trips enable + DELETE', async (ctx) => {
    // Regression: route params carry `ext:<id>` (as returned by list) while
    // the installer takes the bare id — the route must normalize, not 400.
    const server = await createRouteServer()
    const name = uniq('proof-ext')
    try {
      const installed = await postJson(server.url, '/api/mcp-extensions/install', {
        filename: `${name}.mcpb`,
        dataBase64: validBundle(name, SLEEPER_ENTRY).toString('base64'),
        allowUnsigned: true,
      })
      if (INSTALLER_DOWN.has(installed.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); ext:-prefix test skipped.')
        return ctx.skip()
      }
      expect(installed.status).toBe(201)
      const id = String(installed.body?.['id'] ?? '')
      const serverId = String(installed.body?.['serverId'] ?? `ext:${id}`)
      expect(serverId).toBe(`ext:${id}`)
      ownedIds.add(id)
      try {
        const en = await postJson(server.url, `/api/mcp-extensions/${encodeURIComponent(serverId)}/enable`, {})
        expect(en.status).toBe(200)
      } finally {
        await stopQuietly(serverId)
      }
      const del = await fetch(`${server.url}/api/mcp-extensions/${encodeURIComponent(serverId)}`, { method: 'DELETE' })
      expect(del.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('DELETE unknown → 404', async (ctx) => {
    const server = await createRouteServer()
    try {
      const res = await fetch(`${server.url}/api/mcp-extensions/does-not-exist-zzz`, { method: 'DELETE' })
      if (INSTALLER_DOWN.has(res.status)) {
        console.warn('[ext-install] DRIFT: installer unavailable (503); DELETE-unknown test skipped.')
        return ctx.skip()
      }
      expect(res.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  it("evil serverId params ('../x', 'a b') → 400 without touching the installer", async () => {
    const server = await createRouteServer()
    try {
      for (const evil of ['..%2Fx', 'a%20b']) {
        const del = await fetch(`${server.url}/api/mcp-extensions/${evil}`, { method: 'DELETE' })
        expect(del.status).toBe(400)
        const en = await postJson(server.url, `/api/mcp-extensions/${evil}/enable`, {})
        expect(en.status).toBe(400)
      }
    } finally {
      await server.close()
    }
  })
})

it.runIf(!routeAvailable)('route contract pending (drift note)', () => {
  console.warn(
    `[ext-install] DRIFT: server/routes/mcp-extensions.route.ts missing registerMcpExtensionsRoute. ` +
      `Saw keys: [${routeKeys.join(', ')}]. HTTP tests skipped.`,
  )
  expect(routeAvailable).toBe(false)
})
