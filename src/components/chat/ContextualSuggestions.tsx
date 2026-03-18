import React, { useRef, useState, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { generateSuggestions, type ContextualSuggestion } from '@/lib/contextual-suggestions';
import { useChangesetStore } from '@/stores/changeset-store';
import { useChatScopeId } from '@/contexts/PanelContext';

interface ContextualSuggestionsProps {
  messages: { role: string; content: string }[];
  isStreaming: boolean;
  onSend: (prompt: string) => void;
}

export const ContextualSuggestions: React.FC<ContextualSuggestionsProps> = ({
  messages,
  isStreaming,
  onSend,
}) => {
  const scopeId = useChatScopeId();
  const { getChangeset, getChangeCount } = useChangesetStore();
  const { isRepoMode } = getChangeset(scopeId);
  const changeCount = getChangeCount(scopeId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [suggestions, setSuggestions] = useState<ContextualSuggestion[]>([]);
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Find the last assistant and user messages
  const lastAssistant = messages.findLast((m) => m.role === 'assistant');
  const lastUser = messages.findLast((m) => m.role === 'user');

  // Generate suggestions when streaming stops
  useEffect(() => {
    if (isStreaming) {
      setVisible(false);
      setDismissed(false);
      return;
    }

    if (dismissed || messages.length < 2 || !lastAssistant) {
      setVisible(false);
      return;
    }

    const result = generateSuggestions({
      lastAssistantContent: lastAssistant?.content || '',
      lastUserContent: lastUser?.content || '',
      hasRepo: isRepoMode,
      hasChanges: changeCount > 0,
      messageCount: messages.length,
    });

    setSuggestions(result);

    // Delay appearance slightly for a smooth entrance after response
    const timer = setTimeout(() => {
      setVisible(result.length > 0);
    }, 300);
    return () => clearTimeout(timer);
  }, [isStreaming, messages.length, lastAssistant?.content, lastUser?.content, isRepoMode, changeCount, dismissed]);

  // Track scroll state for arrow indicators
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    updateScrollState();
  }, [suggestions, visible, updateScrollState]);

  const scroll = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction === 'left' ? -200 : 200, behavior: 'smooth' });
  };

  const handleClick = (suggestion: ContextualSuggestion) => {
    setDismissed(true);
    setVisible(false);
    onSend(suggestion.prompt);
  };

  if (!visible || suggestions.length === 0) return null;

  return (
    <div className="w-full max-w-[720px] mx-auto px-20 animate-fadeInUp">
      <div className="relative group">
        {/* Left scroll arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 h-7 w-7 flex items-center justify-center rounded-full bg-background/90 border border-border/60 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-foreground opacity-0 group-hover:opacity-100"
            aria-label="Scroll suggestions left"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Scrollable container */}
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          className="flex gap-2 overflow-x-auto scrollbar-none pb-1 pt-0.5 px-0.5"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              onClick={() => handleClick(suggestion)}
              className={cn(
                'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
                'border border-[#3F3F3F] bg-[#1E1E1E]',
                'text-[12px] text-[#8A8A8A] font-medium whitespace-nowrap',
                'hover:border-primary/30 hover:bg-[#252525] hover:text-foreground',
                'transition-all duration-150',
              )}
            >
              {suggestion.label}
            </button>
          ))}
        </div>

        {/* Right scroll arrow */}
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 h-7 w-7 flex items-center justify-center rounded-full bg-background/90 border border-border/60 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-foreground opacity-0 group-hover:opacity-100"
            aria-label="Scroll suggestions right"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
