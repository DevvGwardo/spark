import net from 'net'
import { startServer } from '../server/index'

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
 * Server code is bundled with the main process by electron-vite,
 * so the import resolves in both dev and prod.
 */
export async function startEmbeddedServer(): Promise<number> {
  const port = await findFreePort(3001)
  await startServer(port)
  return port
}
