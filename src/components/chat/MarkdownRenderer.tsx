import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Check, ChevronDown, Copy, FileCode2 } from 'lucide-react';

const LANG_LABELS: Record<string, string> = {
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  py: 'Python',
  rb: 'Ruby',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  cpp: 'C++',
  c: 'C',
  cs: 'C#',
  php: 'PHP',
  swift: 'Swift',
  kt: 'Kotlin',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  sql: 'SQL',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  dockerfile: 'Dockerfile',
  graphql: 'GraphQL',
  xml: 'XML',
  toml: 'TOML',
};

const LANG_COLORS: Record<string, string> = {
  js: '#f7df1e',
  jsx: '#61dafb',
  ts: '#3178c6',
  tsx: '#3178c6',
  py: '#3572A5',
  rb: '#CC342D',
  go: '#00ADD8',
  rs: '#dea584',
  java: '#b07219',
  html: '#e34c26',
  css: '#563d7c',
  scss: '#c6538c',
  json: '#292929',
  sql: '#e38c00',
  sh: '#89e051',
  bash: '#89e051',
};

const LANG_FILENAMES: Record<string, string> = {
  js: 'snippet.js',
  jsx: 'snippet.jsx',
  ts: 'snippet.ts',
  tsx: 'snippet.tsx',
  py: 'snippet.py',
  rb: 'snippet.rb',
  go: 'snippet.go',
  rs: 'snippet.rs',
  java: 'snippet.java',
  cpp: 'snippet.cpp',
  c: 'snippet.c',
  cs: 'snippet.cs',
  php: 'snippet.php',
  swift: 'snippet.swift',
  kt: 'snippet.kt',
  html: 'index.html',
  css: 'styles.css',
  scss: 'styles.scss',
  json: 'data.json',
  yaml: 'config.yaml',
  yml: 'config.yml',
  md: 'README.md',
  sql: 'query.sql',
  sh: 'script.sh',
  bash: 'script.sh',
  zsh: 'script.zsh',
  dockerfile: 'Dockerfile',
  graphql: 'query.graphql',
  xml: 'layout.xml',
  toml: 'config.toml',
};

/** Recursively extract plain text from React children (handles rehype-highlight spans). */
function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children);
  return '';
}

const CodeBlock = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { node?: unknown }>(
  ({ className, children, node: _node, ...props }, ref) => {
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const contentRef = useRef<HTMLDivElement>(null);
    const code = extractText(children).replace(/\n$/, '');
    const COLLAPSED_HEIGHT = 220;
    // rehype-highlight may produce classNames like "hljs language-python"
    const langMatch = className?.match(/language-(\S+)/);
    const langId = langMatch ? langMatch[1] : '';
    const label = LANG_LABELS[langId] || (langId ? langId.toUpperCase() : 'Code');
    const dotColor = LANG_COLORS[langId] || 'hsl(var(--muted-foreground))';
    const virtualFilename = LANG_FILENAMES[langId] || (langId ? `snippet.${langId}` : 'snippet.txt');
    const lineCount = code.split('\n').length;
    const lineNumbers = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');

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
    }, [code, COLLAPSED_HEIGHT]);

    useLayoutEffect(() => {
      if (!isOverflowing && expanded) {
        setExpanded(false);
      }
    }, [expanded, isOverflowing]);

    return (
      <div className="chat-code-block group my-3">
        <div className="chat-code-block__titlebar">
          <div className="chat-code-block__window-controls" aria-hidden="true">
            <span className="chat-code-block__window-dot chat-code-block__window-dot--red" />
            <span className="chat-code-block__window-dot chat-code-block__window-dot--amber" />
            <span className="chat-code-block__window-dot chat-code-block__window-dot--green" />
          </div>
          <div className="chat-code-block__tab">
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-[#519aba]" />
            <span className="chat-code-block__filename">{virtualFilename}</span>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="chat-code-block__copy"
            title={copied ? 'Copied!' : 'Copy code'}
            aria-label={copied ? 'Copied!' : 'Copy code'}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="chat-code-block__meta">
          <div className="flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: dotColor }}
            />
            <span className="chat-code-block__language">{label}</span>
          </div>
          <span className="chat-code-block__line-count">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>

        <div className="chat-code-block__body">
          <div
            ref={contentRef}
            className="overflow-hidden transition-[max-height] duration-300 ease-in-out"
            style={{ maxHeight: expanded ? `${contentRef.current?.scrollHeight || 2000}px` : `${COLLAPSED_HEIGHT}px` }}
          >
            <div className="chat-code-block__editor">
              <pre aria-hidden="true" className="chat-code-block__gutter">
                {lineNumbers}
              </pre>
              <div className="chat-code-block__viewport">
                <pre className="chat-code-block__pre">
                  <code ref={ref} className={className} {...props}>{children}</code>
                </pre>
              </div>
            </div>
          </div>

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

export const MarkdownRenderer = React.forwardRef<HTMLDivElement, MarkdownRendererProps>(
  ({ content }, ref) => {
    const plugins = useMemo(() => ({
      remark: [remarkGfm, remarkMath],
      rehype: [rehypeKatex, rehypeHighlight],
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
                <code className="px-1.5 py-0.5 rounded-md bg-muted/80 text-[13px] font-mono border border-border/30" {...props}>
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
MarkdownRenderer.displayName = 'MarkdownRenderer';
