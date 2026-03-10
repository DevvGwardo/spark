import { beforeEach, describe, expect, it } from 'vitest';
import { usePanelStore } from '@/stores/panel-store';
import { usePreviewStore } from '@/stores/preview-store';

describe('panel state isolation', () => {
  beforeEach(() => {
    window.localStorage.removeItem('cloud-chat-panels');
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: null }],
      focusedPanelId: 'default',
    });
    usePreviewStore.setState({ panelPreviews: {} });
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

  it('moves a conversation to the selected panel instead of duplicating it', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: 'conv-1' },
        { id: 'panel-2', conversationId: null },
      ],
      focusedPanelId: 'default',
    });

    usePanelStore.getState().setConversationForPanel('panel-2', 'conv-1');

    expect(usePanelStore.getState().panels).toEqual([
      { id: 'default', conversationId: null },
      { id: 'panel-2', conversationId: 'conv-1' },
    ]);
    expect(usePanelStore.getState().focusedPanelId).toBe('panel-2');
  });

  it('focuses the existing panel when opening a conversation already on screen', () => {
    usePanelStore.setState({
      panels: [
        { id: 'default', conversationId: 'conv-1' },
        { id: 'panel-2', conversationId: null },
      ],
      focusedPanelId: 'panel-2',
    });

    const panelId = usePanelStore.getState().openPanel('conv-1');

    expect(panelId).toBe('default');
    expect(usePanelStore.getState().panels).toHaveLength(2);
    expect(usePanelStore.getState().focusedPanelId).toBe('default');
  });
});
