import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Frameless quick-capture window. The same bundle serves it when the URL has
 * `?quick=1` (see src/main.tsx) — main-process delivers captured text via
 * `quick:submit` and this window sends it back through `electronAPI.quick`.
 */
export const QuickWindow: React.FC = () => {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const text = value.trim();
    if (!text || sending) return;
    setError(null);
    const api = window.electronAPI?.quick;
    if (!api) {
      setError('Quick submit is unavailable in this window.');
      return;
    }
    setSending(true);
    try {
      const res = await api.submit(text);
      if (res?.ok) {
        setValue('');
      } else {
        setError('Could not send — try again.');
      }
    } catch {
      setError('Could not send — try again.');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className="flex min-h-screen flex-col justify-center bg-[#0a0a0a] p-3 font-sans text-foreground"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-background/60 px-2.5 py-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
        <input
          ref={inputRef}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            else if (e.key === 'Escape') window.close();
          }}
          placeholder="Ask Spark… (Enter to send, Esc to close)"
          aria-label="Quick capture input"
          disabled={sending}
          className={cn(
            'h-8 w-full bg-transparent text-[13px] font-normal text-foreground',
            'placeholder:text-muted-foreground/60 focus:outline-none',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
      </div>
      {error && (
        <p role="alert" className="px-1 pt-1.5 text-[11px] text-red-400">
          {error}
        </p>
      )}
    </div>
  );
};
