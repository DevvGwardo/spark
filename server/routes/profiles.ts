import { type Express } from 'express';
import fs from 'fs';
import path from 'path';
import {
  getActiveProfileName,
  getActiveProfilePath,
  getHermesRoot,
  getProfilesRoot,
  validateProfileName,
} from '../lib/hermes-profiles';

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

export function registerProfilesRoutes(app: Express) {
  // GET /api/hermes/profiles - list all profiles
  app.get('/api/hermes/profiles', (_req, res) => {
    try {
      const profilesRoot = getProfilesRoot();
      const activeProfile = getActiveProfileName();
      const results: Array<{
        name: string; path: string; active: boolean; model?: string;
        provider?: string; skillCount: number; sessionCount: number; hasEnv: boolean;
      }> = [];

      if (fs.existsSync(profilesRoot)) {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(profilesRoot, { withFileTypes: true }); } catch { /* empty */ }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const name = entry.name;
          const profilePath = path.join(profilesRoot, name);
          const config = readYamlConfig(path.join(profilePath, 'config.yaml'));
          results.push({
            name, path: profilePath, active: name === activeProfile,
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
        name: 'default', path: root, active: activeProfile === 'default',
        model: defaultConfig.model as string | undefined,
        provider: defaultConfig.provider as string | undefined,
        skillCount: countFilesRecursive(path.join(root, 'skills'), (p) => path.basename(p) === 'SKILL.md'),
        sessionCount: countFilesRecursive(path.join(root, 'sessions'), (p) => /\.(jsonl|json|sqlite|db)$/i.test(p)),
        hasEnv: fs.existsSync(path.join(root, '.env')),
      });

      results.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        return a.name.localeCompare(b.name);
      });

      res.json({ profiles: results, activeProfile });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list profiles' });
    }
  });

  // POST /api/hermes/profiles/activate - switch active profile
  app.post('/api/hermes/profiles/activate', (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Profile name required' });
      if (name === 'default') {
        const activePath = getActiveProfilePath();
        if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
      } else {
        const normalized = validateProfileName(name);
        const profilePath = path.join(getProfilesRoot(), normalized);
        if (!fs.existsSync(profilePath)) return res.status(404).json({ error: 'Profile not found' });
        fs.mkdirSync(getHermesRoot(), { recursive: true });
        fs.writeFileSync(getActiveProfilePath(), `${normalized}\n`, 'utf-8');
      }
      res.json({ ok: true, activeProfile: name });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to activate profile' });
    }
  });

  // POST /api/hermes/profiles/create - create new profile
  app.post('/api/hermes/profiles/create', (req, res) => {
    try {
      const { name, cloneFrom } = req.body;
      if (!name) return res.status(400).json({ error: 'Profile name required' });
      const normalized = validateProfileName(name);
      const profilePath = path.join(getProfilesRoot(), normalized);
      if (fs.existsSync(profilePath)) return res.status(409).json({ error: 'Profile already exists' });

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

      res.json({ ok: true, profile: { name: normalized, path: profilePath } });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create profile' });
    }
  });

  // POST /api/hermes/profiles/delete - delete profile (moves to trash)
  app.post('/api/hermes/profiles/delete', (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'Profile name required' });
      const normalized = validateProfileName(name);
      if (normalized === getActiveProfileName()) {
        return res.status(400).json({ error: 'Cannot delete the active profile' });
      }
      const profilePath = path.join(getProfilesRoot(), normalized);
      if (!fs.existsSync(profilePath)) return res.status(404).json({ error: 'Profile not found' });

      const trashDir = path.join(getHermesRoot(), 'trash');
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(profilePath, path.join(trashDir, `${normalized}-${Date.now()}`));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete profile' });
    }
  });
}
