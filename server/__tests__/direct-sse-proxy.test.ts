import { describe, expect, it } from 'vitest'

import { isAbortLikeError } from '../direct-sse-proxy'

describe('isAbortLikeError', () => {
  it('matches DOM abort errors', () => {
    expect(isAbortLikeError(new DOMException('This operation was aborted', 'AbortError'))).toBe(true)
  })

  it('matches undici terminated errors and nested abort causes', () => {
    expect(isAbortLikeError(new TypeError('terminated'))).toBe(true)
    expect(
      isAbortLikeError(
        new Error('stream failed', {
          cause: { code: 'UND_ERR_ABORTED' },
        }),
      ),
    ).toBe(true)
  })

  it('does not match unrelated transport failures', () => {
    expect(isAbortLikeError(new Error('socket hang up'))).toBe(false)
  })
})
