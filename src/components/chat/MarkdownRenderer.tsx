import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, ChevronDown, Copy, Terminal } from 'lucide-react';
import { codeToHtml } from 'shiki';

const LANG_LABELS: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cpp: 'c++',
  c: 'c',
  cs: 'c#',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sql: 'sql',
  sh: 'shell',
  bash: 'bash',
  zsh: 'zsh',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  xml: 'xml',
  toml: 'toml',
};

/** Map short aliases to valid Shiki language identifiers */
const SHIKI_LANG_MAP: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  html: 'html',
  css: 'css',
  scss: 'scss',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  xml: 'xml',
  toml: 'toml',
  plaintext: 'text',
  text: 'text',
};

/** Recursively extract plain text from React children */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children);
  return '';
}

/** Use Shiki to highlight code asynchronously */
function useShikiHighlight(code: string, lang: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const prevKey = useRef('');

  useEffect(() => {
    const key = `${lang}:${code}`;
    if (key === prevKey.current) return;
    prevKey.current = key;

    let cancelled = false;
    const shikiLang = SHIKI_LANG_MAP[lang] || lang || 'text';

    codeToHtml(code, {
      lang: shikiLang,
      theme: 'github-dark-default',
    })
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Fallback: retry with plaintext
        if (!cancelled) {
          codeToHtml(code, { lang: 'text', theme: 'github-dark-default' })
            .then((result) => { if (!cancelled) setHtml(result); })
            .catch(() => { if (!cancelled) setHtml(null); });
        }
      });

    return () => { cancelled = true; };
  }, [code, lang]);

  return html;
}

const CodeBlock = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { node?: unknown }>(
  ({ className, children, node: _node, ...props }, _ref) => {
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const code = extractText(children).replace(/\n$/, '');
    const COLLAPSED_HEIGHT = 240;

    const langMatch = className?.match(/language-(\S+)/);
    const langId = langMatch ? langMatch[1] : '';
    const label = LANG_LABELS[langId] || langId || 'code';
    const lineCount = code.split('\n').length;

    // Shiki async highlighting
    const shikiHtml = useShikiHighlight(code, langId);

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
      }
    };

    useLayoutEffect(() => {
      if (contentRef.current) {
        setIsOverflowing(contentRef.current.scrollHeight > COLLAPSED_HEIGHT);
      }
    }, [code, shikiHtml, COLLAPSED_HEIGHT]);

    useLayoutEffect(() => {
      if (!isOverflowing && expanded) {
        setExpanded(false);
      }
    }, [expanded, isOverflowing]);

    // Generate line numbers
    const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1);

    return (
      <div className="chat-code-block group my-3">
        {/* Header */}
        <div className="chat-code-block__header">
          <div className="flex items-center gap-2 min-w-0">
            <Terminal className="h-3 w-3 shrink-0 opacity-40" />
            <span className="chat-code-block__lang">{label}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="chat-code-block__line-count">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="chat-code-block__copy"
              title={copied ? 'Copied!' : 'Copy'}
              aria-label={copied ? 'Copied!' : 'Copy code'}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Code body */}
        <div className="chat-code-block__body">
          <div
            ref={contentRef}
            className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={{ maxHeight: expanded ? `${contentRef.current?.scrollHeight || 2000}px` : `${COLLAPSED_HEIGHT}px` }}
          >
            <div className="chat-code-block__editor">
              {/* Line numbers gutter */}
              <div className="chat-code-block__gutter" aria-hidden="true">
                {lineNumbers.map((n) => (
                  <div key={n} className="chat-code-block__line-num">{n}</div>
                ))}
              </div>

              {/* Code content */}
              <div className="chat-code-block__viewport">
                {shikiHtml ? (
                  <div
                    className="chat-code-block__shiki"
                    dangerouslySetInnerHTML={{ __html: shikiHtml }}
                  />
                ) : (
                  <pre className="chat-code-block__pre">
                    <code className={className} {...props}>{children}</code>
                  </pre>
                )}
              </div>
            </div>
          </div>

          {/* Collapse/expand controls */}
          {isOverflowing && !expanded && (
            <div className="absolute bottom-0 left-0 right-0">
              <div className="chat-code-block__fade" />
              <div className="chat-code-block__footer">
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  className="chat-code-block__toggle"
                >
                  Show more
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}

          {isOverflowing && expanded && (
            <div className="chat-code-block__footer chat-code-block__footer--expanded">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="chat-code-block__toggle"
              >
                Show less
                <ChevronDown className="h-3 w-3 rotate-180" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
);
CodeBlock.displayName = 'CodeBlock';

interface MarkdownRendererProps {
  content: string;
}

const MarkdownRendererInner = React.forwardRef<HTMLDivElement, MarkdownRendererProps>(
  ({ content }, ref) => {
    const plugins = useMemo(() => ({
      remark: [remarkGfm, remarkMath],
      rehype: [rehypeKatex],
    }), []);

    return (
      <div ref={ref} className="prose prose-sm dark:prose-invert max-w-none overflow-hidden prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0 prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold prose-p:text-base prose-p:leading-relaxed">
        <ReactMarkdown
          remarkPlugins={plugins.remark}
          rehypePlugins={plugins.rehype}
          components={{
            code({ className, children, node: _node, ...props }) {
              const isBlock = className?.includes('language-') || extractText(children).includes('\n');
              if (isBlock) {
                return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
              }
              return (
                <code className="px-1.5 py-0.5 rounded bg-muted/60 text-[13px] font-mono border border-border/30 text-foreground/90" {...props}>
                  {children}
                </code>
              );
            },
            table({ children }) {
              return (
                <div className="overflow-x-auto my-3">
                  <table className="min-w-full border-collapse border border-border">{children}</table>
                </div>
              );
            },
            th({ children }) {
              return <th className="border border-border px-3 py-2 bg-muted text-left text-sm font-medium">{children}</th>;
            },
            td({ children }) {
              return <td className="border border-border px-3 py-2 text-sm">{children}</td>;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
);
MarkdownRendererInner.displayName = 'MarkdownRenderer';

export const MarkdownRenderer = React.memo(MarkdownRendererInner);
