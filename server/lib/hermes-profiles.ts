import type { Request } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function getHermesRoot(): string {
  return path.join(os.homedir(), '.hermes');
}

export function getProfilesRoot(): string {
  return path.join(getHermesRoot(), 'profiles');
}

// The active profile is selected client-side (per-window, persisted in
// localStorage) and sent to the server on every Hermes-related request via
// the X-Hermes-Profile header. The server holds no profile state of its own,
// so two windows can switch profiles independently, and the hermes CLI's
// ~/.hermes/active_profile file is never touched by the app.
export function getProfileFromRequest(req: Request): string {
  const raw = req.headers['x-hermes-profile'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return 'default';
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === 'default') return 'default';
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return 'default';
  }
  return trimmed;
}

export function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Profile name is required');
  if (trimmed === 'default') throw new Error('Default profile cannot be modified');
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    throw new Error('Invalid profile name');
  }
  return trimmed;
}

export function resolveHermesHome(profileName: string): string {
  if (profileName === 'default') {
    return getHermesRoot();
  }
  return path.join(getProfilesRoot(), validateProfileName(profileName));
}

// Auto-provision a profile directory on first use. Session-bound panels pick
// their own profile name up front, so the directory may not exist until the
// first Hermes request fires. No-op for 'default' (the CLI owns that root).
export function ensureProfileExists(profileName: string): void {
  if (profileName === 'default') return;
  const profilePath = resolveHermesHome(profileName);
  if (fs.existsSync(profilePath)) return;
  fs.mkdirSync(profilePath, { recursive: true });
  fs.mkdirSync(path.join(profilePath, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(profilePath, 'sessions'), { recursive: true });
  const configPath = path.join(profilePath, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, 'model: ""\nprovider: ""\n', 'utf-8');
  }
}
