import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';

function resolveDarkMode(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  if (typeof window === 'undefined') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface MermaidDiagramProps {
  source: string;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const rawId = useId();
  const diagramId = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const theme = useSettingsStore((s) => s.theme);
  const [isDark, setIsDark] = useState(() => resolveDarkMode(theme));
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track system color-scheme changes when theme is 'system'
  useEffect(() => {
    if (theme !== 'system') {
      setIsDark(theme === 'dark');
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
          deterministicIds: true,
          flowchart: { htmlLabels: true },
        });
        if (prefersReducedMotion()) {
          // Mermaid exposes sequence diagram animation via config; keep it off.
          mermaid.initialize({ sequence: { mirrorActors: false } });
        }
        const { svg: rendered } = await mermaid.render(diagramId, source);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          setSvg(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, isDark, diagramId]);

  if (error !== null) {
    return (
      <div className="my-3 overflow-hidden rounded-md border border-destructive/40">
        <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="inline-flex items-center gap-1.5 font-mono">
            <AlertTriangle className="h-3 w-3" />
            mermaid render error
          </span>
          <span className="truncate font-mono text-[11px] opacity-80" title={error}>
            {error}
          </span>
        </div>
        <pre className="overflow-x-auto bg-muted/40 p-3 text-xs">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="chat-mermaid my-3 flex justify-center overflow-x-auto rounded-md border border-border/40 bg-background/40 p-3"
      role="img"
      aria-label="Mermaid diagram"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
