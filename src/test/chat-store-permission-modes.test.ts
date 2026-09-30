import { describe, expect, it, vi, beforeEach } from 'vitest';

// chat-store pulls in the IndexedDB layer at module scope; the mode logic under
// test never touches it, so stub the whole module out.
vi.mock('@/lib/db', () => ({
  db: {},
  addTag: vi.fn(),
  removeTag: vi.fn(),
  archiveConversation: vi.fn(),
  unarchiveConversation: vi.fn(),
}));

import { useChatStore } from '@/stores/chat-store';
import { DEFAULT_PERMISSION_MODE } from '../../shared/permission-modes';

describe('chat-store permission modes', () => {
  beforeEach(() => {
    useChatStore.setState({ permissionMode: DEFAULT_PERMISSION_MODE, planMode: false });
  });

  it('starts in the default mode with planMode off', () => {
    const state = useChatStore.getState();
    expect(state.permissionMode).toBe('default');
    expect(state.planMode).toBe(false);
  });

  it('keeps the legacy planMode flag in sync with the mode', () => {
    useChatStore.getState().setPermissionMode('plan');
    expect(useChatStore.getState().planMode).toBe(true);

    useChatStore.getState().setPermissionMode('acceptEdits');
    expect(useChatStore.getState().planMode).toBe(false);
    expect(useChatStore.getState().permissionMode).toBe('acceptEdits');
  });

  it('drives the mode from the legacy planMode setter', () => {
    useChatStore.getState().setPlanMode(true);
    expect(useChatStore.getState().permissionMode).toBe('plan');

    useChatStore.getState().setPlanMode(false);
    expect(useChatStore.getState().permissionMode).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('accepts every non-plan mode without setting planMode', () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk'] as const) {
      useChatStore.getState().setPermissionMode(mode);
      expect(useChatStore.getState().permissionMode).toBe(mode);
      expect(useChatStore.getState().planMode).toBe(false);
    }
  });
});
