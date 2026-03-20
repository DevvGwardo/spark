import { execFile, execFileSync } from 'child_process'
import { existsSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const DEFAULT_OPENCLAW_TIMEOUT_SECONDS = 90 * 60

function resolveOpenClawBin(): string {
  // 1. Explicit env var
  if (process.env.OPENCLAW_BIN) {
    return process.env.OPENCLAW_BIN
  }

  // 2. Standard install location
  const standardPath = join(os.homedir(), '.openclaw', 'bin', 'openclaw')
  if (existsSync(standardPath)) {
    return standardPath
  }

  // 3. Resolve from PATH (npm global installs, homebrew, etc.)
  try {
    const resolved = execFileSync('which', ['openclaw'], { encoding: 'utf-8' }).trim()
    if (resolved) {
      return resolved
    }
  } catch {
    // which failed — not on PATH
  }

  // Fall back to the standard path (will fail with a clear error in ensureOpenClawInstalled)
  return standardPath
}

let _resolvedBin: string | null = null
function getOpenClawBin(): string {
  if (!_resolvedBin) {
    _resolvedBin = resolveOpenClawBin()
  }
  return _resolvedBin
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]
  if (!rawValue) {
    return fallback
  }

  const parsedValue = Number.parseInt(rawValue, 10)
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallback
}

export interface OpenClawUsage {
  input?: number
  output?: number
  total?: number
}

export interface OpenClawRunResult {
  text: string
  model: string
  usage?: OpenClawUsage
  durationMs: number
}

interface OpenClawModelsListResponse {
  models?: Array<{ key?: string }>
}

interface OpenClawModelsStatusResponse {
  defaultModel?: string
  resolvedDefault?: string
}

async function getOpenClawModelStatus(): Promise<OpenClawModelsStatusResponse> {
  ensureOpenClawInstalled()

  const { stdout } = await execFileAsync(getOpenClawBin(), ['models', 'status', '--json'])
  return JSON.parse(stdout) as OpenClawModelsStatusResponse
}

function ensureOpenClawInstalled() {
  const bin = getOpenClawBin()
  if (!existsSync(bin)) {
    // Clear cache so next attempt re-resolves (e.g. after user installs openclaw)
    _resolvedBin = null
    throw new Error(`OpenClaw CLI not found at ${bin}`)
  }
}

function parseOpenClawText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''

  const payloadRecord = payload as {
    payloads?: Array<{ text?: string | null }>
    text?: string
  }

  if (Array.isArray(payloadRecord.payloads)) {
    return payloadRecord.payloads
      .map((item) => item?.text)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n\n')
  }

  return payloadRecord.text || ''
}

export async function getOpenClawModels(): Promise<{ defaultModel: string; models: string[] }> {
  ensureOpenClawInstalled()

  const [{ stdout: modelsStdout }, statusData] = await Promise.all([
    execFileAsync(getOpenClawBin(), ['models', 'list', '--json']),
    getOpenClawModelStatus(),
  ])

  const modelsData = JSON.parse(modelsStdout) as OpenClawModelsListResponse

  const defaultModel = statusData.resolvedDefault || statusData.defaultModel || 'default'
  const models = Array.isArray(modelsData.models)
    ? modelsData.models
        .map((model) => model?.key)
        .filter((modelKey): modelKey is string => typeof modelKey === 'string' && modelKey.length > 0)
    : []

  return {
    defaultModel,
    models: models.length > 0 ? models : [defaultModel],
  }
}

export async function setOpenClawModel(model: string): Promise<void> {
  ensureOpenClawInstalled()

  const trimmedModel = model.trim()
  if (!trimmedModel || trimmedModel === 'default') {
    return
  }

  const status = await getOpenClawModelStatus()
  const currentModel = status.resolvedDefault || status.defaultModel || 'default'
  if (currentModel === trimmedModel) {
    return
  }

  await execFileAsync(getOpenClawBin(), ['models', 'set', trimmedModel], {
    maxBuffer: 10 * 1024 * 1024,
  })
}

export async function runOpenClawTurn(params: {
  message: string
  sessionId: string
  model?: string
  systemPrompt?: string
  timeoutSeconds?: number
}): Promise<OpenClawRunResult> {
  ensureOpenClawInstalled()

  await setOpenClawModel(params.model || '')

  const effectiveMessage = params.systemPrompt?.trim()
    ? `System instructions:\n${params.systemPrompt.trim()}\n\nUser request:\n${params.message}`
    : params.message

  const args = [
    'agent',
    '--agent', 'main',
    '--session-id', params.sessionId,
    '--message', effectiveMessage,
    '--json',
    '--timeout', String(params.timeoutSeconds ?? readPositiveIntEnv('OPENCLAW_TURN_TIMEOUT_SECONDS', DEFAULT_OPENCLAW_TIMEOUT_SECONDS)),
  ]

  const { stdout } = await execFileAsync(getOpenClawBin(), args, {
    maxBuffer: 10 * 1024 * 1024,
  })

  const parsed = JSON.parse(stdout) as {
    result?: unknown
    meta?: {
      durationMs?: number
      agentMeta?: {
        provider?: string
        model?: string
        lastCallUsage?: OpenClawUsage
        usage?: OpenClawUsage
      }
    }
  }

  const payload = parsed.result && typeof parsed.result === 'object' ? parsed.result : parsed
  const payloadRecord = payload as {
    meta?: {
      durationMs?: number
      agentMeta?: {
        provider?: string
        model?: string
        lastCallUsage?: OpenClawUsage
        usage?: OpenClawUsage
      }
    }
  }

  const agentMeta = payloadRecord.meta?.agentMeta
  const providerModel = [agentMeta?.provider, agentMeta?.model]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('/')

  return {
    text: parseOpenClawText(payload),
    model: providerModel || 'openclaw/default',
    usage: agentMeta?.lastCallUsage || agentMeta?.usage,
    durationMs: payloadRecord.meta?.durationMs || 0,
  }
}
