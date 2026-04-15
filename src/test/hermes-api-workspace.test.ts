import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchSkillsHub,
  fetchHermesSkillDetail,
  installHubSkill,
  updateHermesWorkspaceFile,
} from '@/lib/hermes-api';

function mockJsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('hermes workspace api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encodes skill ids when requesting skill content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      skill: {
        id: 'ops/SKILL.md',
        name: 'ops',
        summary: 'summary',
        category: 'ops',
        path: '/tmp/ops/SKILL.md',
        modified_at: null,
        line_count: 10,
        content: '# Ops',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchHermesSkillDetail('ops/SKILL.md');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hermes/workspace/skills/content?id=ops%2FSKILL.md');
  });

  it('sends expected_version when saving a workspace file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      file: {
        key: 'memory',
        label: 'MEMORY.md',
        description: 'memory',
        path: '/tmp/MEMORY.md',
        exists: true,
        size: 5,
        modified_at: null,
        preview: 'hello',
        version: 'next456',
        content: 'hello',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await updateHermesWorkspaceFile('memory', 'hello', 'abc123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.expected_version).toBe('abc123');
    expect(payload.content).toBe('hello');
  });

  it('loads the skills hub catalog from the hub endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      skills: [
        {
          name: 'duckduckgo-search',
          description: 'Search skill',
          category: 'research',
          source: 'optional',
          installed: false,
        },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    const skills = await fetchSkillsHub();

    expect(skills).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hermes/workspace/skills/hub');
  });

  it('posts a hub install request by skill name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await installHubSkill('duckduckgo-search');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/api/hermes/workspace/skills/hub/install');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(init.body));
    expect(payload.name).toBe('duckduckgo-search');
    expect(init.method).toBe('POST');
  });
});
