import React, { useEffect, useRef } from 'react';
import { COMMANDS, filterCommands } from '@/lib/hermes-commands';

interface CommandSuggestionsProps {
  query: string;
  visible: boolean;
  onSelect: (command: string) => void;
}

export const CommandSuggestions: React.FC<CommandSuggestionsProps> = ({
  query,
  visible,
  onSelect,
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

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-1 mx-3 z-50 rounded-lg border border-[#3F3F3F] bg-[#2A2A2A] shadow-lg overflow-hidden"
    >
      <div className="py-1 max-h-48 overflow-y-auto">
        {filtered.map((cmd) => (
          <button
            key={cmd.name}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd.name);
            }}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[#363636] transition-colors duration-75"
          >
            <span className="text-xs font-mono text-[#7BA3F7] w-16 shrink-0">
              /{cmd.name}
            </span>
            <span className="text-xs text-[#999999] truncate">
              {cmd.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
