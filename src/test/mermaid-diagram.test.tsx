import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MermaidDiagram } from '@/components/chat/MermaidDiagram';

vi.mock('mermaid', () => {
  return {
    default: {
      initialize: vi.fn(),
      render: vi.fn(async (id: string, source: string) => {
        if (source.includes('INVALID')) {
          throw new Error('Parse error on line 1');
        }
        return { svg: `<svg data-testid="${id}"><g>${source}</g></svg>` };
      }),
    },
  };
});

describe('MermaidDiagram', () => {
  it('renders SVG for a valid flowchart', async () => {
    const source = 'graph TD\nA-->B';
    const { container } = render(<MermaidDiagram source={source} />);

    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
  });

  it('falls back to a code block with an error badge on invalid syntax', async () => {
    const source = 'INVALID mermaid source';
    render(<MermaidDiagram source={source} />);

    await waitFor(() => {
      expect(screen.getByText(/mermaid render error/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Parse error on line 1/)).toBeInTheDocument();
    const codeEl = document.querySelector('pre code');
    expect(codeEl?.textContent).toContain('INVALID mermaid source');
  });
});
