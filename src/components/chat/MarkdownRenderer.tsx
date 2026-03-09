import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check } from 'lucide-react';

const CodeBlock = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const code = String(children).replace(/\n$/, '');
    const language = className?.replace('language-', '') || '';

    const handleCopy = async () => {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    return (
      <div className="relative group my-3 rounded-md overflow-hidden border border-border">
        <div className="flex items-center justify-between px-4 py-1.5 bg-muted text-xs text-muted-foreground">
          <span className="font-mono">{language}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 hover:text-foreground transition-colors duration-100"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="overflow-x-auto p-4 text-sm bg-code-bg">
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
                <code className="px-1.5 py-0.5 rounded-sm bg-muted text-sm font-mono" {...props}>
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
