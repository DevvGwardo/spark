import { describe, it, expect } from 'vitest'

describe('server exports', () => {
  it('exports createApp and startServer functions', async () => {
    const serverModule = await import('../index')
    expect(typeof serverModule.createApp).toBe('function')
    expect(typeof serverModule.startServer).toBe('function')
  })

  it('createApp returns an express app with listen method', async () => {
    const { createApp } = await import('../index')
    const app = createApp()
    expect(app).toBeDefined()
    expect(typeof app.listen).toBe('function')
  })
})
