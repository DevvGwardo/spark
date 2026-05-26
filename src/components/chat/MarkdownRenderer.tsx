import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize from 'rehype-sanitize';
import { Check, ChevronDown, Copy, ExternalLink, Terminal } from 'lucide-react';
import { codeToHtml } from 'shiki';
import {
  defaultSafeUrlTransform,
  getImageUrl,
  getLocalImageTarget,
  getOpenableUrl,
  isImageSrcUrl,
  rewriteLocalImageTokens,
} from '@/lib/local-images';
import { MermaidDiagram } from './MermaidDiagram';

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

function openExternalUrl(url: string) {
  if (window.electronAPI?.openExternal) {
    void window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

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
      rehype: [rehypeKatex, rehypeSanitize],
    }), []);
    const processedContent = useMemo(() => rewriteLocalImageTokens(content), [content]);

    return (
      <div ref={ref} className="prose prose-sm dark:prose-invert max-w-none overflow-hidden prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0 prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold prose-p:text-base prose-p:leading-relaxed">
        <ReactMarkdown
          remarkPlugins={plugins.remark}
          rehypePlugins={plugins.rehype}
          urlTransform={(url, key, node) => {
            if (isImageSrcUrl(key, node)) {
              const imageUrl = getImageUrl(url);
              if (imageUrl) return imageUrl;
            }

            return defaultSafeUrlTransform(url);
          }}
          components={{
            code({ className, children, node: _node, ...props }) {
              const text = extractText(children);
              const isBlock = className?.includes('language-') || text.includes('\n');
              if (isBlock) {
                if (className === 'language-mermaid') {
                  return <MermaidDiagram source={text.replace(/\n$/, '')} />;
                }
                return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
              }
              const imageTarget = getLocalImageTarget(text);
              if (imageTarget) {
                return (
                  <span className="my-2 block">
                    <img
                      src={imageTarget.srcUrl}
                      alt={text.trim()}
                    data-open-url={imageTarget.openUrl}
                    className="max-h-[480px] max-w-full cursor-pointer rounded-lg border border-border/40 object-contain"
                    loading="lazy"
                    onClick={(event) => openExternalUrl(event.currentTarget.dataset.openUrl || imageTarget.openUrl)}
                  />
                    <span className="mt-1 block text-[11px] text-muted-foreground/60 font-mono truncate">
                      {text.trim()}
                    </span>
                  </span>
                );
              }
              const openableUrl = getOpenableUrl(text);
              if (openableUrl) {
                return (
                  <span className="inline-flex items-center gap-1 align-baseline">
                    <code className="px-1.5 py-0.5 rounded bg-muted/60 text-[13px] font-mono border border-border/30 text-foreground/90" {...props}>
                      {children}
                    </code>
                    <button
                      type="button"
                      onClick={() => openExternalUrl(openableUrl)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded border border-border/40 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
                      title="Open in browser"
                      aria-label="Open in browser"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  </span>
                );
              }
              return (
                <code className="px-1.5 py-0.5 rounded bg-muted/60 text-[13px] font-mono border border-border/30 text-foreground/90" {...props}>
                  {children}
                </code>
              );
            },
            a({ href, children, ...props }) {
              const isExternal = typeof href === 'string' && /^(https?:\/\/|file:\/\/\/)/i.test(href);
              if (isExternal) {
                return (
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      openExternalUrl(href!);
                    }}
                    className="text-primary underline-offset-2 hover:underline cursor-pointer"
                    {...props}
                  >
                    {children}
                  </a>
                );
              }
              return <a href={href} {...props}>{children}</a>;
            },
            img({ src, alt, ...props }) {
              const rawSrc = typeof src === 'string' ? src : '';
              const imageTarget = getLocalImageTarget(rawSrc) || (typeof alt === 'string' ? getLocalImageTarget(alt) : null);
              if (!imageTarget) {
                return <img src={src} alt={alt ?? ''} {...props} />;
              }

              const label = alt?.trim() || rawSrc.trim();
              return (
                <span className="my-2 block">
                  <img
                    src={imageTarget.srcUrl}
                    alt={label}
                    data-open-url={imageTarget.openUrl}
                    className="max-h-[480px] max-w-full cursor-pointer rounded-lg border border-border/40 object-contain"
                    loading="lazy"
                    onClick={(event) => openExternalUrl(event.currentTarget.dataset.openUrl || imageTarget.openUrl)}
                    {...props}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground/60 font-mono truncate">
                    {label}
                  </span>
                </span>
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
          {processedContent}
        </ReactMarkdown>
      </div>
    );
  }
);
MarkdownRendererInner.displayName = 'MarkdownRenderer';

export const MarkdownRenderer = React.memo(MarkdownRendererInner);
