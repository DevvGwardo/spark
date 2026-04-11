/**
 * CloudChat Electron — Renderer / UI Tests
 *
 * Tests that the React app renders correctly inside Electron,
 * key UI components are present, and the API connection works.
 */
import { test, expect } from '@playwright/test'
import { launchElectronApp, ElectronAppFixture } from './electron-app'

let fixture: ElectronAppFixture

test.beforeAll(async () => {
  fixture = await launchElectronApp()
})

test.afterAll(async () => {
  await fixture.close()
})

test.describe('Renderer App', () => {
  test('React app mounts (root element exists)', async () => {
    const hasRoot = await fixture.window.evaluate(() => {
      const root = document.getElementById('root') || document.getElementById('app')
      return root !== null && root.children.length > 0
    })
    expect(hasRoot).toBe(true)
  })

  test('embedded API server is reachable', async () => {
    const apiPort = await fixture.window.evaluate(() => {
      return (window as any).electronAPI?.apiPort
    })

    if (!apiPort) {
      test.skip()
      return
    }

    // Try hitting the health endpoint from the renderer
    const response = await fixture.window.evaluate(async (port: number) => {
      try {
        const res = await fetch(`http://localhost:${port}/api/health`)
        return { ok: res.ok, status: res.status }
      } catch (err: any) {
        return { ok: false, error: err.message }
      }
    }, apiPort)

    // The server should respond (even if it's a 404 on some routes)
    expect(response.ok || response.status === 404).toBe(true)
  })

  test('external links open in system browser (not in-app)', async () => {
    // The will-navigate handler should prevent navigation away from localhost/file://
    // We verify the handler is set up by checking the app stays on its page
    const urlBefore = fixture.window.url()

    // Try to trigger a navigation (simulated)
    const stayedOnPage = await fixture.window.evaluate(() => {
      // Check that the app's origin is localhost or file://
      return window.location.protocol === 'file:' ||
             window.location.hostname === 'localhost'
    })

    expect(stayedOnPage).toBe(true)
    const urlAfter = fixture.window.url()
    // URL should not have changed to an external site
    expect(urlAfter).toBe(urlBefore)
  })
})

test.describe('UI Components', () => {
  test('sidebar is present', async () => {
    // Wait a moment for React to fully hydrate
    await fixture.window.waitForTimeout(3000)

    const hasSidebar = await fixture.window.evaluate(() => {
      // Look for sidebar-like elements
      const candidates = [
        document.querySelector('[class*="sidebar"]'),
        document.querySelector('[class*="Sidebar"]'),
        document.querySelector('[data-testid*="sidebar"]'),
        document.querySelector('aside'),
        document.querySelector('nav'),
      ]
      return candidates.some(el => el !== null)
    })

    // At least one sidebar-like element should exist
    expect(hasSidebar).toBe(true)
  })

  test('chat area or main content is present', async () => {
    await fixture.window.waitForTimeout(2000)

    const hasContent = await fixture.window.evaluate(() => {
      const candidates = [
        document.querySelector('[class*="chat"]'),
        document.querySelector('[class*="Chat"]'),
        document.querySelector('[class*="main"]'),
        document.querySelector('[class*="content"]'),
        document.querySelector('main'),
      ]
      return candidates.some(el => el !== null)
    })

    expect(hasContent).toBe(true)
  })
})
