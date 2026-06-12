import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  getHermesRoot,
  getProfilesRoot,
  getProfileFromRequest,
  validateProfileName,
  resolveHermesHome,
} from '../lib/hermes-profiles';
import { sendJson } from '../lib/helpers';

function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config: Record<string, unknown> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (match) {
        const val = match[2].trim();
        config[match[1]] = val || undefined;
      }
    }
    return config;
  } catch {
    return {};
  }
}

function countFilesRecursive(rootPath: string, predicate: (p: string) => boolean): number {
  if (!fs.existsSync(rootPath)) return 0;
  let count = 0;
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(fullPath); continue; }
      if (predicate(fullPath)) count++;
    }
  }
  return count;
}

type ProfileListEntry = {
  name: string; path: string; model?: string; provider?: string;
  skillCount: number; sessionCount: number; hasEnv: boolean;
};

const PROFILE_LIST_TTL_MS = 30_000;
let profileListCache: { data: ProfileListEntry[]; expiresAt: number } | null = null;

function invalidateProfileListCache(): void {
  profileListCache = null;
}

function buildProfileList(): ProfileListEntry[] {
  const profilesRoot = getProfilesRoot();
  const results: ProfileListEntry[] = [];

  if (fs.existsSync(profilesRoot)) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(profilesRoot, { withFileTypes: true }); } catch { /* empty */ }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const profilePath = path.join(profilesRoot, name);
      const config = readYamlConfig(path.join(profilePath, 'config.yaml'));
      results.push({
        name, path: profilePath,
        model: config.model as string | undefined,
        provider: config.provider as string | undefined,
        skillCount: countFilesRecursive(path.join(profilePath, 'skills'), (p) => path.basename(p) === 'SKILL.md'),
        sessionCount: countFilesRecursive(path.join(profilePath, 'sessions'), (p) => /\.(jsonl|json|sqlite|db)$/i.test(p)),
        hasEnv: fs.existsSync(path.join(profilePath, '.env')),
      });
    }
  }

  const root = getHermesRoot();
  const defaultConfig = readYamlConfig(path.join(root, 'config.yaml'));
  results.unshift({
    name: 'default', path: root,
    model: defaultConfig.model as string | undefined,
    provider: defaultConfig.provider as string | undefined,
    skillCount: countFilesRecursive(path.join(root, 'skills'), (p) => path.basename(p) === 'SKILL.md'),
    sessionCount: countFilesRecursive(path.join(root, 'sessions'), (p) => /\.(jsonl|json|sqlite|db)$/i.test(p)),
    hasEnv: fs.existsSync(path.join(root, '.env')),
  });

  return results;
}

function getCachedProfileList(): ProfileListEntry[] {
  const now = Date.now();
  if (profileListCache && profileListCache.expiresAt > now) {
    return profileListCache.data;
  }
  const data = buildProfileList();
  profileListCache = { data, expiresAt: now + PROFILE_LIST_TTL_MS };
  return data;
}

export function registerProfilesRoutes(app: Express) {
  // GET /api/hermes/profiles - list all profiles. The `active` flag reflects
  // the requesting window's selection (sent via X-Hermes-Profile header);
  // the server itself holds no active-profile state.
  app.get('/api/hermes/profiles', (req: Request, res: Response) => {
    try {
      const requestProfile = getProfileFromRequest(req);
      const results = getCachedProfileList().map((profile) => ({
        ...profile,
        active: profile.name === requestProfile,
      }));

      results.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return a.name.localeCompare(b.name);
      });

      sendJson(res, 200, { profiles: results, activeProfile: requestProfile });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list profiles';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/profiles/create - create new profile
  app.post('/api/hermes/profiles/create', (req: Request, res: Response) => {
    try {
      const { name, cloneFrom } = req.body;
      if (!name) return sendJson(res, 400, { error: 'Profile name required' });
      const normalized = validateProfileName(name);
      const profilePath = path.join(getProfilesRoot(), normalized);
      if (fs.existsSync(profilePath)) return sendJson(res, 409, { error: 'Profile already exists' });

      fs.mkdirSync(profilePath, { recursive: true });
      fs.mkdirSync(path.join(profilePath, 'skills'), { recursive: true });
      fs.mkdirSync(path.join(profilePath, 'sessions'), { recursive: true });

      let configContent = '';
      if (cloneFrom) {
        const sourcePath = cloneFrom === 'default'
          ? path.join(getHermesRoot(), 'config.yaml')
          : path.join(getProfilesRoot(), validateProfileName(cloneFrom), 'config.yaml');
        if (fs.existsSync(sourcePath)) configContent = fs.readFileSync(sourcePath, 'utf-8');
      }
      if (!configContent) configContent = 'model: ""\nprovider: ""\n';
      fs.writeFileSync(path.join(profilePath, 'config.yaml'), configContent, 'utf-8');

      invalidateProfileListCache();
      sendJson(res, 200, { ok: true, profile: { name: normalized, path: profilePath } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create profile';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/profiles/delete - delete profile (moves to trash). The
  // client enforces "can't delete the profile I'm currently using" — other
  // windows' selections are not visible to the server.
  app.post('/api/hermes/profiles/delete', (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) return sendJson(res, 400, { error: 'Profile name required' });
      const normalized = validateProfileName(name);
      const profilePath = path.join(getProfilesRoot(), normalized);
      if (!fs.existsSync(profilePath)) return sendJson(res, 404, { error: 'Profile not found' });

      const trashDir = path.join(getHermesRoot(), 'trash');
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(profilePath, path.join(trashDir, `${normalized}-${Date.now()}`));
      invalidateProfileListCache();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete profile';
      sendJson(res, 500, { error: message });
    }
  });

  // ─── Profile detail ────────────────────────────────────────────────────────

  // GET /api/hermes/profiles/:name/detail — full profile detail
  app.get('/api/hermes/profiles/:name/detail', (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      if (name === 'default') {
        const root = getHermesRoot();
        const config = readYamlConfig(path.join(root, 'config.yaml'));
        return sendJson(res, 200, {
          name: 'default',
          path: root,
          config,
          hasEnv: fs.existsSync(path.join(root, '.env')),
          skillCount: countFilesRecursive(path.join(root, 'skills'), (p) => path.basename(p) === 'SKILL.md'),
          sessionCount: countFilesRecursive(path.join(root, 'sessions'), (p) => /\.(jsonl|json|sqlite|db)$/i.test(p)),
          updatedAt: getMtime(path.join(root, 'config.yaml')),
        });
      }

      const profilePath = resolveHermesHome(name);
      if (!fs.existsSync(profilePath)) {
        return sendJson(res, 404, { error: `Profile "${name}" not found` });
      }

      const config = readYamlConfig(path.join(profilePath, 'config.yaml'));
      sendJson(res, 200, {
        name,
        path: profilePath,
        config,
        hasEnv: fs.existsSync(path.join(profilePath, '.env')),
        skillCount: countFilesRecursive(path.join(profilePath, 'skills'), (p) => path.basename(p) === 'SKILL.md'),
        sessionCount: countFilesRecursive(path.join(profilePath, 'sessions'), (p) => /\.(jsonl|json|sqlite|db)$/i.test(p)),
        updatedAt: getMtime(path.join(profilePath, 'config.yaml')),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get profile detail';
      sendJson(res, 500, { error: message });
    }
  });

  // GET /api/hermes/profiles/:name/config — return config.yaml content as raw text + parsed JSON
  app.get('/api/hermes/profiles/:name/config', (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      let configPath: string;
      if (name === 'default') {
        configPath = path.join(getHermesRoot(), 'config.yaml');
      } else {
        const profilePath = resolveHermesHome(name);
        if (!fs.existsSync(profilePath)) {
          return sendJson(res, 404, { error: `Profile "${name}" not found` });
        }
        configPath = path.join(profilePath, 'config.yaml');
      }

      if (!fs.existsSync(configPath)) {
        return sendJson(res, 200, { content: '', parsed: {} });
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = readYamlConfig(configPath);
      sendJson(res, 200, { content, parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read config';
      sendJson(res, 500, { error: message });
    }
  });

  // PUT /api/hermes/profiles/:name/config — write config.yaml from { content: string }
  app.put('/api/hermes/profiles/:name/config', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { content } = req.body;

      if (typeof content !== 'string') {
        return sendJson(res, 400, { error: 'content must be a string' });
      }

      if (name === 'default') {
        return sendJson(res, 400, { error: 'Default profile cannot be modified via this endpoint' });
      }

      const profilePath = resolveHermesHome(name);
      if (!fs.existsSync(profilePath)) {
        return sendJson(res, 404, { error: `Profile "${name}" not found` });
      }

      const configPath = path.join(profilePath, 'config.yaml');
      fs.writeFileSync(configPath, content, 'utf-8');

      const parsed = readYamlConfig(configPath);
      sendJson(res, 200, { ok: true, parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to write config';
      sendJson(res, 500, { error: message });
    }
  });

  // GET /api/hermes/profiles/:name/env — return .env content or { exists: false }
  app.get('/api/hermes/profiles/:name/env', (req: Request, res: Response) => {
    try {
      const { name } = req.params;

      let envPath: string;
      if (name === 'default') {
        envPath = path.join(getHermesRoot(), '.env');
      } else {
        const profilePath = resolveHermesHome(name);
        if (!fs.existsSync(profilePath)) {
          return sendJson(res, 404, { error: `Profile "${name}" not found` });
        }
        envPath = path.join(profilePath, '.env');
      }

      if (!fs.existsSync(envPath)) {
        return sendJson(res, 200, { exists: false });
      }

      const content = fs.readFileSync(envPath, 'utf-8');
      sendJson(res, 200, { exists: true, content });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read .env';
      sendJson(res, 500, { error: message });
    }
  });

  // PUT /api/hermes/profiles/:name/env — write .env content
  app.put('/api/hermes/profiles/:name/env', (req: Request, res: Response) => {
    try {
      const { name } = req.params;
      const { content } = req.body;

      if (typeof content !== 'string') {
        return sendJson(res, 400, { error: 'content must be a string' });
      }

      if (name === 'default') {
        return sendJson(res, 400, { error: 'Default profile cannot be modified via this endpoint' });
      }

      const profilePath = resolveHermesHome(name);
      if (!fs.existsSync(profilePath)) {
        return sendJson(res, 404, { error: `Profile "${name}" not found` });
      }

      const envPath = path.join(profilePath, '.env');
      fs.writeFileSync(envPath, content, 'utf-8');
      sendJson(res, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to write .env';
      sendJson(res, 500, { error: message });
    }
  });

  // POST /api/hermes/profiles/rename — rename profile directory
  app.post('/api/hermes/profiles/rename', (req: Request, res: Response) => {
    try {
      const { name, newName } = req.body;

      if (!name || !newName) {
        return sendJson(res, 400, { error: 'Both name and newName are required' });
      }

      const normalized = validateProfileName(name);
      const normalizedNew = validateProfileName(newName);

      if (normalized === 'default' || normalizedNew === 'default') {
        return sendJson(res, 400, { error: 'Default profile cannot be renamed' });
      }

      const profilesRoot = getProfilesRoot();
      const oldPath = path.join(profilesRoot, normalized);
      const newPath = path.join(profilesRoot, normalizedNew);

      if (!fs.existsSync(oldPath)) {
        return sendJson(res, 404, { error: `Profile "${normalized}" not found` });
      }

      if (fs.existsSync(newPath)) {
        return sendJson(res, 409, { error: `Profile "${normalizedNew}" already exists` });
      }

      fs.renameSync(oldPath, newPath);
      invalidateProfileListCache();
      sendJson(res, 200, { ok: true, profile: { name: normalizedNew, path: newPath } });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename profile';
      sendJson(res, 500, { error: message });
    }
  });
}

/**
 * Get the mtime of a file as a Unix timestamp (ms), or null if the file doesn't exist.
 */
function getMtime(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}
