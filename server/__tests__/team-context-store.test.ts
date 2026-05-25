import { describe, expect, it, beforeEach } from 'vitest'
import { createTeamContextStore } from '../team-context-store'

describe('team-context-store', () => {
  let store: ReturnType<typeof createTeamContextStore>

  beforeEach(() => {
    store = createTeamContextStore()
  })

  // Note: store.close() is called in each test via try/finally to avoid
  // depending on afterEach type availability in the electron tsconfig.

  describe('publish', () => {
    it('stores and retrieves context entries', () => {
      try {
        const entry = store.publish('team-1', {
          type: 'finding',
          content: 'Found a critical bug',
          author: 'alice',
          importance: 3,
          tags: ['bug', 'security'],
        })

        expect(entry.id).toBeDefined()
        expect(entry.teamId).toBe('team-1')
        expect(entry.type).toBe('finding')
        expect(entry.author).toBe('alice')

        const results = store.query('team-1', {})
        expect(results).toHaveLength(1)
        expect(results[0].content).toContain('Found a critical bug')
      } finally {
        store.close()
      }
    })

    it('filters by type', () => {
      try {
        store.publish('team-1', { type: 'finding', content: 'Finding 1', author: 'alice', importance: 2, tags: [] })
        store.publish('team-1', { type: 'decision', content: 'Decision 1', author: 'bob', importance: 2, tags: [] })

        const decisions = store.query('team-1', { type: 'decision' })
        expect(decisions).toHaveLength(1)
        expect(decisions[0].type).toBe('decision')
      } finally {
        store.close()
      }
    })

    it('filters by author', () => {
      try {
        store.publish('team-1', { type: 'finding', content: 'By alice', author: 'alice', importance: 2, tags: [] })
        store.publish('team-1', { type: 'finding', content: 'By bob', author: 'bob', importance: 2, tags: [] })

        const aliceEntries = store.query('team-1', { author: 'alice' })
        expect(aliceEntries).toHaveLength(1)
        expect(aliceEntries[0].content).toBe('By alice')
      } finally {
        store.close()
      }
    })

    it('scopes queries to team ID', () => {
      try {
        store.publish('team-1', { type: 'finding', content: 'Team 1 finding', author: 'alice', importance: 2, tags: [] })
        store.publish('team-2', { type: 'finding', content: 'Team 2 finding', author: 'bob', importance: 2, tags: [] })

        const team1Entries = store.query('team-1', {})
        expect(team1Entries).toHaveLength(1)
        expect(team1Entries[0].content).toBe('Team 1 finding')
      } finally {
        store.close()
      }
    })
  })
})
