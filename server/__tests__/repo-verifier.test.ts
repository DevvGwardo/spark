import { describe, expect, it } from 'vitest'
import { parseReviewResponse, selectPackageJsonPath } from '../repo-verifier'

describe('repo verifier helpers', () => {
  it('prefers the nearest package.json for changed files in nested workspaces', () => {
    expect(
      selectPackageJsonPath(
        ['client/src/App.tsx'],
        ['package.json', 'client/package.json', 'docs/package.json'],
      ),
    ).toBe('client/package.json')
  })

  it('falls back to the only discovered package.json when the changed files are outside that workspace', () => {
    expect(
      selectPackageJsonPath(
        ['README.md'],
        ['client/package.json'],
      ),
    ).toBe('client/package.json')
  })

  it('parses provider review JSON wrapped in markdown fences', () => {
    expect(
      parseReviewResponse([
        'Here is the review result:',
        '```json',
        '{"summary":"Needs one fix.","findings":[{"severity":"high","title":"Broken import","summary":"The import path is invalid.","file":"client/src/App.tsx"}]}',
        '```',
      ].join('\n')),
    ).toEqual({
      summary: 'Needs one fix.',
      findings: [
        {
          severity: 'high',
          title: 'Broken import',
          summary: 'The import path is invalid.',
          file: 'client/src/App.tsx',
        },
      ],
    })
  })
})
