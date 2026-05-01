import React, { useMemo, useState } from 'react';
import { ChevronRight, Wrench, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ToolMessageAccordionProps {
  content: string;
  /** Force expanded state (ignores user toggle). */
  defaultExpanded?: boolean;
  /** Optional label shown before the preview (e.g. "SYSTEM"). */
  label?: string;
  /** Tint palette — defaults to amber (tool). */
  tone?: 'amber' | 'violet' | 'muted';
}

const TONE_CLASSES: Record<NonNullable<ToolMessageAccordionProps['tone']>, {
  border: string;
  bg: string;
  hoverBg: string;
  icon: string;
  label: string;
  pill: string;
}> = {
  amber: {
    border: 'border-amber-500/20',
    bg: 'bg-amber-500/5',
    hoverBg: 'hover:bg-amber-500/10',
    icon: 'text-amber-500/70',
    label: 'text-amber-600/80 dark:text-amber-400/80',
    pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  violet: {
    border: 'border-violet-500/20',
    bg: 'bg-violet-500/5',
    hoverBg: 'hover:bg-violet-500/10',
    icon: 'text-violet-400/70',
    label: 'text-violet-500 dark:text-violet-400',
    pill: 'bg-violet-500/15 text-violet-500 dark:text-violet-400',
  },
  muted: {
    border: 'border-border/40',
    bg: 'bg-background/40',
    hoverBg: 'hover:bg-background/60',
    icon: 'text-muted-foreground/70',
    label: 'text-foreground/80',
    pill: 'bg-muted-foreground/15 text-muted-foreground',
  },
};

function detectFormat(content: string): 'json' | 'xml' | 'text' {
  const trimmed = content.trim();
  if (!trimmed) return 'text';
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) return 'json';
  if (first === '<' && trimmed.includes('>')) return 'xml';
  return 'text';
}

function tryPrettyJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function buildPreview(content: string, format: 'json' | 'xml' | 'text'): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (format === 'xml') {
    // Collect unique top-level tag names for a quick overview
    const tagMatches = Array.from(cleaned.matchAll(/<([A-Za-z_][\w-]*)/g))
      .slice(0, 8)
      .map((m) => m[1]);
    const uniq = Array.from(new Set(tagMatches));
    if (uniq.length) return `<${uniq.join('>, <')}>…`;
  }
  if (cleaned.length <= 140) return cleaned;
  return cleaned.slice(0, 140) + '…';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} chars`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ToolMessageAccordion({
  content,
  defaultExpanded = false,
  label = 'TOOL RESULT',
  tone = 'amber',
}: ToolMessageAccordionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const format = useMemo(() => detectFormat(content), [content]);
  const prettyJson = useMemo(() => (format === 'json' ? tryPrettyJson(content) : null), [content, format]);
  const displayContent = prettyJson ?? content;
  const preview = useMemo(() => buildPreview(content, format), [content, format]);
  const palette = TONE_CLASSES[tone];

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(displayContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className={cn('rounded-md border', palette.border, palette.bg)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors rounded-md',
          palette.hoverBg,
        )}
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150',
            palette.icon,
            expanded && 'rotate-90',
          )}
        />
        <Wrench className={cn('h-3.5 w-3.5 flex-shrink-0', palette.icon)} />
        <span className={cn('text-[10px] font-semibold uppercase tracking-[0.14em] flex-shrink-0', palette.label)}>
          {label}
        </span>
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider flex-shrink-0', palette.pill)}>
          {format}
        </span>
        <span className="flex-shrink-0 text-[10px] text-muted-foreground/60">
          {formatBytes(content.length)}
        </span>
        {!expanded && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/60">
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div className="relative border-t border-border/30">
          <button
            type="button"
            onClick={handleCopy}
            className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
            title="Copy content"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
          <pre className="max-h-[400px] overflow-auto px-3 py-2 pr-20 font-mono text-[11px] leading-relaxed text-foreground/85">
            <code className="whitespace-pre-wrap break-words">{displayContent}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
