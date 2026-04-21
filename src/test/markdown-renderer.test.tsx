import React from 'react';
import os from 'node:os';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

function assetUrl(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (path.startsWith('/tmp/')) {
    return `cloudchat-asset://tmp/${encodeURIComponent(basename)}`;
  }
  return `cloudchat-asset://hermes/${encodeURIComponent(basename)}`;
}

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    window.electronAPI = undefined;
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders fenced code blocks with the chat-style copy button shell', async () => {
    render(
      <MarkdownRenderer
        content={`\`\`\`ts
import { useState } from 'react';
const value = 1;
\`\`\``}
      />,
    );

    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByText('2 lines')).toBeInTheDocument();

    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    expect(copyButton.tagName).toBe('BUTTON');

    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "import { useState } from 'react';\nconst value = 1;",
      );
    });
  });

  it('collapses long fenced code blocks behind a show more affordance', async () => {
    const lines = Array.from({ length: 40 }, (_, index) => `const line${index} = ${index};`).join('\n');
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');

    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 480;
      },
    });

    try {
      render(
        <MarkdownRenderer
          content={`\`\`\`ts
${lines}
\`\`\``}
        />,
      );

      expect(screen.getByText('40 lines')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /show more/i }));

      expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument();
    } finally {
      if (scrollHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      }
    }
  });

  it('renders MEDIA-prefixed local image paths as images', () => {
    render(<MarkdownRenderer content={'MEDIA:/tmp/foo.png'} />);

    const image = screen.getByRole('img', { name: '/tmp/foo.png' });
    expect(image).toHaveAttribute('src', assetUrl('/tmp/foo.png'));
  });

  it('renders bare local image paths as images', () => {
    render(<MarkdownRenderer content={'/tmp/foo.png'} />);

    const image = screen.getByRole('img', { name: '/tmp/foo.png' });
    expect(image).toHaveAttribute('src', assetUrl('/tmp/foo.png'));
  });

  it('renders bare Hermes image path lines as images', () => {
    render(
      <MarkdownRenderer
        content={[
          '/Users/devgwardo/.hermes/images/bar-agents.png',
          '/Users/devgwardo/.hermes/images/foo-agents.png',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('img', { name: '/Users/devgwardo/.hermes/images/bar-agents.png' }))
      .toHaveAttribute('src', assetUrl('/Users/devgwardo/.hermes/images/bar-agents.png'));
    expect(screen.getByRole('img', { name: '/Users/devgwardo/.hermes/images/foo-agents.png' }))
      .toHaveAttribute('src', assetUrl('/Users/devgwardo/.hermes/images/foo-agents.png'));
  });

  it('falls back from /tmp image path to ~/.hermes/images on load error', () => {
    const fallbackHomeDir = '/Users/mockuser';
    const openExternal = vi.fn().mockResolvedValue(true);
    window.electronAPI = {
      apiPort: 3001,
      homeDir: fallbackHomeDir,
      platform: 'darwin',
      versions: { electron: '1', node: '1', chrome: '1' },
      openExternal,
    };

    render(<MarkdownRenderer content={'/tmp/foo.png'} />);

    const image = screen.getByRole('img', { name: '/tmp/foo.png' });
    fireEvent.error(image);
    fireEvent.click(image);

    expect(image).toHaveAttribute('src', assetUrl('/Users/mockuser/.hermes/images/foo.png'));
    expect(openExternal).toHaveBeenCalledWith('file:///Users/mockuser/.hermes/images/foo.png');
  });

  it('opens local images via file URLs when clicked', () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    window.electronAPI = {
      apiPort: 3001,
      homeDir: '/MOCKED_HOME',
      platform: 'darwin',
      versions: { electron: '1', node: '1', chrome: '1' },
      openExternal,
    };

    render(<MarkdownRenderer content={'/tmp/foo.png'} />);

    fireEvent.click(screen.getByRole('img', { name: '/tmp/foo.png' }));

    expect(openExternal).toHaveBeenCalledWith('file:///tmp/foo.png');
  });

  it('expands ~/ image paths using the active home directory', () => {
    const homeDir = os.homedir();
    window.history.replaceState({}, '', `${homeDir}/chat`);

    render(<MarkdownRenderer content={'~/Desktop/foo.png'} />);

    const image = screen.getByRole('img', { name: '~/Desktop/foo.png' });
    expect(image).toHaveAttribute('src', `file://${homeDir}/Desktop/foo.png`);
  });

  it('keeps trailing punctuation outside local image paths', () => {
    render(<MarkdownRenderer content={'see /tmp/foo.png.\n(check /tmp/bar.png)'} />);

    expect(screen.getByRole('img', { name: '/tmp/foo.png' })).toHaveAttribute('src', assetUrl('/tmp/foo.png'));
    expect(screen.getByRole('img', { name: '/tmp/bar.png' })).toHaveAttribute('src', assetUrl('/tmp/bar.png'));
  });
});
