import { describe, expect, it } from 'vitest';
import { filterSkills } from '@/components/sidebar/hermesSidebarUtils';
import type { HermesSkillSummary } from '@/lib/hermes-api';

function makeSkill(overrides: Partial<HermesSkillSummary>): HermesSkillSummary {
  return {
    id: 'skill-000',
    name: 'unnamed',
    summary: '',
    category: 'general',
    path: '/skills/unnamed',
    modified_at: null,
    line_count: 0,
    ...overrides,
  };
}

const skills: HermesSkillSummary[] = [
  makeSkill({ id: 'a', name: 'Deploy to Vercel', summary: 'Ship the app to production' }),
  makeSkill({ id: 'b', name: 'Run tests', summary: 'Execute the Vitest suite', category: 'qa' }),
  makeSkill({ id: 'c', name: 'Write release notes', summary: 'Summarize changes for users' }),
];

describe('filterSkills', () => {
  it('returns all skills for an empty or whitespace-only query', () => {
    expect(filterSkills(skills, '')).toHaveLength(3);
    expect(filterSkills(skills, '   ')).toHaveLength(3);
  });

  it('matches the skill name case-insensitively', () => {
    const result = filterSkills(skills, 'DEPLOY');
    expect(result.map((s) => s.id)).toEqual(['a']);
  });

  it('matches the skill description (summary)', () => {
    const result = filterSkills(skills, 'vitest');
    expect(result.map((s) => s.id)).toEqual(['b']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterSkills(skills, 'nonexistent-needle')).toEqual([]);
  });
});
