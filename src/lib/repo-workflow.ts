import { fetchRepoFileTreeResult } from '@/lib/api';
import type { ActiveRepo } from '@/stores/changeset-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';

interface AttachRepoToPanelInput {
  panelId: string;
  repo: ActiveRepo;
  githubPAT: string;
  openPreview?: boolean;
}

export async function attachRepoToPanel({
  panelId,
  repo,
  githubPAT,
  openPreview = false,
}: AttachRepoToPanelInput): Promise<boolean> {
  const changesetStore = useChangesetStore.getState();
  const previewStore = usePreviewStore.getState();
  const currentChangeset = changesetStore.getChangeset(panelId);
  const currentRepo = currentChangeset.activeRepo;
  const switchingRepos = !!currentRepo && currentRepo.fullName !== repo.fullName;
  const changeCount = changesetStore.getChangeCount(panelId);

  if (switchingRepos && changeCount > 0) {
    const confirmed = window.confirm(
      `You have ${changeCount} pending change${changeCount > 1 ? 's' : ''} for ${currentRepo.fullName}. Switch repos and discard them?`,
    );
    if (!confirmed) {
      return false;
    }
  }

  if (switchingRepos) {
    changesetStore.switchActiveRepo(panelId, repo);
  } else {
    changesetStore.setActiveRepo(panelId, repo);
  }

  if (openPreview) {
    previewStore.setView(panelId, 'repo');
  } else {
    previewStore.setPreferredView(panelId, 'repo');
  }

  const existingTree = changesetStore.getChangeset(panelId).repoFileTree;
  if (existingTree.length > 0 && !switchingRepos) {
    return true;
  }

  changesetStore.setRepoFileTreeStatus(panelId, 'loading');
  const result = await fetchRepoFileTreeResult(githubPAT, repo.owner, repo.name, repo.defaultBranch);
  if (result.error) {
    changesetStore.setRepoFileTreeStatus(panelId, 'error', result.error);
    return true;
  }

  changesetStore.setRepoFileTree(panelId, result.paths);
  return true;
}
