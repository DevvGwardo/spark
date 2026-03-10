import React, { useState, useEffect, useMemo } from 'react';
import { GhostIcon } from './GhostIcon';

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
}

function deriveActivity(messages: ActivityIndicatorProps['messages']): Activity {
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

export const ActivityIndicator: React.FC<ActivityIndicatorProps> = ({ isStreaming, messages }) => {
  const [phraseIndex, setPhraseIndex] = useState(0);

  const activity = useMemo(() => (isStreaming ? deriveActivity(messages) : 'thinking'), [isStreaming, messages]);
  const phrases = PHRASES[activity];

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

  const phrase = phrases[phraseIndex % phrases.length];

  return (
    <div className="flex items-center justify-center gap-2 py-1.5 text-xs text-muted-foreground animate-in fade-in duration-300">
      <GhostIcon size={12} />
      <span className="transition-opacity duration-500">{phrase}</span>
    </div>
  );
};
