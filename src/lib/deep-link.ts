import type { DeepLinkNavigateTarget } from '@/electron.d';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';
import { toast } from '@/lib/toast';

/**
 * Phase 4 renderer handlers for main→renderer events.
 *
 * - `quick:capture` text → open a fresh thread prefilled with the text.
 *   Prefill rides `queuePanelPrompt(panelId, { autoSend: false })` — the
 *   useChat effect drains it into the draft input without sending.
 * - `deep-link:navigate` { kind, id?, name? } → chat selects the thread,
 *   skill opens the Skills surface, oauth is ignored (localhost flow owns it).
 */
export function handleQuickCapture(text: string): void {
  const content = text.trim();
  if (!content) return;
  const ui = useUIStore.getState();
  ui.setActiveTab('chat');
  // openConversation keeps an in-flight stream alive (new panel) and returns
  // the target panel id, so the prefill lands in the visible draft.
  const panelId = usePanelStore.getState().openConversation(null);
  ui.queuePanelPrompt(panelId, { content, autoSend: false });
}

export function handleDeepLinkNavigate(target: DeepLinkNavigateTarget): void {
  const ui = useUIStore.getState();
  if (target.kind === 'chat') {
    if (!target.id) return;
    const exists = useChatStore.getState().conversations.some((c) => c.id === target.id);
    if (!exists) {
      toast.info(`Conversation ${target.id} not found`);
      return;
    }
    ui.setActiveTab('chat');
    usePanelStore.getState().openConversation(target.id);
    return;
  }
  if (target.kind === 'skill') {
    // Natural skills surface: HermesSkillsPanel (sidebar sub-tab, hermes only).
    if (useSettingsStore.getState().activeProvider === 'hermes') {
      ui.setActiveTab('chat');
      ui.setActiveSubTab('skills');
      if (target.name) toast.info(`Skill "${target.name}" — see Skills panel`);
    } else {
      toast.info(`Skill ${target.name ?? target.id ?? 'link'} requested from link`);
    }
    return;
  }
  // kind === 'oauth' (and anything unknown): ignored here — the localhost
  // OAuth flow owns token exchange; the renderer must not act on it.
}
