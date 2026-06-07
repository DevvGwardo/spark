import { fetchRepoFileTreeResult } from '@/lib/api';
import { getChatScopeId } from '@/lib/chat-scope';
import { db } from '@/lib/db';
import { usePanelStore } from '@/stores/panel-store';
import { useChatStore } from '@/stores/chat-store';
import type { ActiveRepo } from '@/stores/changeset-store';
import { useChangesetStore } from '@/stores/changeset-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * Eagerly persist a panel's thread→project pointer so the sidebar groups the
 * thread under its repo immediately. Without this the pointer is only written
 * by useChat's debounced auto-save (which runs only while that conversation's
 * panel is mounted), so a freshly-attached repo wouldn't show until later.
 * No-ops for panels without a conversation yet — those get the pointer when the
 * conversation is created and saved.
 */
async function persistPanelRepoPointer(panelId: string, repoFullName: string): Promise<void> {
  try {
    const convId = usePanelStore.getState().panels.find((p) => p.id === panelId)?.conversationId;
    if (!convId) return;
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (conv && (conv.repoFullName ?? null) === repoFullName) return;
    await db.conversations.update(convId, { repoFullName });
    await useChatStore.getState().loadConversations();
  } catch {
    // Best-effort sidebar grouping sync — never block repo attach on a db hiccup.
  }
}

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

  // Reflect the attached project on the thread right away (sidebar grouping).
  void persistPanelRepoPointer(panelId, repo.fullName);

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
  const panel = usePanelStore.getState().panels.find((entry) => entry.id === panelId);
  const shouldPreservePanelRepo = !!panel?.conversationId;

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
    throw error;
  }
}
