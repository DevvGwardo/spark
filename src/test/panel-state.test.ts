import { beforeEach, describe, expect, it } from 'vitest';
import { usePanelStore } from '@/stores/panel-store';
import { usePreviewStore } from '@/stores/preview-store';
import { useChatQueueStore } from '@/stores/chat-queue-store';

describe('panel state isolation', () => {
  beforeEach(() => {
    window.localStorage.removeItem('cloud-chat-panels');
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null, profile: 'default' }],
      focusedPanelId: 'default',
    });
    usePreviewStore.setState({ panelPreviews: {} });
    useChatQueueStore.setState({ panelQueues: {} });
  });

  it('keeps preview files isolated per panel', () => {
    const previewStore = usePreviewStore.getState();

    previewStore.addFile('default', {
      filename: 'alpha.html',
      content: '<main>alpha</main>',
      type: 'html',
    });
    previewStore.addFile('panel-2', {
      filename: 'beta.html',
      content: '<main>beta</main>',
      type: 'html',
    });

    expect(previewStore.getPreview('default').files.map((file) => file.filename)).toEqual(['alpha.html']);
    expect(previewStore.getPreview('panel-2').files.map((file) => file.filename)).toEqual(['beta.html']);
    expect(previewStore.getPreview('default').activeFileId).not.toBe(previewStore.getPreview('panel-2').activeFileId);
  });

  it('does not auto-open the preview rail when a new artifact file is added', () => {
    const previewStore = usePreviewStore.getState();

    previewStore.addFile('default', {
      filename: 'artifact.html',
      content: '<main>artifact</main>',
      type: 'html',
    });

    expect(previewStore.getPreview('default').files.map((file) => file.filename)).toEqual(['artifact.html']);
    expect(previewStore.getPreview('default').isOpen).toBe(false);
    expect(previewStore.getPreview('default').activeView).toBe('preview');
  });

  it('keeps workspace rail views isolated per panel', () => {
    const previewStore = usePreviewStore.getState();

    previewStore.setView('default', 'repo');
    previewStore.setView('panel-2', 'changes');

    expect(previewStore.getPreview('default').activeView).toBe('repo');
    expect(previewStore.getPreview('panel-2').activeView).toBe('changes');
  });

  it('can prefer a workspace rail view without opening the rail', () => {
    const previewStore = usePreviewStore.getState();

    previewStore.setPreferredView('default', 'repo');

    expect(previewStore.getPreview('default').activeView).toBe('repo');
    expect(previewStore.getPreview('default').isOpen).toBe(false);
  });

  it('clamps workspace rail width per panel', () => {
    const previewStore = usePreviewStore.getState();

    previewStore.setRailWidth('default', 900);
    previewStore.setRailWidth('panel-2', 320);

    expect(previewStore.getPreview('default').railWidth).toBe(760);
    expect(previewStore.getPreview('panel-2').railWidth).toBe(360);
  });

  it('moves a conversation to the selected panel instead of duplicating it', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: 'conv-1', profile: 'default' },
        { id: 'panel-2', conversationId: null, profile: 'default' },
      ],
      focusedPanelId: 'default',
    });

    usePanelStore.getState().setConversationForPanel('panel-2', 'conv-1');

    expect(usePanelStore.getState().panels).toEqual([
      { id: 'default', conversationId: null, profile: 'default' },
      { id: 'panel-2', conversationId: 'conv-1', profile: 'default' },
    ]);
    expect(usePanelStore.getState().focusedPanelId).toBe('panel-2');
  });

  it('openConversation reuses the focused panel when it is idle', () => {
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: 'conv-1', profile: 'default' }],
      focusedPanelId: 'default',
    });

    const panelId = usePanelStore.getState().openConversation(null);

    expect(panelId).toBe('default');
    expect(usePanelStore.getState().panels).toHaveLength(1);
    expect(usePanelStore.getState().panels[0].conversationId).toBeNull();
  });

  it('openConversation opens a new panel when the focused panel is streaming', () => {
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: 'conv-1', profile: 'default' }],
      focusedPanelId: 'default',
    });
    useChatQueueStore.getState().setPanelQueue({
      panelId: 'default',
      conversationId: 'conv-1',
      profile: 'default',
      isStreaming: true,
      waitingForOtherPanel: false,
      messages: [],
    });

    const panelId = usePanelStore.getState().openConversation(null);

    expect(panelId).not.toBe('default');
    const { panels, focusedPanelId } = usePanelStore.getState();
    expect(panels).toHaveLength(2);
    // The streaming panel keeps its conversation; the new panel is the blank thread
    expect(panels[0]).toMatchObject({ id: 'default', conversationId: 'conv-1' });
    expect(panels[1]).toMatchObject({ id: panelId, conversationId: null });
    expect(focusedPanelId).toBe(panelId);
  });

  it('openConversation focuses the existing panel when the conversation is already open', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: 'conv-1', profile: 'default' },
        { id: 'panel-2', conversationId: 'conv-2', profile: 'session-x' },
      ],
      focusedPanelId: 'panel-2',
    });
    useChatQueueStore.getState().setPanelQueue({
      panelId: 'panel-2',
      conversationId: 'conv-2',
      profile: 'session-x',
      isStreaming: true,
      waitingForOtherPanel: false,
      messages: [],
    });

    const panelId = usePanelStore.getState().openConversation('conv-1');

    expect(panelId).toBe('default');
    expect(usePanelStore.getState().panels).toHaveLength(2);
    expect(usePanelStore.getState().focusedPanelId).toBe('default');
  });

  it('setConversationForPanel with focus: false does not steal focus', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: null, profile: 'default' },
        { id: 'panel-2', conversationId: null, profile: 'session-x' },
      ],
      focusedPanelId: 'panel-2',
    });

    usePanelStore.getState().setConversationForPanel('default', 'conv-1', { focus: false });

    expect(usePanelStore.getState().panels[0].conversationId).toBe('conv-1');
    expect(usePanelStore.getState().focusedPanelId).toBe('panel-2');
  });

  it('focuses the existing panel when opening a conversation already on screen', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: 'conv-1', profile: 'default' },
        { id: 'panel-2', conversationId: null, profile: 'default' },
      ],
      focusedPanelId: 'panel-2',
    });

    const panelId = usePanelStore.getState().openPanel('conv-1');

    expect(panelId).toBe('default');
    expect(usePanelStore.getState().panels).toHaveLength(2);
    expect(usePanelStore.getState().focusedPanelId).toBe('default');
  });
});
