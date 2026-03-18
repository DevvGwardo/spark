export interface RepoPermissionState {
  permissions?: {
    pull?: boolean;
    push?: boolean;
    admin?: boolean;
  } | null;
}

export function getRepoAccessLabel(repo: RepoPermissionState | null | undefined): string {
  if (!repo) {
    return 'No repo';
  }

  const permissions = repo.permissions;
  if (!permissions) {
    return 'Access unknown';
  }

  if (permissions.admin) {
    return 'Admin';
  }

  if (permissions.push) {
    return 'Can push';
  }

  if (permissions.pull) {
    return 'Read-only';
  }

  return 'No access';
}
