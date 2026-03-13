import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActivityIndicator } from '@/components/chat/ActivityIndicator';
import { PanelProvider } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';

describe('ActivityIndicator', () => {
  beforeEach(() => {
    useChangesetStore.setState({ panelChangesets: {} });
  });

  it('shows a multi-file editing label while Hermes is staging several file edits', () => {
    const changesetStore = useChangesetStore.getState();
    changesetStore.addChange('panel-1', {
      path: 'client/src/components/KanbanBoard.tsx',
      action: 'edit',
      content: 'updated board',
      originalContent: 'old board',
      staged: true,
    });
    changesetStore.addChange('panel-1', {
      path: 'client/src/components/BoardCard.tsx',
      action: 'edit',
      content: 'updated card',
      originalContent: 'old card',
      staged: true,
    });

    render(
      <PanelProvider value="panel-1">
        <ActivityIndicator
          isStreaming
          messages={[]}
          toolActivity={[
            {
              tool: 'edit_repo_file',
              status: 'running',
              input: '',
              output: null,
            },
          ]}
        />
      </PanelProvider>,
    );

    expect(screen.getByText('Editing 2 files...')).toBeInTheDocument();
  });
});
