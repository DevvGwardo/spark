'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getToolIcon, type ToolCallSegment } from '@/lib/tool-call-parser';

interface ToolCallAccordionProps {
  segment: ToolCallSegment;
  /** Override the icon component. Defaults to getToolIcon(segment.toolName). */
  icon?: React.ElementType;
  /** Additional class on the outer container. */
  className?: string;
  /** Children rendered in the expanded body. Defaults to startLine + endLine. */
  children?: React.ReactNode;
}

export function ToolCallAccordion({
  segment,
  icon: IconProp,
  className,
  children,
}: ToolCallAccordionProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = IconProp ?? getToolIcon(segment.toolName);

  const resultText = segment.endLine
    ? segment.endLine.replace(/^>\s*\*/, '').replace(/\*$/, '').trim()
    : null;

  const body = children ?? (
    <>
      {segment.startLine && (
        <p className="text-[11px] text-foreground/70 whitespace-pre-wrap break-words">
          {segment.startLine}
        </p>
      )}
      {segment.endLine && (
        <p className="text-[11px] text-foreground/70 whitespace-pre-wrap break-words">
          {segment.endLine}
        </p>
      )}
    </>
  );

  return (
    <div className={cn('rounded-md border border-border/50 bg-muted/20 my-1 overflow-hidden transition-colors duration-150', className)}>
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-muted/40 transition-colors duration-150 rounded-md"
      >
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-150 flex-shrink-0',
            expanded ? 'rotate-0' : '-rotate-90'
          )}
        />
        <Icon className="h-3.5 w-3.5 text-muted-foreground/60 flex-shrink-0" />
        <span className="text-[11px] font-medium text-muted-foreground truncate min-w-0">
          {segment.toolName}
        </span>
        {segment.summary && (
          <span className="text-[11px] text-muted-foreground/60 truncate min-w-0" title={segment.summary}>
            — {segment.summary}
          </span>
        )}
        {resultText && (
          <span className="text-[10px] text-muted-foreground/40 ml-auto flex-shrink-0 font-mono">
            {resultText}
          </span>
        )}
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-150 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-3 pb-2 pt-0.5 space-y-1">{body}</div>
        </div>
      </div>
    </div>
  );
}
