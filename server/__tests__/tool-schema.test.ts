// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { coreToolToOpenAiFunction, coreToolsToOpenAiFunctions } from '../lib/tool-schema'

describe('coreToolToOpenAiFunction', () => {
  it('converts an AI SDK tool into an OpenAI function definition', () => {
    const coreTool = tool({
      description: 'Create an HTML file.',
      inputSchema: z.object({
        filename: z.string().describe('The filename'),
        content: z.string().describe('The content'),
        overwrite: z.boolean().optional(),
      }),
    })

    const definition = coreToolToOpenAiFunction('create_html_file', coreTool)
    expect(definition).toEqual({
      type: 'function',
      function: {
        name: 'create_html_file',
        description: 'Create an HTML file.',
        inputSchema: {
          type: 'object',
          description: 'Create an HTML file.',
          properties: {
            filename: { type: 'string', description: 'The filename' },
            content: { type: 'string', description: 'The content' },
            overwrite: { type: ['boolean', 'null'] },
          },
          required: ['filename', 'content'],
        },
      },
    })
  })

  it('handles arrays, enums and defaults', () => {
    const coreTool = tool({
      description: 'Pick files.',
      inputSchema: z.object({
        paths: z.array(z.string()),
        action: z.enum(['create', 'edit']).default('create'),
      }),
    })

    const definition = coreToolToOpenAiFunction('pick', coreTool)
    const parameters = definition.function.inputSchema as {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(parameters.type).toBe('object')
    expect(parameters.properties.paths).toEqual({ type: 'array', items: { type: 'string' } })
    expect(parameters.properties.action).toEqual({ type: 'string', enum: ['create', 'edit'] })
    expect(parameters.required).toEqual(['paths'])
  })

  it('falls back to a permissive schema for unsupported constructs', () => {
    const coreTool = tool({
      description: 'Anything goes.',
      inputSchema: z.any(),
    })
    const definition = coreToolToOpenAiFunction('any_tool', coreTool)
    expect(definition.function.name).toBe('any_tool')
    expect(typeof definition.function.inputSchema).toBe('object')
  })

  it('converts tool records into an OpenAI tools array', () => {
    const tools = {
      create_html_file: tool({
        description: 'Create an HTML file.',
        inputSchema: z.object({ filename: z.string() }),
      }),
      create_css_file: tool({
        description: 'Create a CSS file.',
        inputSchema: z.object({ filename: z.string() }),
      }),
    }
    const definitions = coreToolsToOpenAiFunctions(tools)
    expect(definitions.map((definition) => definition.function.name)).toEqual([
      'create_html_file',
      'create_css_file',
    ])
  })
})
