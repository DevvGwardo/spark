import { hermesFetch } from './core';

export interface HermesSkillSummary {
  id: string;
  name: string;
  summary: string;
  category: string;
  path: string;
  modified_at: string | null;
  line_count: number;
  size_bytes?: number;
  estimated_tokens?: number;
}

export interface HermesSkillDetail extends HermesSkillSummary {
  content: string;
}

export interface HubSkill {
  name: string;
  description: string;
  category: string;
  source: 'built-in' | 'optional' | 'community' | 'anthropic' | 'lobehub';
  installed: boolean;
}

export interface SkillBundle {
  name: string;
  slug?: string;
  path: string;
  skills: string[];
  description?: string | null;
  instruction?: string | null;
}

export async function fetchSkillBundles(): Promise<{ bundles: SkillBundle[]; directory: string }> {
  const data = await hermesFetch<{ bundles?: SkillBundle[]; directory?: string }>('/bundles');
  return {
    bundles: Array.isArray(data.bundles) ? data.bundles : [],
    directory: data.directory || '',
  };
}

export async function fetchSkillBundle(name: string): Promise<{
  ok: boolean;
  bundle: SkillBundle | null;
  error?: string;
}> {
  return hermesFetch(`/bundles/${encodeURIComponent(name)}`);
}

export async function createSkillBundle(body: {
  name: string;
  skills: string[];
  description?: string;
  instruction?: string;
  force?: boolean;
}): Promise<{
  ok: boolean;
  name: string;
  skills: string[];
  bundles: SkillBundle[];
  bundle: SkillBundle | null;
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/create', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteSkillBundle(name: string): Promise<{
  ok: boolean;
  name: string;
  bundles: SkillBundle[];
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/delete', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function reloadSkillBundles(): Promise<{
  ok: boolean;
  bundles: SkillBundle[];
  directory?: string;
  output?: string;
  error?: string;
}> {
  return hermesFetch('/bundles/reload', { method: 'POST', body: '{}' });
}

export async function fetchHermesSkills(): Promise<HermesSkillSummary[]> {
  const data = await hermesFetch<{ skills: HermesSkillSummary[] }>('/workspace/skills');
  return data.skills ?? [];
}

export async function fetchHermesSkillDetail(skillId: string): Promise<HermesSkillDetail> {
  const params = new URLSearchParams({ id: skillId });
  const data = await hermesFetch<{ skill: HermesSkillDetail }>(`/workspace/skills/content?${params.toString()}`);
  return data.skill;
}

export async function deleteHermesSkill(skillId: string): Promise<void> {
  await hermesFetch('/workspace/skills', {
    method: 'DELETE',
    body: JSON.stringify({ id: skillId }),
  });
}

export async function fetchSkillsHub(): Promise<HubSkill[]> {
  const data = await hermesFetch<{ skills: HubSkill[] }>('/workspace/skills/hub');
  return data.skills ?? [];
}

export async function installHubSkill(skillName: string): Promise<void> {
  await hermesFetch('/workspace/skills/hub/install', {
    method: 'POST',
    body: JSON.stringify({ name: skillName }),
  });
}
