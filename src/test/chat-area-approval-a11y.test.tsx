import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatArea } from '@/components/chat/ChatArea';
import { PanelProvider } from '@/contexts/PanelContext';
import { useHermesStore } from '@/stores/hermes-store';
import type { AcpApprovalRequest } from '@/lib/hermes-api';

// Spec 6.6: the ACP approval banner lives in the Virtuoso Footer. If the Footer
// component (or the `components` object) is recreated on each ChatArea render,
// React remounts the whole Footer subtree on every streamed token. The banner
// then loses its focus and in-flight state, and its role="alert" is re-announced.
// These tests drive ChatArea through streaming re-renders and assert that the
// banner's DOM nodes survive.

vi.mock('@/components/chat/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => <div>{message.content}</div>,
}));
vi.mock('@/components/chat/ChatInput', () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));
vi.mock('@/components/chat/ActivityIndicator', () => ({
  ActivityIndicator: () => <div data-testid="activity-indicator" />,
}));
vi.mock('@/components/chat/WelcomeScreen', () => ({
  WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));
vi.mock('@/components/chat/ApiKeyModal', () => ({
  ApiKeyModal: () => null,
}));
vi.mock('@/lib/providers', () => ({
  getProviderLabel: (provider: string) => provider,
}));
vi.mock('@/lib/tokens', () => ({
  getContextUsage: () => ({ used: 0, total: 1, percentage: 0 }),
}));

const footerTypes = new Set<unknown>();

// Minimal Virtuoso: renders every item plus the Footer with `context`, exactly
// as react-virtuoso does. A new Footer type per render remounts it here too.
vi.mock('react-virtuoso', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const Virtuoso = React.forwardRef(
    (
      {
        data,
        itemContent,
        context,
        components,
        scrollerRef,
      }: {
        data: unknown[];
        itemContent: (index: number, item: unknown) => React.ReactNode;
        context?: unknown;
        components?: { Footer?: React.ComponentType<{ context?: unknown }> };
        scrollerRef?: (el: HTMLElement | null) => void;
      },
      ref: React.Ref<unknown>,
    ) => {
      React.useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }));
      const Footer = components?.Footer;
      footerTypes.add(Footer);
      return (
        <div ref={(el: HTMLElement | null) => scrollerRef?.(el)} data-testid="virtuoso-scroller">
          {data.map((item, index) => (
            <div key={(item as { id: string }).id}>{itemContent(index, item)}</div>
          ))}
          {Footer && <Footer context={context} />}
        </div>
      );
    },
  );
  return { Virtuoso, VirtuosoHandle: {} as unknown };
});

const approval: AcpApprovalRequest = {
  approval_id: 'acp-1',
  session_id: 'sess-1',
  tool: 'terminal',
  kind: 'execute',
  summary: 'Run npm test',
  command: 'npm test',
};

type Msg = { id: string; role: string; content: string };

function renderChat(messages: Msg[], isStreaming: boolean) {
  return (
    <PanelProvider value="panel-1">
      <ChatArea
        conversationId="conv-1"
        messages={messages}
        input=""
        setInput={() => {}}
        handleSend={() => {}}
        handleStop={() => {}}
        handleRegenerate={() => {}}
        isStreaming={isStreaming}
        error={null}
        apiKeyModalOpen={false}
        setApiKeyModalOpen={() => {}}
        activeProvider="hermes"
        activeModel="hermes-agent"
      />
    </PanelProvider>
  );
}

describe('ChatArea approval banner in the Virtuoso Footer', () => {
  beforeEach(() => {
    footerTypes.clear();
    useHermesStore.setState({ pendingAcpApprovals: {}, requestChatAction: vi.fn() });
  });

  it('keeps the banner mounted and focused across streaming re-renders', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    const messages: Msg[] = [
      { id: 'u1', role: 'user', content: 'run the tests' },
      { id: 'a1', role: 'assistant', content: 'Running' },
    ];
    const { rerender } = render(renderChat(messages, true));

    act(() => {
      useHermesStore.setState({ pendingAcpApprovals: { [approval.approval_id]: approval } });
    });

    const region = screen.getByRole('region', { name: 'Approval required' });
    const alert = screen.getByRole('alert');
    const approve = screen.getByRole('button', { name: 'Approve once: terminal' });
    expect(approve).toHaveFocus();

    // The user moves to Deny, then tokens keep streaming in.
    const deny = screen.getByRole('button', { name: 'Deny: terminal' });
    deny.focus();
    for (let i = 0; i < 5; i += 1) {
      messages[1] = { ...messages[1], content: `${messages[1].content} token${i}` };
      rerender(renderChat([...messages], true));
    }
    rerender(renderChat([...messages], false));

    // Same nodes: nothing remounted, no re-announcement, focus not stolen.
    expect(screen.getByRole('region', { name: 'Approval required' })).toBe(region);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(screen.getByRole('button', { name: 'Deny: terminal' })).toBe(deny);
    expect(deny).toHaveFocus();
    // One stable Footer component type across every render.
    expect(footerTypes.size).toBe(1);
    outside.remove();
  });
});
