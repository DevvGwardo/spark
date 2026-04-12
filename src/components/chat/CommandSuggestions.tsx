import React, { useEffect, useRef } from 'react';
import { filterCommands } from '@/lib/hermes-commands';
import { cn } from '@/lib/utils';

interface CommandSuggestionsProps {
  query: string;
  visible: boolean;
  selectedIndex: number;
  onSelect: (command: string) => void;
  onSelectIndex: (index: number) => void;
}

// True if the command's usage includes <arg> markers, meaning it needs user input
export function commandTakesArgs(cmd: { usage: string }): boolean {
  return cmd.usage.includes('<');
}

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  query,
  visible,
  selectedIndex,
  onSelect,
  onSelectIndex,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = filterCommands(query);

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

  // Reset selection when list changes
  useEffect(() => {
    onSelectIndex(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 z-50 rounded-lg border border-[#3F3F3F] bg-[#2A2A2A] shadow-lg overflow-hidden"
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-[#3F3F3F] flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#666666]">
          Commands
        </span>
        <span className="text-[10px] text-[#555555]">↑↓ navigate · Enter run</span>
      </div>

      {/* Command list */}
      <div className="py-1 max-h-48 overflow-y-auto">
        {filtered.map((cmd, i) => {
          const takesArgs = commandTakesArgs(cmd);
          return (
            <button
              key={cmd.name}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(cmd.name);
              }}
              onMouseEnter={() => onSelectIndex(i)}
              className={cn(
                'w-full text-left px-3 py-1.5 flex flex-col gap-0.5 transition-colors duration-75',
                i === selectedIndex
                  ? 'bg-[#3B6DB5]'
                  : 'hover:bg-[#363636]'
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-xs font-mono w-16 shrink-0',
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
                {takesArgs && (
                  <span className="ml-auto shrink-0 text-[10px] text-[#555555] italic">
                    needs args
                  </span>
                )}
              </div>
              {/* Usage hint — shows what args are expected */}
              <span
                className={cn(
                  'text-[10px] pl-[4.5rem] truncate',
                  i === selectedIndex ? 'text-white/40' : 'text-[#555555]'
                )}
              >
                {cmd.usage}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
