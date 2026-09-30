import React, { useEffect, useRef, useMemo } from 'react';
import { describeCommandExecution, filterCommands, commandTakesArgs } from '@/lib/hermes-commands';
import { cn } from '@/lib/utils';

interface CommandSuggestionsProps {
  query: string;
  visible: boolean;
  selectedIndex: number;
  listboxId?: string;
  onSelect: (command: string) => void;
  onSelectIndex: (index: number) => void;
}

const KIND_BADGE: Record<string, { label: string; className: string }> = {
  local: { label: 'local', className: 'text-zinc-300/90 bg-zinc-500/10 border-zinc-500/20' },
  skill: { label: 'skill', className: 'text-emerald-300/80 bg-emerald-500/10 border-emerald-500/20' },
  forwarded: { label: 'forwarded', className: 'text-sky-300/80 bg-sky-500/10 border-sky-500/20' },
};

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  query,
  visible,
  selectedIndex,
  listboxId,
  onSelect,
  onSelectIndex,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterCommands(query), [query]);

  useEffect(() => {
    if (!visible) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onSelect('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [visible, onSelect]);

  useEffect(() => {
    onSelectIndex(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      ref={containerRef}
      id={listboxId}
      role="listbox"
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 z-50 rounded-lg border border-[#3F3F3F] bg-[#2A2A2A] shadow-lg overflow-hidden"
    >
      <div className="px-3 py-1.5 border-b border-[#3F3F3F] flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
          Commands
        </span>
        <span className="text-[10px] text-[#9CA3AF]">↑↓ navigate · ↵ select</span>
      </div>

      <div className="py-1 max-h-56 overflow-y-auto">
        {filtered.map((cmd, i) => {
          const takesArgs = commandTakesArgs(cmd);
          const badge = KIND_BADGE[cmd.kind];
          return (
            <button
              key={cmd.name}
              role="option"
              id={`${listboxId}-opt-${i}`}
              aria-selected={i === selectedIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(cmd.name);
              }}
              onMouseEnter={() => onSelectIndex(i)}
              className={cn(
                'w-full text-left px-3 py-2 flex flex-col gap-1 transition-colors duration-75',
                i === selectedIndex
                  ? 'bg-[#3B6DB5]'
                  : 'hover:bg-[#363636]'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-xs font-mono w-20 shrink-0',
                    i === selectedIndex ? 'text-white' : 'text-[#7BA3F7]'
                  )}
                >
                  /{cmd.name}
                </span>
                <span
                  className={cn(
                    'text-xs truncate',
                    i === selectedIndex ? 'text-white/80' : 'text-[#999999]'
                  )}
                >
                  {cmd.description}
                </span>
                <span className="ml-auto shrink-0 flex items-center gap-1.5">
                  {takesArgs && (
                    <span className="text-[10px] text-[#9CA3AF] italic">needs args</span>
                  )}
                  <span
                    className={cn(
                      'text-[9px] font-medium uppercase tracking-wide px-1 py-px rounded border',
                      badge.className
                    )}
                  >
                    {badge.label}
                  </span>
                </span>
              </div>
              <span
                className={cn(
                  'text-[10px] pl-20 truncate',
                  i === selectedIndex ? 'text-white/90' : 'text-[#9CA3AF]'
                )}
              >
                {cmd.usage}
              </span>
              <span
                className={cn(
                  'text-[10px] pl-20',
                  i === selectedIndex ? 'text-white/90' : 'text-[#9CA3AF]'
                )}
              >
                {describeCommandExecution(cmd)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
