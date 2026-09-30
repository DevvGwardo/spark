import { useMemo, useRef, useState } from 'react';
import { Search, Loader2, CornerDownLeft } from 'lucide-react';
import { useConversationSearch } from '@/hooks/useConversationSearch';
import { useChatStore } from '@/stores/chat-store';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import type { SearchResult } from '@/lib/db';

interface ConversationSearchBarProps {
  className?: string;
  /** Called when the user picks a result from the dropdown. */
  onSelect?: (result: SearchResult) => void;
}

/**
 * Full-text search over all conversations' messages. Debounced input with a
 * results dropdown (conversation title + snippet + relative time). Fully
 * self-contained apart from the optional `onSelect` callback; `className` is
 * applied to the wrapping relative container so it fits any sidebar/composer
 * layout without further integration.
 */
export const ConversationSearchBar: React.FC<ConversationSearchBarProps> = ({ className, onSelect }) => {
  const { query, setQuery, results, loading, error } = useConversationSearch();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const conversations = useChatStore((state) => state.conversations);
  const archivedConversations = useChatStore((state) => state.archivedConversations);

  const titlesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const conv of [...conversations, ...archivedConversations]) {
      if (!map.has(conv.id)) map.set(conv.id, conv.title);
    }
    return map;
  }, [conversations, archivedConversations]);

  const showDropdown = open && query.trim().length > 0;

  const handleSelect = (result: SearchResult) => {
    setOpen(false);
    onSelect?.(result);
  };

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          aria-expanded={showDropdown}
          className="h-8 w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]/70 pl-8 pr-3 text-[12px] text-foreground placeholder:text-muted-foreground/50 transition-colors duration-100 focus:border-[hsl(var(--ring))] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </div>

      {showDropdown && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] shadow-xl">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Searching…
            </div>
          ) : error ? (
            <p className="px-3 py-2.5 text-[11px] text-red-400/90">Search failed: {error}</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2.5 text-[11px] text-muted-foreground/70">No matches for “{query.trim()}”</p>
          ) : (
            <ul className="max-h-[300px] overflow-y-auto py-1">
              {results.map((result) => (
                <li key={result.messageId}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // Fire before the input's blur so the dropdown stays mounted.
                      e.preventDefault();
                      handleSelect(result);
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-100 hover:bg-[hsl(var(--sidebar-active))]/50"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[hsl(var(--text-primary))]">
                        {titlesById.get(result.conversationId) ?? 'Untitled conversation'}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide',
                          result.role === 'user'
                            ? 'bg-emerald-500/10 text-emerald-400/90'
                            : 'bg-primary/10 text-primary/80',
                        )}
                      >
                        {result.role}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
                        {relativeTime(result.timestamp)}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
                      {result.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && !error && results.length > 0 && (
            <div className="flex items-center gap-1.5 border-t border-[hsl(var(--border))] bg-[hsl(var(--muted))]/20 px-3 py-1.5 text-[10px] text-muted-foreground/60">
              <CornerDownLeft className="h-2.5 w-2.5" aria-hidden="true" />
              Enter to open the conversation
            </div>
          )}
        </div>
      )}
    </div>
  );
};
