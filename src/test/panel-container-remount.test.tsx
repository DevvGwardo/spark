import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { ChatPanelContainer } from '@/components/chat/ChatPanelContainer';
import { usePanelStore } from '@/stores/panel-store';

// Track mounts/unmounts per panelId. A ChatPanel unmount mid-stream aborts
// the panel's useChat stream and drops unpersisted messages, so adding or
// closing a sibling panel must never remount existing panels.
const mounts: string[] = [];
const unmounts: string[] = [];

vi.mock('@/components/chat/ChatPanel', () => ({
  ChatPanel: ({ panelId }: { panelId: string }) => {
    useEffect(() => {
      mounts.push(panelId);
      return () => { unmounts.push(panelId); };
    }, [panelId]);
    return <div data-testid={`panel-${panelId}`} />;
  },
}));

describe('ChatPanelContainer panel lifecycle', () => {
  beforeEach(() => {
    mounts.length = 0;
    unmounts.length = 0;
    usePanelStore.setState({
      panels: [{ id: 'default', conversationId: 'conv-1', profile: 'default' }],
      focusedPanelId: 'default',
    });
  });

  it('does not remount an existing panel when a second panel opens (1 → 2)', () => {
    render(<ChatPanelContainer />);
    expect(mounts).toEqual(['default']);

    act(() => { usePanelStore.getState().openPanel(null); });

    expect(unmounts).not.toContain('default');
    expect(mounts.filter((id) => id === 'default')).toHaveLength(1);
  });

  it('does not remount existing panels when a third panel opens (2 → 3)', () => {
    act(() => { usePanelStore.getState().openPanel('conv-2'); });
    render(<ChatPanelContainer />);
    const before = [...mounts];

    act(() => { usePanelStore.getState().openPanel('conv-3'); });

    expect(unmounts).toEqual([]);
    expect(mounts.slice(0, before.length)).toEqual(before);
  });

  it('keeps the surviving panel mounted when a sibling closes (2 → 1)', () => {
    let secondId = '';
    act(() => { secondId = usePanelStore.getState().openPanel('conv-2'); });
    render(<ChatPanelContainer />);

    act(() => { usePanelStore.getState().closePanel(secondId); });

    expect(unmounts).toEqual([secondId]);
    expect(mounts.filter((id) => id === 'default')).toHaveLength(1);
  });
});
