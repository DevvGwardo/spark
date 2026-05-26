
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractImageUrls } from '@/components/sidebar/ImagesPanel';
import type { Conversation, Message } from '@/lib/db';

function assetUrl(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (path.startsWith('/tmp/')) {
    return `cloudchat-asset://tmp/${encodeURIComponent(basename)}`;
  }
  return `cloudchat-asset://hermes/${encodeURIComponent(basename)}`;
}

// --- Unit tests for extractImageUrls ---

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: '',
    timestamp: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

const conv: Conversation = {
  id: 'conv-1',
  title: 'Test conversation',
  provider: 'anthropic',
  model: 'claude-3',
  systemPrompt: '',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

describe('extractImageUrls', () => {
  it('extracts markdown image URLs', () => {
    const messages = [makeMsg({ content: 'Here is an image: ![screenshot](https://example.com/img.png)' })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/img.png');
    expect(result[0].conversationId).toBe('conv-1');
    expect(result[0].conversationTitle).toBe('Test conversation');
  });

  it('extracts standalone image URLs', () => {
    const messages = [makeMsg({ content: 'Check this out https://cdn.example.com/photo.jpg in the chat' })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://cdn.example.com/photo.jpg');
  });

  it('extracts data URIs', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const messages = [makeMsg({ content: `Image: ${dataUri}` })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe(dataUri);
  });

  it('deduplicates identical URLs', () => {
    const messages = [
      makeMsg({ content: '![a](https://example.com/img.png) and ![b](https://example.com/img.png)' }),
    ];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(1);
  });

  it('returns empty for messages with no images', () => {
    const messages = [makeMsg({ content: 'Just plain text, no images here.' })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(0);
  });

  it('skips system messages', () => {
    const messages = [makeMsg({ role: 'system', content: '![img](https://example.com/sys.png)' })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(0);
  });

  it('extracts multiple images from multiple messages', () => {
    const messages = [
      makeMsg({ id: 'msg-1', content: '![a](https://example.com/a.png)' }),
      makeMsg({ id: 'msg-2', content: '![b](https://example.com/b.jpg)' }),
    ];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.url)).toEqual([
      'https://example.com/a.png',
      'https://example.com/b.jpg',
    ]);
  });

  it('handles URLs with query parameters', () => {
    const messages = [makeMsg({ content: '![img](https://example.com/img.png?w=100&h=200)' })];
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('https://example.com/img.png?w=100&h=200');
  });

  it('handles various image extensions', () => {
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];
    const messages = extensions.map((ext, i) =>
      makeMsg({ id: `msg-${i}`, content: `![](https://example.com/img.${ext})` }),
    );
    const result = extractImageUrls(messages, conv);
    expect(result).toHaveLength(extensions.length);
  });

  it('preserves message metadata', () => {
    const messages = [
      makeMsg({
        id: 'msg-42',
        content: '![x](https://example.com/x.png)',
        timestamp: '2025-06-15T12:00:00Z',
      }),
    ];
    const result = extractImageUrls(messages, conv);
    expect(result[0].messageId).toBe('msg-42');
    expect(result[0].timestamp).toBe('2025-06-15T12:00:00Z');
  });

  it('extracts inline-code local Hermes image paths and normalizes their src', () => {
    const messages = [
      makeMsg({ content: 'Saved image at `/Users/devgwardo/.hermes/images/foo.png`' }),
    ];

    const result = extractImageUrls(messages, conv);

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('/Users/devgwardo/.hermes/images/foo.png');
    expect(result[0].srcUrl).toBe(assetUrl('/Users/devgwardo/.hermes/images/foo.png'));
  });

  it('extracts bare local tmp image paths from tool-style output', () => {
    const messages = [
      makeMsg({ content: 'Generated:\n/tmp/foo.png\n/tmp/bar.png' }),
    ];

    const result = extractImageUrls(messages, conv);

    expect(result.map((image) => image.srcUrl)).toEqual([
      assetUrl('/tmp/foo.png'),
      assetUrl('/tmp/bar.png'),
    ]);
  });

  it('extracts local image paths from tool-invocation results (banana/run_command)', () => {
    const messages = [
      makeMsg({
        role: 'assistant',
        content: '',
        toolInvocations: [
          {
            toolName: 'run_command',
            state: 'result',
            result: '/Users/devgwardo/.hermes/images/banana-1.png',
          },
        ],
      }),
      makeMsg({
        id: 'msg-2',
        role: 'assistant',
        content: '',
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: {
              toolName: 'run_command',
              state: 'result',
              result: { output: '/Users/devgwardo/.hermes/images/banana-2.png' },
            },
          },
        ],
      }),
    ];

    const result = extractImageUrls(messages, conv);

    expect(result.map((image) => image.url)).toEqual([
      '/Users/devgwardo/.hermes/images/banana-1.png',
      '/Users/devgwardo/.hermes/images/banana-2.png',
    ]);
    expect(result[0].srcUrl).toBe(assetUrl('/Users/devgwardo/.hermes/images/banana-1.png'));
    expect(result[1].srcUrl).toBe(assetUrl('/Users/devgwardo/.hermes/images/banana-2.png'));
  });
});

// --- Component rendering tests ---

vi.mock('@/lib/db', () => ({
  db: {
    conversations: {
      getAll: vi.fn().mockResolvedValue([]),
    },
    messages: {
      getByConversation: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('@/stores/ui-store', () => ({
  useUIStore: vi.fn(() => ({
    setActiveTab: vi.fn(),
    setActiveSubTab: vi.fn(),
  })),
}));

vi.mock('@/stores/panel-store', () => ({
  usePanelStore: vi.fn(() => ({
    focusedPanelId: 'panel-1',
    setConversationForPanel: vi.fn(),
  })),
}));

vi.mock('@/lib/relative-time', () => ({
  relativeTime: () => 'just now',
}));

describe('ImagesPanel component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electronAPI = {
      apiPort: 3001,
      homeDir: '/Users/mockuser',
      platform: 'darwin',
      versions: { electron: '1', node: '1', chrome: '1' },
      openExternal: vi.fn().mockResolvedValue(true),
    };
  });

  it('shows loading state initially', async () => {
    const { ImagesPanel } = await import('@/components/sidebar/ImagesPanel');
    render(<ImagesPanel />);
    expect(screen.getByText('Loading images...')).toBeInTheDocument();
  });

  it('shows empty state when no images found', async () => {
    const { ImagesPanel } = await import('@/components/sidebar/ImagesPanel');
    render(<ImagesPanel />);
    await waitFor(() => {
      expect(screen.getByText(/No images found/)).toBeInTheDocument();
    });
  });

  it('renders image grid when images exist', async () => {
    const { db } = await import('@/lib/db');
    vi.mocked(db.conversations.getAll).mockResolvedValue([
      { id: 'c1', title: 'Chat 1', provider: 'anthropic', model: 'm', systemPrompt: '', createdAt: '', updatedAt: '' },
    ]);
    vi.mocked(db.messages.getByConversation).mockResolvedValue([
      { id: 'm1', conversationId: 'c1', role: 'user', content: '![pic](https://example.com/photo.jpg)', timestamp: '2025-01-01T00:00:00Z' },
    ]);

    const { ImagesPanel } = await import('@/components/sidebar/ImagesPanel');
    render(<ImagesPanel />);

    await waitFor(() => {
      expect(screen.getByText('1 image found')).toBeInTheDocument();
    });
    const img = document.querySelector('img[src="https://example.com/photo.jpg"]');
    expect(img).toBeTruthy();
  });

  it('shows image count', async () => {
    const { db } = await import('@/lib/db');
    vi.mocked(db.conversations.getAll).mockResolvedValue([
      { id: 'c1', title: 'Chat 1', provider: 'anthropic', model: 'm', systemPrompt: '', createdAt: '', updatedAt: '' },
    ]);
    vi.mocked(db.messages.getByConversation).mockResolvedValue([
      { id: 'm1', conversationId: 'c1', role: 'user', content: '![](https://example.com/a.png) ![](https://example.com/b.jpg)', timestamp: '2025-01-01T00:00:00Z' },
    ]);

    const { ImagesPanel } = await import('@/components/sidebar/ImagesPanel');
    render(<ImagesPanel />);

    await waitFor(() => {
      expect(screen.getByText('2 images found')).toBeInTheDocument();
    });
  });

  it('keeps tmp thumbnails unchanged on load error', async () => {
    const { db } = await import('@/lib/db');
    vi.mocked(db.conversations.getAll).mockResolvedValue([
      { id: 'c1', title: 'Chat 1', provider: 'anthropic', model: 'm', systemPrompt: '', createdAt: '', updatedAt: '' },
    ]);
    vi.mocked(db.messages.getByConversation).mockResolvedValue([
      { id: 'm1', conversationId: 'c1', role: 'assistant', content: '`/tmp/foo.png`', timestamp: '2025-01-01T00:00:00Z' },
    ]);

    const { ImagesPanel } = await import('@/components/sidebar/ImagesPanel');
    render(<ImagesPanel />);

    const image = await waitFor(() => {
      const element = document.querySelector(`img[src="${assetUrl('/tmp/foo.png')}"]`);
      expect(element).toBeTruthy();
      return element as HTMLImageElement;
    });

    fireEvent.error(image);

    expect(image).toHaveAttribute('src', assetUrl('/tmp/foo.png'));
  });
});
