import { fetchRepoFileTreeResult } from '@/lib/api';
import { getChatScopeId } from '@/lib/chat-scope';
import { usePanelStore } from '@/stores/panel-store';
import type { ActiveRepo } from '@/stores/changeset-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useUIStore } from '@/stores/ui-store';

interface AttachRepoToPanelInput {
  panelId: string;
  repo: ActiveRepo;
  githubPAT: string;
  scopeId?: string;
  openPreview?: boolean;
}

interface StartRepoChatInNewThreadInput {
  panelId: string;
  repo: ActiveRepo;
  githubPAT: string;
  prompt: string;
  openPreview?: boolean;
  repoEditIntentOverride?: boolean;
}

export function getPanelChatScopeId(panelId: string): string {
  const panel = usePanelStore.getState().panels.find((entry) => entry.id === panelId);
  return getChatScopeId(panelId, panel?.conversationId ?? null);
}

export async function attachRepoToPanel({
  panelId,
  repo,
  githubPAT,
  scopeId = panelId,
  openPreview = false,
}: AttachRepoToPanelInput): Promise<boolean> {
  const changesetStore = useChangesetStore.getState();
  const previewStore = usePreviewStore.getState();
  const currentChangeset = changesetStore.getChangeset(scopeId);
  const currentRepo = currentChangeset.activeRepo;
  const switchingRepos = !!currentRepo && currentRepo.fullName !== repo.fullName;
  const changeCount = changesetStore.getChangeCount(scopeId);

  if (switchingRepos && changeCount > 0) {
    const confirmed = window.confirm(
      `You have ${changeCount} pending change${changeCount > 1 ? 's' : ''} for ${currentRepo.fullName}. Switch repos and discard them?`,
    );
    if (!confirmed) {
      return false;
    }
  }

  if (switchingRepos) {
    changesetStore.switchActiveRepo(scopeId, repo);
  } else {
    changesetStore.setActiveRepo(scopeId, repo);
  }

  if (openPreview) {
    previewStore.setView(scopeId, 'repo');
  } else {
    previewStore.setPreferredView(scopeId, 'repo');
  }

  const existingTree = changesetStore.getChangeset(scopeId).repoFileTree;
  if (existingTree.length > 0 && !switchingRepos) {
    return true;
  }

  changesetStore.setRepoFileTreeStatus(scopeId, 'loading');
  const result = await fetchRepoFileTreeResult(githubPAT, repo.owner, repo.name, repo.defaultBranch);
  if (result.error) {
    changesetStore.setRepoFileTreeStatus(scopeId, 'error', result.error);
    return true;
  }

  changesetStore.setRepoFileTree(scopeId, result.paths);
  return true;
}

export async function startRepoChatInNewThread({
  panelId,
  repo,
  githubPAT,
  prompt,
  openPreview = false,
  repoEditIntentOverride,
}: StartRepoChatInNewThreadInput): Promise<boolean> {
  const orchestratorStore = useOrchestratorStore.getState();
  const wasOrchestratorEnabled = orchestratorStore.enabled;
  const panel = usePanelStore.getState().panels.find((entry) => entry.id === panelId);
  const shouldPreservePanelRepo = !!panel?.conversationId;

  if (wasOrchestratorEnabled) {
    orchestratorStore.setEnabled(false);
  }

  try {
    if (shouldPreservePanelRepo) {
      useUIStore.getState().markPanelRepoHandoff(panelId);
    }
    usePanelStore.getState().setConversationForPanel(panelId, null);

    const attached = await attachRepoToPanel({
      panelId,
      scopeId: panelId,
      repo,
      githubPAT,
      openPreview,
    });

    if (!attached) {
      if (shouldPreservePanelRepo) {
        useUIStore.getState().clearPanelRepoHandoff(panelId);
      }
      if (wasOrchestratorEnabled) {
        useOrchestratorStore.getState().setEnabled(true);
      }
      return false;
    }

    useUIStore.getState().queuePanelPrompt(panelId, {
      content: prompt,
      autoSend: true,
      ...(typeof repoEditIntentOverride === 'boolean' ? { repoEditIntentOverride } : {}),
    });

    return true;
  } catch (error) {
    if (shouldPreservePanelRepo) {
      useUIStore.getState().clearPanelRepoHandoff(panelId);
    }
    if (wasOrchestratorEnabled) {
      useOrchestratorStore.getState().setEnabled(true);
    }
    throw error;
  }
}
