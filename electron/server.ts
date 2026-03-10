import net from 'net'
import { app } from 'electron'
import { join } from 'path'

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

/**
 * Start the embedded Express server.
 * Resolves the server/index path relative to the app root so it works
 * both in dev (source tree) and prod (packaged app).
 */
export async function startEmbeddedServer(): Promise<number> {
  const port = await findFreePort(3001)

  // In production, app.getAppPath() points to the asar/unpacked app root.
  // In dev, it points to the project root. Either way, server/index is there.
  const serverPath = join(app.getAppPath(), 'server', 'index')
  const { startServer } = await import(serverPath)
  await startServer(port)
  return port
}
