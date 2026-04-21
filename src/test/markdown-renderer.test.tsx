import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

describe('MarkdownRenderer', () => {
  beforeEach(() => {
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
    expect(image).toHaveAttribute('src', 'file:///tmp/foo.png');
  });
});
