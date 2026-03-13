import React, { useState, useEffect, useMemo } from 'react';
import { GhostIcon } from './GhostIcon';
import { usePanelId } from '@/contexts/PanelContext';
import { useChangesetStore } from '@/stores/changeset-store';
import type { ToolActivityEvent } from './AgentActivity';

type Activity = 'thinking' | 'reading' | 'editing' | 'planning' | 'writing';

const PHRASES: Record<Activity, string[]> = {
  thinking: [
    'Thinking...',
    'Pondering...',
    'Mulling it over...',
    'Combobulating...',
    'Noodling on it...',
    'Connecting the dots...',
    'Brewing ideas...',
    'Cogitating...',
    'Percolating...',
    'Assembling thoughts...',
  ],
  reading: [
    'Reading file...',
    'Scanning code...',
    'Parsing contents...',
    'Studying the source...',
    'Absorbing context...',
    'Inspecting the codebase...',
    'Peeking at the code...',
    'Deciphering...',
  ],
  editing: [
    'Editing file...',
    'Applying changes...',
    'Rewriting code...',
    'Staging edits...',
    'Sculpting code...',
    'Tinkering...',
    'Refactoring...',
    'Patching things up...',
    'Wiring it together...',
  ],
  planning: [
    'Planning changes...',
    'Drafting a plan...',
    'Mapping it out...',
    'Strategizing...',
    'Sketching the approach...',
    'Charting the course...',
  ],
  writing: [
    'Writing...',
    'Composing...',
    'Crafting a response...',
    'Putting pen to paper...',
    'Stringing words together...',
    'Articulating...',
  ],
};

interface ActivityIndicatorProps {
  isStreaming: boolean;
  messages: Array<{
    role: string;
    parts?: Array<{
      type?: string;
      toolInvocation?: {
        toolName?: string;
      };
    }>;
    toolInvocations?: Array<{
      toolName?: string;
    }>;
  }>;
  toolActivity?: ToolActivityEvent[];
}

function parseToolActivityInput(input: string): Record<string, unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function deriveActivity(messages: ActivityIndicatorProps['messages'], toolActivity?: ToolActivityEvent[]): Activity {
  const latestToolActivity = [...(toolActivity || [])].reverse().find((event) => event.status === 'running') ??
    [...(toolActivity || [])].at(-1);

  if (latestToolActivity) {
    const name = latestToolActivity.tool || '';
    if (name === 'read_repo_file') return 'reading';
    if (name === 'propose_changes') return 'planning';
    if (['edit_repo_file', 'create_repo_file', 'delete_repo_file', 'batch_edit_repo_files'].includes(name)) return 'editing';
    if (['create_html_file', 'create_css_file', 'create_js_file', 'create_react_component'].includes(name)) return 'writing';
  }

  // Look at the last assistant message's tool invocations
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;

    const toolInvocations =
      (msg.parts?.filter((p) => p.type === 'tool-invocation').map((p) => p.toolInvocation)) ||
      msg.toolInvocations ||
      [];

    if (toolInvocations.length === 0) break;

    // Check the last tool invocation
    const last = toolInvocations[toolInvocations.length - 1];
    const name = last?.toolName || '';

    if (name === 'read_repo_file') return 'reading';
    if (name === 'propose_changes') return 'planning';
    if (['edit_repo_file', 'create_repo_file', 'delete_repo_file', 'batch_edit_repo_files'].includes(name)) return 'editing';
    if (['create_html_file', 'create_css_file', 'create_js_file', 'create_react_component'].includes(name)) return 'writing';

    break;
  }

  return 'thinking';
}

function deriveEditingPhrase(toolActivity: ToolActivityEvent[] | undefined, stagedCount: number): string | null {
  const latestToolActivity = [...(toolActivity || [])].reverse().find((event) => event.status === 'running') ??
    [...(toolActivity || [])].at(-1);

  if (latestToolActivity?.tool === 'batch_edit_repo_files') {
    const parsed = parseToolActivityInput(latestToolActivity.input);
    const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
    if (changes.length > 1) {
      return `Editing ${changes.length} files...`;
    }
  }

  if (stagedCount > 1) {
    return `Editing ${stagedCount} files...`;
  }

  if (stagedCount === 1) {
    return 'Editing 1 file...';
  }

  return null;
}

export const ActivityIndicator: React.FC<ActivityIndicatorProps> = ({ isStreaming, messages, toolActivity }) => {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const panelId = usePanelId();
  const stagedCount = useChangesetStore((state) => state.getStagedCount(panelId));

  const activity = useMemo(
    () => (isStreaming ? deriveActivity(messages, toolActivity) : 'thinking'),
    [isStreaming, messages, toolActivity],
  );
  const phrases = PHRASES[activity];
  const editingPhrase = useMemo(
    () => (activity === 'editing' ? deriveEditingPhrase(toolActivity, stagedCount) : null),
    [activity, stagedCount, toolActivity],
  );

  // Rotate phrases every 3 seconds
  useEffect(() => {
    if (!isStreaming) {
      setPhraseIndex(0);
      return;
    }
    // Pick a random starting index
    setPhraseIndex(Math.floor(Math.random() * phrases.length));
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isStreaming, phrases]);

  if (!isStreaming) return null;

  const phrase = editingPhrase || phrases[phraseIndex % phrases.length];

  return (
    <div className="flex items-center justify-center gap-2 py-1.5 text-xs text-muted-foreground animate-in fade-in duration-300">
      <GhostIcon size={12} />
      <span className="transition-opacity duration-500">{phrase}</span>
    </div>
  );
};
