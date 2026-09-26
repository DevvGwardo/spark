// @vitest-environment node
// proxySseToDataStream: trailing `usage` custom field at stream end + tool-call
// forwarding for the plan-mode direct proxy.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STREAM_ACTIVITY_TIMEOUT_MS } from '../config'
import { proxySseToDataStream, type NormalizedProxyEvent } from '../direct-sse-proxy'

interface FakeRes {
  writeHead: (status: number, headers: Record<string, string>) => void
  write: (chunk: string) => boolean
  end: (chunk?: string) => void
  writableEnded: boolean
}

function createFakeRes(): (EventEmitter & FakeRes) & { chunks: string[] } {
  const res = new EventEmitter() as EventEmitter & FakeRes & { chunks: string[] }
  res.chunks = []
  res.writableEnded = false
  res.writeHead = () => {}
  res.write = (chunk: string) => {
    res.chunks.push(chunk)
    return true
  }
  res.end = (chunk?: string) => {
    if (chunk) {
      res.chunks.push(chunk)
    }
    res.writableEnded = true
  }
  return res
}

function createFakeReq() {
  return new EventEmitter() as unknown as import('express').Request
}

function sseResponse(events: string[]): Response {
  const body = events.join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('proxySseToDataStream usage event', () => {
  it('emits one usage data part at stream end with model + context window', async () => {
    const res = createFakeRes()
    const upstream = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60}}}\n\n',
      'data: [DONE]\n\n',
    ])

    await proxySseToDataStream({
      req: createFakeReq(),
      res: res as unknown as import('express').Response,
      upstreamResponse: upstream,
      corsHeaders: {},
      normalizePayload: (payload) => {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        }
        const usage = parsed.usage
        return {
          text: parsed.choices?.[0]?.delta?.content,
          ...(usage
            ? {
                usage: {
                  promptTokens: usage.prompt_tokens ?? 0,
                  completionTokens: usage.completion_tokens ?? 0,
                  totalTokens: usage.total_tokens ?? 0,
                  cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
                },
              }
            : {}),
        } as NormalizedProxyEvent
      },
      modelName: 'gpt-5.4',
    })

    const output = res.chunks.join('')
    expect(output).toContain('"type":"text-delta"')
    expect(output).toContain('"delta":"hi"')
    expect(output).toContain('"type":"usage"')
    expect(output).toContain('"input_tokens":100')
    expect(output).toContain('"output_tokens":20')
    expect(output).toContain('"cached_input_tokens":60')
    expect(output).toContain('"context_window":400000')
    expect(output).toContain('"model":"gpt-5.4"')
    // Usage data part is written before the terminal finish chunk.
    expect(output.indexOf('"type":"usage"')).toBeLessThan(output.indexOf('"type":"finish"'))
  })

  it('omits the usage event when no modelName is provided (backward compat)', async () => {
    const res = createFakeRes()
    const upstream = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ])

    await proxySseToDataStream({
      req: createFakeReq(),
      res: res as unknown as import('express').Response,
      upstreamResponse: upstream,
      corsHeaders: {},
      normalizePayload: (payload) => JSON.parse(payload) as NormalizedProxyEvent,
    })

    const output = res.chunks.join('')
    expect(output).not.toContain('"type":"usage"')
    expect(output).toContain('"type":"finish"')
  })
})

describe('proxySseToDataStream tool-call forwarding', () => {
  it('forwards upstream tool_calls as AI SDK tool_call parts (plan-mode direct proxy)', async () => {
    const res = createFakeRes()
    const upstream = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"Creating artifact"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"create_html_file","arguments":"{\\"filename\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"index.html\\",\\"content\\":\\"<h1>Plan</h1>\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ])

    await proxySseToDataStream({
      req: createFakeReq(),
      res: res as unknown as import('express').Response,
      upstreamResponse: upstream,
      corsHeaders: {},
      normalizePayload: (payload) => {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>
        }
        const delta = parsed.choices?.[0]?.delta
        const toolCalls = (delta?.tool_calls ?? []).map((call, index) => ({
          index: call.index ?? index,
          ...(call.id ? { id: call.id } : {}),
          ...(call.function?.name ? { name: call.function.name } : {}),
          ...(call.function?.arguments ? { argumentsDelta: call.function.arguments } : {}),
        }))
        return { text: delta?.content, toolCalls } as NormalizedProxyEvent
      },
    })

    const output = res.chunks.join('')
    // Streaming start + deltas as they arrive.
    expect(output).toContain('{"type":"tool-input-start","toolCallId":"call_9","toolName":"create_html_file"}')
    expect(output).toContain('{"type":"tool-input-delta","toolCallId":"call_9"')
    // Final assembled tool-input-available part with parsed args.
    expect(output).toContain('{"type":"tool-input-available","toolCallId":"call_9","toolName":"create_html_file"')
    expect(output).toContain('"filename":"index.html"')
    expect(output).toContain('"content":"<h1>Plan</h1>"')
  })
})

describe('proxySseToDataStream activity timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('surfaces an activity-timeout error when upstream sends nothing', async () => {
    vi.useFakeTimers()
    const res = createFakeRes()
    const upstream = new Response(
      new ReadableStream({
        start() {
          // never enqueue — simulates a hung ACP approval / file write
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

    const done = proxySseToDataStream({
      req: createFakeReq(),
      res: res as unknown as import('express').Response,
      upstreamResponse: upstream,
      corsHeaders: {},
      normalizePayload: () => ({ text: '' }),
    })

    await vi.advanceTimersByTimeAsync(STREAM_ACTIVITY_TIMEOUT_MS)
    await done

    expect(res.chunks.join('')).toContain('Upstream provider stopped sending data (activity timeout).')
    expect(res.writableEnded).toBe(true)
  })
})
