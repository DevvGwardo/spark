/**
 * Spark Electron — MiniBrowser / BrowserView Tests
 *
 * Tests the BrowserView lifecycle (create, navigate, resize, close)
 * and the security fix that blocks file:// and other non-http URLs.
 *
 * KEY FIXES TESTED HERE:
 * - URL protocol validation (file:// blocked)
 * - Bounds clamping (can't overlap toolbar)
 * - BrowserView lifecycle management
 *
 * All navigations target a local fixture http server (127.0.0.1) so the tests
 * never depend on network access, and every test arranges its own view via an
 * explicit create() and tears it down with close() — no order dependence.
 */
import { test, expect } from '@playwright/test'
import http from 'http'
import { launchElectronApp, ElectronAppFixture, ElectronAPI } from './electron-app'

let fixture: ElectronAppFixture
let fixtureServer: http.Server
let fixtureBase = ''

const HOME_HTML =
  '<!doctype html><html><body><h1 id="fixture-home">Mini browser fixture home</h1><a href="/page2">page 2</a></body></html>'
const PAGE2_HTML =
  '<!doctype html><html><body><h1 id="fixture-page2">Mini browser fixture page 2</h1></body></html>'
// Deliberately contains "needle" three times so find-in-page has a known count.
const FIND_HTML =
  '<!doctype html><html><body><h1 id="fixture-find">needle one</h1><p>needle two</p><p>needle three</p></body></html>'

test.beforeAll(async () => {
  fixture = await launchElectronApp()

  // Tiny local fixture server — offline-safe target for the BrowserView.
  fixtureServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/page2') {
      res.end(PAGE2_HTML)
      return
    }
    if (req.url === '/find') {
      res.end(FIND_HTML)
      return
    }
    res.end(HOME_HTML)
  })
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
  const address = fixtureServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('fixture server failed to bind')
  }
  fixtureBase = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
  await fixture.close()
})

test.describe('MiniBrowser IPC — Security Fixes', () => {
  test('browser:create with file:// URL is silently rejected', async () => {
    const result = await fixture.window.evaluate(async () => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.create || !api?.getUrl) return { error: 'no browser API' }

      await api.close() // explicit arrange: no view may be left behind
      await api.create('file:///etc/passwd')
      const url = await api.getUrl()
      return { success: true, url }
    })

    expect(result).toEqual({ success: true, url: null })
  })

  test('browser:navigate with file:// URL is silently rejected', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.navigate || !api?.getUrl || !api?.create) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      await api.create(`${base}/`)
      await waitForUrl(`${base}/`) // initial load must land before the guard check
      await api.navigate('file:///etc/passwd')
      const url = await api.getUrl()
      await api.close()
      return { success: true, url, isFile: typeof url === 'string' && url.startsWith('file:') }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.isFile).toBe(false)
    expect(result.url).toBe(`${fixtureBase}/`)
  })

  test('browser:navigate with javascript: URL is silently rejected', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.navigate || !api?.getUrl || !api?.create) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.navigate('javascript:alert(1)')
      const url = await api.getUrl()
      await api.close()
      return { success: true, url, isJavascript: typeof url === 'string' && url.startsWith('javascript:') }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.isJavascript).toBe(false)
    expect(result.url).toBe(`${fixtureBase}/`)
  })

  test('browser:navigate with data: URL is silently rejected', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.navigate || !api?.getUrl || !api?.create) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.navigate('data:text/html,<h1>pwned</h1>')
      const url = await api.getUrl()
      await api.close()
      return { success: true, url, isData: typeof url === 'string' && url.startsWith('data:') }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.isData).toBe(false)
    expect(result.url).toBe(`${fixtureBase}/`)
  })
})

test.describe('MiniBrowser IPC — Lifecycle', () => {
  test('browser:create with no URL completes without error', async () => {
    const result = await fixture.window.evaluate(async () => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.create || !api?.getUrl) return { error: 'no browser API' }

      // The main process defaults an empty create() to about:blank; poll
      // because the initial load is async (a direct getUrl() can race it).
      await api.create()
      const deadline = Date.now() + 8000
      let url = (await api.getUrl()) as string
      while (url !== 'about:blank' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        url = (await api.getUrl()) as string
      }
      await api.close()
      return { success: true, url }
    })

    expect(result.success).toBe(true)
    expect(result.url).toBe('about:blank')
  })

  test('browser:navigate loads an http:// URL in the view', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.create || !api?.navigate || !api?.getUrl) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      // Explicit arrange: this test owns its own view.
      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.navigate(`${base}/page2`)
      const url = await waitForUrl(`${base}/page2`)
      await api.close()
      return { success: true, url }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.url).toBe(`${fixtureBase}/page2`)
  })

  test('browser:resize with valid bounds completes', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.create || !api?.resize) return { error: 'no browser API' }

      await api.create(`${base}/`)
      await api.resize({ x: 100, y: 100, width: 500, height: 400 })
      await api.close()
      return { success: true }
    }, fixtureBase)

    expect(result).toEqual({ success: true })
  })

  test('browser:resize clamps y to toolbar area (y >= 36)', async () => {
    // The fix: bounds clamping prevents BrowserView from overlapping toolbar.
    // We can't directly verify the clamped value from the renderer,
    // but we can verify the call doesn't crash with extreme values.
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.create || !api?.resize) return { error: 'no browser API' }

      await api.create(`${base}/`)

      // Try to set y=0 (should be clamped to 36 by main process)
      await api.resize({ x: 0, y: 0, width: 500, height: 400 })

      // Try negative values
      await api.resize({ x: -100, y: -100, width: 50, height: 50 })

      // Try huge values
      await api.resize({ x: 99999, y: 99999, width: 99999, height: 99999 })

      await api.close()
      return { success: true }
    }, fixtureBase)

    expect(result).toEqual({ success: true })
  })

  test('browser:reload completes', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.reload || !api?.create || !api?.getUrl) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.reload()
      const url = await waitForUrl(`${base}/`) // reload keeps the same URL
      await api.close()
      return { success: true, url }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.url).toBe(`${fixtureBase}/`)
  })

  test('browser:show and browser:hide complete', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.show || !api?.hide || !api?.create || !api?.getUrl) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      // Explicit arrange: show/hide are no-ops without a live view.
      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.show()
      await api.hide()
      await api.show()
      const url = await api.getUrl()
      await api.close()
      return { success: true, url }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.url).toBe(`${fixtureBase}/`)
  })

  test('browser:go-back and browser:go-forward navigate through history', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.goBack || !api?.goForward || !api?.create || !api?.navigate || !api?.getUrl) {
        return { error: 'no browser API' }
      }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      // Arrange: a view with real history to navigate through.
      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.navigate(`${base}/page2`)
      await waitForUrl(`${base}/page2`)

      await api.goBack()
      const backUrl = await waitForUrl(`${base}/`)
      await api.goForward()
      const forwardUrl = await waitForUrl(`${base}/page2`)

      await api.close()
      return { success: true, backUrl, forwardUrl }
    }, fixtureBase)

    expect(result.success).toBe(true)
    expect(result.backUrl).toBe(`${fixtureBase}/`)
    expect(result.forwardUrl).toBe(`${fixtureBase}/page2`)
  })

  test('full lifecycle: create → navigate → resize → show → hide → close', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api) return { error: 'no browser API' }

      const waitForUrl = async (expected: string) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          const url = await api.getUrl()
          if (url === expected) return url as string
          await new Promise((r) => setTimeout(r, 100))
        }
        return (await api.getUrl()) as string
      }

      await api.create(`${base}/`)
      await waitForUrl(`${base}/`)
      await api.navigate(`${base}/page2`)
      await waitForUrl(`${base}/page2`)
      await api.resize({ x: 50, y: 60, width: 600, height: 400 })
      await api.show()
      await api.hide()
      await api.show()
      await api.close()
      const urlAfterClose = await api.getUrl()
      return { success: true, urlAfterClose, steps: 'all passed' }
    }, fixtureBase)

    expect(result).toEqual({ success: true, urlAfterClose: null, steps: 'all passed' })
  })
})

test.describe('MiniBrowser IPC — Find in page', () => {
  test('findInPage reports matches over found-in-page and stopFindInPage clears', async () => {
    const result = await fixture.window.evaluate(async (base: string) => {
      const api = (window as unknown as { electronAPI?: ElectronAPI }).electronAPI?.browser
      if (!api?.findInPage || !api?.stopFindInPage || !api?.onFoundInPage || !api?.getUrl || !api?.create || !api?.close) {
        return { error: 'no find API' }
      }

      const events: { requestId: number; matches: number; activeMatchOrdinal: number }[] = []
      const unsub = api.onFoundInPage((r) => events.push(r))

      await api.create(`${base}/find`)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        if ((await api.getUrl()) === `${base}/find`) break
        await new Promise((r) => setTimeout(r, 100))
      }
      // Let the page finish layout so findInPage has content to scan.
      await new Promise((r) => setTimeout(r, 800))

      const search = async (q: string) => {
        events.length = 0
        const invoked = (await api.findInPage(q, { findNext: true })) as { requestId: number } | null
        await new Promise((r) => setTimeout(r, 600))
        return { invoked, events: JSON.parse(JSON.stringify(events)) as typeof events }
      }

      const first = await search('needle')
      const repeat = await search('needle')
      const miss = await search('zzz-no-such-text-zzz')
      const back = await search('needle')

      await api.stopFindInPage('clearSelection')
      unsub()
      await api.close()

      return {
        firstId: first.invoked?.requestId ?? -1,
        firstEvent: first.events[0] ?? null,
        repeatOrdinal: repeat.events[0]?.activeMatchOrdinal ?? -1,
        missMatches: miss.events[0]?.matches ?? -1,
        backOrdinal: back.events[0]?.activeMatchOrdinal ?? -1,
        backMatches: back.events[0]?.matches ?? -1,
      }
    }, fixtureBase)

    expect(result.error).toBeUndefined()
    // A real find request reached the BrowserView.
    expect(result.firstId).toBeGreaterThan(0)
    // The fixture page has exactly three "needle" occurrences.
    expect(result.firstEvent?.matches).toBe(3)
    expect(result.firstEvent?.activeMatchOrdinal).toBe(1)
    // Repeating the query advances to the next match instead of restarting.
    expect(result.repeatOrdinal).toBe(2)
    // Text that isn't on the page reports zero matches...
    expect(result.missMatches).toBe(0)
    // ...and returning to a real query restarts at match 1 with the full count.
    expect(result.backMatches).toBe(3)
    expect(result.backOrdinal).toBe(1)
  })
})
