// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { inspectHermesRuntimes } from '../routes/hermes-runtimes'

describe('Hermes runtimes route', () => {
  it('reports host unavailable when the local Hermes install is missing', async () => {
    const execFileAsync = vi.fn(async () => {
      throw new Error('docker missing')
    })

    const result = await inspectHermesRuntimes({
      pathExists: vi.fn(async () => false),
      execFileAsync,
      fetchImpl: vi.fn(),
    })

    expect(result.host).toEqual({
      source: expect.stringContaining('/.hermes/hermes-agent'),
      version: null,
      gitSha: null,
      available: false,
    })
    expect(result.container.available).toBe(false)
    expect(execFileAsync).toHaveBeenCalledTimes(1)
    expect(execFileAsync).toHaveBeenCalledWith(
      'docker',
      ['version', '--format', '{{.Client.Version}}'],
      { timeout: 10000 },
    )
  })

  it('reports host available with version and git sha when the local Hermes install exists', async () => {
    const execFileAsync = vi.fn(async (file: string, args: string[]) => {
      if (file.endsWith('/venv/bin/hermes') && args[0] === '--version') {
        return { stdout: 'Hermes Agent v1.2.3\n', stderr: '' }
      }
      if (file === 'git' && args.includes('rev-parse')) {
        return { stdout: 'abc123\n', stderr: '' }
      }
      if (file === 'docker' && args[0] === 'version') {
        throw new Error('docker missing')
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`)
    })

    const result = await inspectHermesRuntimes({
      pathExists: vi.fn(async (path: string) => path.includes('/.hermes/hermes-agent')),
      execFileAsync,
      fetchImpl: vi.fn(),
    })

    expect(result.host).toEqual({
      source: expect.stringContaining('/.hermes/hermes-agent'),
      version: 'v1.2.3',
      gitSha: 'abc123',
      available: true,
    })
    expect(result.container.available).toBe(false)
    expect(execFileAsync).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/venv/bin/hermes'),
      ['--version'],
      expect.objectContaining({ timeout: 10000 }),
    )
    expect(execFileAsync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['-C', expect.stringContaining('/.hermes/hermes-agent'), 'rev-parse', '--short', 'HEAD'],
      { timeout: 10000 },
    )
  })
})
