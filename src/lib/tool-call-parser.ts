// Shared tool call parsing utilities for SessionHistoryChat and CronHistoryChat.

import React from 'react';
import { Wrench, FileSearch, FileCode, FilePlus, FileX } from 'lucide-react';

// --- Icon map ---

export const TOOL_ICON_MAP: Record<string, React.ElementType> = {
  'Reading file': FileSearch,
  'Editing file': FileCode,
  'Creating file': FilePlus,
  'Deleting file': FileX,
  'Running command': Wrench,
  'Running Python': Wrench,
  'Searching web': FileSearch,
  'Searching': FileSearch,
  'Reading webpage': FileSearch,
  'Browsing': FileSearch,
  'Writing file': FilePlus,
};

export function getToolIcon(toolName: string): React.ElementType {
  return TOOL_ICON_MAP[toolName] || Wrench;
}

// --- Types ---

export interface ToolCallSegment {
  type: 'tool';
  toolName: string;
  summary: string;
  startLine: string;
  endLine: string | null;
}

export interface TextSegment {
  type: 'text';
  content: string;
}

export type Segment = ToolCallSegment | TextSegment;

// --- Regexes ---

// Matches: > **ToolName** — summary
//         > **ToolName**
export const TOOL_START_RE = /^>\s*\*\*(.+?)\*\*(?:\s*—\s*(.*))?$/;

// Matches: > *Done — ...*
//         > *Failed:* `...`
//         > *Found N results*
//         > *Fetched ...*
export const TOOL_END_RE = /^>\s*\*(?:Done|Failed|Found|Fetched)\b.*\*(?:\s*`.+`)?$/;

// --- Parser ---

export function parseToolCalls(content: string): Segment[] {
  const lines = content.split('\n');
  const segments: Segment[] = [];
  let textBuf: string[] = [];

  function flushText() {
    if (textBuf.length > 0) {
      const text = textBuf.join('\n');
      if (text.trim().length > 0) {
        segments.push({ type: 'text', content: text });
      }
      textBuf = [];
    }
  }

  let pendingTool: ToolCallSegment | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startMatch = line.match(TOOL_START_RE);
    const endMatch = line.match(TOOL_END_RE);

    if (startMatch) {
      if (pendingTool) {
        segments.push(pendingTool);
        pendingTool = null;
      }
      flushText();
      const toolName = startMatch[1].trim();
      const summary = (startMatch[2] || '').trim();
      pendingTool = {
        type: 'tool',
        toolName,
        summary,
        startLine: line,
        endLine: null,
      };
    } else if (endMatch && pendingTool) {
      pendingTool.endLine = line;
      segments.push(pendingTool);
      pendingTool = null;
    } else {
      // Skip blank lines and lines starting with > that are inside a pending tool block.
      // Finalize the tool only when we hit a truly non-tool line.
      if (pendingTool) {
        if (line.trim() === '' || line.startsWith('>')) {
          continue;
        }
        segments.push(pendingTool);
        pendingTool = null;
      }
      textBuf.push(line);
    }
  }

  if (pendingTool) {
    segments.push(pendingTool);
  }

  flushText();
  return segments;
}
