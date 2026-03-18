import { describe, expect, it } from 'vitest'
import { normalizeChatMessages } from '../message-normalization'

describe('normalizeChatMessages', () => {
  it('moves system-role messages into a synthetic instruction user message', () => {
    const input = normalizeChatMessages(
      [
        { role: 'system', content: 'First system instruction.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'system', content: 'Second system instruction.' },
      ],
      'Base system prompt.',
    )

    expect(input.messages).toEqual([
      {
        role: 'user',
        content: [
          'Application instructions:',
          'The following guidance is supplied by CloudChat and must be followed while responding.',
          '',
          'Base system prompt.',
          '',
          'First system instruction.',
          '',
          'Second system instruction.',
        ].join('\n'),
      },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ])
  })

  it('ignores malformed entries and keeps non-system message objects intact', () => {
    const toolMessage = { role: 'tool', content: 'done', toolCallId: 'call-1' }
    const input = normalizeChatMessages(
      [null, 'bad', { role: 'system', content: 'Hidden continuation' }, toolMessage],
      undefined,
    )

    expect(input.messages).toEqual([
      {
        role: 'user',
        content: [
          'Application instructions:',
          'The following guidance is supplied by CloudChat and must be followed while responding.',
          '',
          'Hidden continuation',
        ].join('\n'),
      },
      toolMessage,
    ])
  })
})
