import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

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

const CodeBlock = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => {
    const code = String(children).replace(/\n$/, '');
    const langId = className?.replace('language-', '') || '';
    const label = LANG_LABELS[langId] || langId.toUpperCase() || 'Code';
    const dotColor = LANG_COLORS[langId] || 'hsl(var(--muted-foreground))';
    const lineCount = code.split('\n').length;

    return (
      <div className="relative group my-3 rounded-lg overflow-hidden border border-border/60 bg-[hsl(var(--code-bg))] shadow-sm">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-[hsl(var(--code-bg))] border-b border-border/40">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full shrink-0"
              style={{ backgroundColor: dotColor }}
            />
            <span className="text-xs font-medium text-muted-foreground tracking-wide">
              {label}
            </span>
            <span className="text-[10px] text-muted-foreground/50 font-mono">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
          </div>
          {/* Shoelace copy button */}
          <sl-copy-button
            value={code}
            copy-label="Copy code"
            success-label="Copied!"
            error-label="Error"
            class="sl-copy-btn"
          />
        </div>
        {/* Code content */}
        <pre className="overflow-x-auto p-4 text-[13px] leading-[1.6] bg-[hsl(var(--code-bg))] m-0">
          <code ref={ref} className={className} {...props}>{children}</code>
        </pre>
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
      <div ref={ref} className="prose prose-sm dark:prose-invert max-w-none prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0 prose-code:before:content-none prose-code:after:content-none prose-headings:font-semibold prose-p:text-base prose-p:leading-relaxed">
        <ReactMarkdown
          remarkPlugins={plugins.remark}
          rehypePlugins={plugins.rehype}
          components={{
            code({ className, children, ...props }) {
              const isBlock = className?.startsWith('language-') || String(children).includes('\n');
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
