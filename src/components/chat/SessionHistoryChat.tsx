import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeft, Loader2, AlertCircle, RefreshCw, MessageSquare } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useSessionsStore } from '@/stores/sessions-store';
import { getSession, type HermesSessionDetail, type HermesSessionMessage } from '@/lib/hermes-api';
import { cn } from '@/lib/utils';
import { parseToolCalls } from '@/lib/tool-call-parser';
import { ToolCallAccordion } from './ToolCallAccordion';
import { ToolMessageAccordion } from './ToolMessageAccordion';

// Above this length, long non-tool messages are shown as a collapsed accordion
// to prevent walls of text (e.g. giant system prompts).
const LONG_CONTENT_THRESHOLD = 1200;

function renderMessageContent(content: string, role: string) {
  // Only parse tool-call markdown for assistant messages
  if (role !== 'assistant') {
    if (role === 'system' && content.length > LONG_CONTENT_THRESHOLD) {
      return <ToolMessageAccordion content={content} label="SYSTEM PROMPT" tone="violet" />;
    }
    return (
      <p className="text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90">
        {content}
      </p>
    );
  }

  const segments = parseToolCalls(content);

  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return (
            <p
              key={i}
              className="text-[12px] leading-relaxed whitespace-pre-wrap break-words text-foreground/90"
            >
              {seg.content}
            </p>
          );
        }
        return <ToolCallAccordion key={i} segment={seg} />;
      })}
    </div>
  );
}

function roleLabel(role: HermesSessionMessage['role']): string {
  if (role === 'assistant' || role === 'user' || role === 'system' || role === 'tool') return role;
  return 'message';
}

const ROLE_STYLES: Record<string, { border: string; bg: string; label: string }> = {
  user:     { border: 'border-blue-500/30',   bg: 'bg-blue-500/5',    label: 'text-blue-400/60' },
  assistant:{ border: 'border-emerald-500/20', bg: 'bg-emerald-500/5',  label: 'text-emerald-400/60' },
  system:   { border: 'border-violet-500/20', bg: 'bg-violet-500/5',  label: 'text-violet-400/60' },
  tool:     { border: 'border-amber-500/20',  bg: 'bg-amber-500/5',   label: 'text-amber-400/60' },
};

export function SessionHistoryChat() {
  const selectedSessionId = useUIStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useUIStore((s) => s.setSelectedSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const detailRequestRef = useRef(0);

  const [detail, setDetail] = useState<HermesSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = sessions.find((s) => s.id === selectedSessionId);
  const chat = detail?.chat ?? [];

  const loadDetail = useCallback(async (sessionId: string) => {
    const requestId = ++detailRequestRef.current;
    setLoading(true);
    try {
      const result = await getSession(sessionId);
      if (requestId !== detailRequestRef.current) return;
      setDetail(result);
      setError(null);
    } catch (err) {
      if (requestId !== detailRequestRef.current) return;
      setDetail(null);
      setError(err instanceof Error ? err.message : 'Failed to fetch session detail');
    } finally {
      if (requestId === detailRequestRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      detailRequestRef.current += 1;
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    void loadDetail(selectedSessionId);
  }, [loadDetail, selectedSessionId]);

  // Auto-scroll to bottom on new data
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.length]);

  if (!selectedSessionId) return null;

  const handleRefresh = () => {
    void loadDetail(selectedSessionId);
  };

  const title = session?.firstUserMessage?.trim().length
    ? session.firstUserMessage.trim()
    : `Session ${selectedSessionId.slice(0, 8)}`;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 bg-background/80 backdrop-blur-sm">
        <button
          onClick={() => setSelectedSessionId(null)}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="Back to chat"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-medium truncate">{title}</h2>
            {detail?.status && (
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                detail.status === 'active' ? 'bg-blue-500/10 text-blue-400' :
                detail.status === 'error' ? 'bg-red-500/10 text-red-400' :
                'bg-muted text-muted-foreground'
              )}>
                {detail.status}
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
            {selectedSessionId.slice(0, 12)}
            {detail?.model ? ` · ${detail.model}` : ''}
            {detail?.repo ? ` · ${detail.repo}` : ''}
            {detail?.source ? ` · ${detail.source}` : ''}
          </p>
        </div>
        <button
          onClick={handleRefresh}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Chat messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-2">
        {loading && chat.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/50" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
            <span className="text-[12px] text-red-400">{error}</span>
          </div>
        ) : chat.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <MessageSquare className="h-8 w-8 text-muted-foreground/20 mb-3" />
            <p className="text-[13px] text-muted-foreground/50">No messages</p>
            <p className="text-[11px] text-muted-foreground/30 mt-1">
              This session has no recorded chat messages
            </p>
          </div>
        ) : (
          chat
            .filter((msg) => typeof msg.content === 'string' && msg.content.trim().length > 0)
            .map((msg, index) => {
              const key = `${selectedSessionId}-${index}-${msg.role}`;

              // Tool results render as a standalone accordion — no outer role wrapper,
              // since the accordion itself carries the tool affordance.
              if (msg.role === 'tool') {
                return <ToolMessageAccordion key={key} content={msg.content} label="TOOL RESULT" tone="amber" />;
              }

              const style = ROLE_STYLES[msg.role] ?? { border: 'border-border/30', bg: 'bg-background/50', label: 'text-muted-foreground/60' };
              return (
                <div
                  key={key}
                  className={cn(
                    'rounded-lg border-l-2 border-r border-t border-b px-4 py-3',
                    style.border,
                    style.bg,
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cn('text-[9px] uppercase tracking-widest font-medium', style.label)}>
                      {roleLabel(msg.role)}
                    </span>
                  </div>
                  {renderMessageContent(msg.content, msg.role)}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
