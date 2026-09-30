import React, { useEffect, useRef } from 'react';
import { File, Folder, GitCompare, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTokenCount } from '@/lib/tokens';
import {
  type ContextRefKind,
  type ContextRefQuery,
} from '@/lib/context-refs';

const KIND_ICON: Record<ContextRefKind, React.ReactNode> = {
  file: <File className="h-3 w-3 shrink-0" />,
  folder: <Folder className="h-3 w-3 shrink-0" />,
  diff: <GitCompare className="h-3 w-3 shrink-0" />,
  url: <Link2 className="h-3 w-3 shrink-0" />,
};

import type { ContextRefSuggestion } from '@/lib/context-refs';

interface ContextRefSuggestionsProps {
  query: ContextRefQuery;
  suggestions: ContextRefSuggestion[];
  visible: boolean;
  selectedIndex: number;
  tokenEstimate?: number;
  listboxId?: string;
  onSelect: (insert: string) => void;
  onSelectIndex: (index: number) => void;
  onDismiss: () => void;
}

export const ContextRefSuggestions: React.FC<ContextRefSuggestionsProps> = ({
  query,
  suggestions,
  visible,
  selectedIndex,
  tokenEstimate,
  listboxId,
  onSelect,
  onSelectIndex,
  onDismiss,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [visible, onDismiss]);

  useEffect(() => {
    onSelectIndex(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.kind, query.query, suggestions.length]);

  if (!visible || suggestions.length === 0) return null;

  const header =
    query.kind === 'picker'
      ? 'Context references'
      : query.kind === 'file'
        ? 'Files'
        : query.kind === 'folder'
          ? 'Folders'
          : query.kind === 'url'
            ? 'URLs'
            : 'Context';

  return (
    <div
      ref={containerRef}
      id={listboxId}
      role="listbox"
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 z-50 rounded-lg border border-[#3F3F3F] bg-[#2A2A2A] shadow-lg overflow-hidden"
    >
      <div className="px-3 py-1.5 border-b border-[#3F3F3F] flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
          {header}
        </span>
        <span className="text-[10px] text-[#9CA3AF] tabular-nums">
          {tokenEstimate ? `~${formatTokenCount(tokenEstimate)} tok` : '↑↓ · ↵'}
        </span>
      </div>
      <div className="py-1 max-h-44 overflow-y-auto">
        {suggestions.map((item, i) => {
          const kind = item.kind ?? query.kind;
          const icon = kind !== 'picker' && kind in KIND_ICON ? KIND_ICON[kind as ContextRefKind] : null;
          return (
            <button
              key={`${item.insert}-${i}`}
              type="button"
              role="option"
              id={`${listboxId}-opt-${i}`}
              aria-selected={i === selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.insert);
              }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors duration-100',
                i === selectedIndex ? 'bg-[#333333]' : 'hover:bg-[#333333]/60',
              )}
            >
              {icon}
              <span className="font-mono text-foreground truncate">{item.label}</span>
              {item.hint && (
                <span className="ml-auto text-[10px] text-[#9CA3AF] truncate max-w-[45%]">{item.hint}</span>
              )}
            </button>
          );
        })}
      </div>
      {query.kind === 'picker' && (
        <div className="px-3 py-1 border-t border-[#3F3F3F] text-[10px] text-[#9CA3AF]">
          Prefix required — won&apos;t collide with room @mentions
        </div>
      )}
    </div>
  );
};

