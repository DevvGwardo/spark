import net from 'net'
import { startServer } from '../server/index'

const PREFERRED_PORT = 3001
const REQUIRED_SERVER_ROUTES = [
  '/functions/v1/chat',
  '/functions/v1/chat-store/conversations',
  '/functions/v1/chat-store/messages',
  '/functions/v1/validate-key',
  '/api/hermes/cron',
  '/api/hermes/sessions',
  '/api/hermes/workspace/overview',
  '/api/hermes/workspace/usage',
  '/api/hermes/workspace/files',
  '/api/hermes/workspace/skills',
] as const

function hasRequiredRoutes(routes: unknown): boolean {
  if (!Array.isArray(routes)) {
    return false
  }

  const availableRoutes = new Set(
    routes.filter((route): route is string => typeof route === 'string' && route.length > 0),
  )

  return REQUIRED_SERVER_ROUTES.every((route) => availableRoutes.has(route))
}

/**
 * Check if a CloudChat API server is already running on the given port
 * by hitting the health endpoint.
 */
export async function isCloudChatServerRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`http://localhost:${port}/functions/v1/health`, {
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return false
    const data = await res.json()
    return data?.ok === true && hasRequiredRoutes(data?.routes)
  } catch {
    return false
  }
}

/**
 * Start the embedded Express server.
 * If the preferred port already has a running CloudChat API server,
 * reuse it instead of starting a duplicate.
 * Server code is bundled with the main process by electron-vite,
 * so the import resolves in both dev and prod.
 */
export async function startEmbeddedServer(): Promise<number> {
  // If the standalone server is already running on the preferred port, reuse it.
  if (await isCloudChatServerRunning(PREFERRED_PORT)) {
    console.log(`[electron-server] CloudChat API server already running on :${PREFERRED_PORT}, reusing it`)
    return PREFERRED_PORT
  }

  // No existing server — start our own on the preferred port (or a free fallback).
  const port = await findFreePort(PREFERRED_PORT)
  await startServer(port)
  return port
}

/**
 * Find a free port, starting from the preferred port.
 */
function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(preferred, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferred
      server.close(() => resolve(port))
    })
    server.on('error', () => {
      // Preferred port in use, let OS assign one
      const server2 = net.createServer()
      server2.listen(0, () => {
        const address = server2.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server2.close(() => resolve(port))
      })
      server2.on('error', reject)
    })
  })
}
