import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes } from 'crypto'
import { shell } from 'electron'

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'
const OAUTH_TIMEOUT_MS = 5 * 60_000

let cancelActiveFlow: ((message: string) => void) | null = null

function sendHtml(response: ServerResponse, statusCode: number, body: string) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function getAuthorizationCode(request: IncomingMessage): { code?: string; error?: string } {
  const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
  const code = requestUrl.searchParams.get('code')?.trim()
  const error = requestUrl.searchParams.get('error')?.trim()
  const errorDescription = requestUrl.searchParams.get('error_description')?.trim()

  if (error) {
    return {
      error: errorDescription ? `${error}: ${errorDescription}` : error,
    }
  }

  if (!code) {
    return { error: 'Missing authorization code in redirect.' }
  }

  return { code }
}

async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<string> {
  const response = await fetch(OPENROUTER_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      code_challenge_method: 'S256',
    }),
  })

  let data: { key?: string; user_api_key?: string; error?: { message?: string } } = {}
  try {
    data = await response.json() as { key?: string; user_api_key?: string; error?: { message?: string } }
  } catch {
    // Fall through to the generic response error below.
  }

  const apiKey = data.user_api_key || data.key
  if (!response.ok || !apiKey) {
    throw new Error(data.error?.message || 'OpenRouter did not return an API key.')
  }

  return apiKey
}

export async function startOpenRouterOAuth(): Promise<string> {
  if (cancelActiveFlow) {
    cancelActiveFlow('OpenRouter sign-in was cancelled by a new request.')
  }

  const codeVerifier = randomBytes(64).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null

    const finish = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cancelActiveFlow = null
      if (timeout) {
        clearTimeout(timeout)
      }
      server.close()
      callback()
    }

    cancelActiveFlow = (message: string) => {
      finish(() => reject(new Error(message)))
    }

    const server = createServer((request, response) => {
      const { code, error } = getAuthorizationCode(request)
      if (error) {
        sendHtml(response, 400, '<!doctype html><title>OpenRouter Sign-In Failed</title><body style="margin:0;background:#090909;color:#f4f4f5;font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;display:grid;place-items:center;min-height:100vh;">Authentication failed. Return to Spark.</body>')
        finish(() => reject(new Error(error)))
        return
      }

      if (!code) {
        sendHtml(response, 400, '<!doctype html><title>OpenRouter Sign-In Failed</title><body style="margin:0;background:#090909;color:#f4f4f5;font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;display:grid;place-items:center;min-height:100vh;">Authentication failed. Return to Spark.</body>')
        finish(() => reject(new Error('Missing authorization code in redirect.')))
        return
      }

      sendHtml(response, 200, '<!doctype html><title>OpenRouter Connected</title><body style="margin:0;background:#090909;color:#f4f4f5;font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;display:grid;place-items:center;min-height:100vh;">Authentication complete. Return to Spark.</body>')
      void (async () => {
        try {
          const apiKey = await exchangeAuthorizationCode(code, codeVerifier)
          finish(() => resolve(apiKey))
        } catch (exchangeError) {
          finish(() => reject(exchangeError instanceof Error ? exchangeError : new Error('OpenRouter key exchange failed.')))
        }
      })()
    })

    server.on('error', (error) => {
      finish(() => reject(error))
    })

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        finish(() => reject(new Error('Failed to allocate a local callback port for OpenRouter sign-in.')))
        return
      }

      const callbackUrl = `http://localhost:${address.port}/oauth/openrouter/callback`
      const authUrl = new URL(OPENROUTER_AUTH_URL)
      authUrl.searchParams.set('callback_url', callbackUrl)
      authUrl.searchParams.set('code_challenge', codeChallenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')

      timeout = setTimeout(() => {
        finish(() => reject(new Error('OpenRouter sign-in timed out after 5 minutes.')))
      }, OAUTH_TIMEOUT_MS)

      try {
        await shell.openExternal(authUrl.toString())
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('Failed to open the OpenRouter sign-in page.')))
      }
    })
  })
}
