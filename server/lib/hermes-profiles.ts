import fs from 'fs';
import os from 'os';
import path from 'path';

export function getHermesRoot(): string {
  return path.join(os.homedir(), '.hermes');
}

export function getProfilesRoot(): string {
  return path.join(getHermesRoot(), 'profiles');
}

// CloudChat tracks its own active profile in a dedicated file so app activations
// never mutate ~/.hermes/active_profile (the file the `hermes` CLI reads). This
// keeps a CLI session running with profile X unaffected when the app activates
// profile Y. The bridge still reads X-Hermes-Profile from the request header to
// resolve per-request profile state.
export function getActiveProfilePath(): string {
  return path.join(getHermesRoot(), 'cloudchat_active_profile');
}

export function getActiveProfileName(): string {
  const activePath = getActiveProfilePath();
  if (!fs.existsSync(activePath)) return 'default';
  try {
    const raw = fs.readFileSync(activePath, 'utf-8').trim();
    if (!raw || raw === 'default') {
      return 'default';
    }
    return validateProfileName(raw);
  } catch {
    return 'default';
  }
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
