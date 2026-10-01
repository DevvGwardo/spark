// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildLocalExecutionTools } from '../local-tools'

describe('run_command output budget', () => {
  it('keeps the head and the tail of long output so trailing errors survive', async () => {
    const tools = buildLocalExecutionTools({ terminal: true, files: false, code_execution: false })
    const script = "for i in $(seq 1 3000); do echo line-$i-padding-padding; done; echo FINAL-ERROR >&2; exit 3"
    const output: string = await tools.run_command.execute(
      { command: script },
      { toolCallId: 't', messages: [], context: undefined },
    )

    expect(output.length).toBeLessThan(16_000)
    expect(output.startsWith('line-1-padding')).toBe(true)
    expect(output).toContain('omitted from the middle')
    expect(output).toContain('FINAL-ERROR')
    expect(output.trimEnd().endsWith('[Exit code: 3]')).toBe(true)
  })
})
