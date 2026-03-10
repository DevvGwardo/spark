import React, { useMemo } from 'react';
import { usePreviewStore, type PreviewFile } from '@/stores/preview-store';
import { usePanelStore } from '@/stores/panel-store';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { X, Eye, FileText, Palette, Code, Trash2, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

const fileTypeIcons: Record<string, React.ElementType> = {
  html: FileText,
  css: Palette,
  js: Code,
  jsx: Code,
  tsx: Code,
  ts: Code,
  md: BookOpen,
};

const fileTypeColors: Record<string, string> = {
  html: 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400',
  css: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  js: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400',
  jsx: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/20 dark:text-cyan-400',
  tsx: 'bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400',
  ts: 'bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
  md: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400',
};

const generateHtmlPreview = (files: PreviewFile[], activeFileId: string | null) => {
  const htmlFiles = files.filter(f => f.type === 'html');
  const cssFiles = files.filter(f => f.type === 'css');
  const jsFiles = files.filter(f => f.type === 'js');

  const mainHtml = htmlFiles.find(f => f.id === activeFileId) || htmlFiles[0];
  if (!mainHtml) return '';

  const combinedCss = cssFiles.map(f => f.content).join('\n\n');
  const combinedJs = jsFiles.map(f => f.content).join('\n\n');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Preview</title>
    <style>
      html, body {
        background: #ffffff;
        color: #1a1a1a;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: 16px;
      }
    </style>
    ${combinedCss ? `<style>\n${combinedCss}\n</style>` : ''}
</head>
<body>
    ${mainHtml.content}
    ${combinedJs ? `<script>\n${combinedJs}\n</script>` : ''}
</body>
</html>`;
};

const generateReactPreview = (files: PreviewFile[], activeFileId: string | null) => {
  const jsxFiles = files.filter(f => f.type === 'jsx' || f.type === 'tsx');
  const cssFiles = files.filter(f => f.type === 'css');

  const mainComponent = jsxFiles.find(f => f.id === activeFileId) ||
                        jsxFiles.find(f => f.filename.toLowerCase().includes('app')) ||
                        jsxFiles[0];

  if (!mainComponent) return '<div>No React component found</div>';

  const combinedCss = cssFiles.map(f => f.content).join('\n\n');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>React Preview</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
      html, body {
        background: #ffffff;
        color: #1a1a1a;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: 0;
      }
    </style>
    ${combinedCss ? `<style>\n${combinedCss}\n</style>` : ''}
</head>
<body>
    <div id="root"></div>
    <script type="text/babel">
      const { useState, useEffect, useCallback } = React;

      ${jsxFiles.map(f => f.content).join('\n\n')}

      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(${mainComponent.filename.replace(/\.(jsx|tsx)$/, '')}));
    </script>
</body>
</html>`;
};

const generateNextjsPreview = (files: PreviewFile[], activeFileId: string | null) => {
  const jsxFiles = files.filter(f => f.type === 'jsx' || f.type === 'tsx');
  const cssFiles = files.filter(f => f.type === 'css');

  const pageComponent = jsxFiles.find(f => f.filename.includes('pages/') || f.filename.includes('app/')) ||
                        jsxFiles.find(f => f.id === activeFileId) ||
                        jsxFiles[0];

  if (!pageComponent) return '<div>No Next.js page component found</div>';

  const combinedCss = cssFiles.map(f => f.content).join('\n\n');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Next.js Preview</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    ${combinedCss ? `<style>\n${combinedCss}\n</style>` : ''}
    <style>
      html, body { background: #ffffff; color: #1a1a1a; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="text/babel">
      const { useState, useEffect, useCallback } = React;

      // Mock Next.js router and components
      const useRouter = () => ({
        push: (href) => console.log('Navigate to:', href),
        pathname: '/',
        query: {}
      });

      const Link = ({ href, children, ...props }) =>
        React.createElement('a', { href, onClick: (e) => { e.preventDefault(); console.log('Navigate to:', href); }, ...props }, children);

      const Image = ({ src, alt, width, height, ...props }) =>
        React.createElement('img', { src, alt, width, height, ...props });

      ${jsxFiles.map(f => f.content).join('\n\n')}

      const root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(${pageComponent.filename.replace(/\.(jsx|tsx)$/, '')}));
    </script>
</body>
</html>`;
};

const generateMarkdownPreview = (files: PreviewFile[], activeFileId: string | null) => {
  const mdFiles = files.filter(f => f.type === 'md');
  const mainMd = mdFiles.find(f => f.id === activeFileId) || mdFiles[0];
  if (!mainMd) return '';

  // Simple markdown-to-HTML conversion via the browser — uses a basic script
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Markdown Preview</title>
    <style>
      html, body {
        background: #ffffff;
        color: #1a1a1a;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        margin: 0;
        padding: 24px;
        line-height: 1.6;
      }
      h1, h2, h3, h4, h5, h6 { margin-top: 1.5em; margin-bottom: 0.5em; }
      h1 { font-size: 2em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
      h2 { font-size: 1.5em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }
      code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
      pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
      pre code { background: none; padding: 0; }
      blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.5em 1em; color: #666; }
      a { color: #0366d6; }
      ul, ol { padding-left: 2em; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background: #f6f8fa; }
      img { max-width: 100%; }
    </style>
</head>
<body>
    <div id="content"></div>
    <script>
      // Basic markdown renderer
      function renderMarkdown(md) {
        let html = md
          .replace(/^### (.*$)/gm, '<h3>$1</h3>')
          .replace(/^## (.*$)/gm, '<h2>$1</h2>')
          .replace(/^# (.*$)/gm, '<h1>$1</h1>')
          .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
          .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
          .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>')
          .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
          .replace(/^\\> (.*$)/gm, '<blockquote>$1</blockquote>')
          .replace(/^- (.*$)/gm, '<li>$1</li>')
          .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
          .replace(/^---$/gm, '<hr>')
          .replace(/\\n\\n/g, '</p><p>')
          .replace(/\\n/g, '<br>');
        return '<p>' + html + '</p>';
      }
      document.getElementById('content').innerHTML = renderMarkdown(${JSON.stringify(mainMd.content)});
    </script>
</body>
</html>`;
};

export const PreviewSidebar: React.FC = () => {
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const preview = usePreviewStore((s) => s.getPreview(focusedPanelId));
  const setOpen = usePreviewStore((s) => s.setOpen);
  const setActiveFile = usePreviewStore((s) => s.setActiveFile);
  const removeFile = usePreviewStore((s) => s.removeFile);
  const activeFile = usePreviewStore((s) => s.getActiveFile(focusedPanelId));
  const { isOpen, files, activeFileId, projectType } = preview;

  // Generate preview HTML that includes all files
  const previewHtml = useMemo(() => {
    if (files.length === 0) return '';

    // If the active file is markdown, render markdown preview
    const active = files.find(f => f.id === activeFileId) || files[0];
    if (active?.type === 'md') {
      return generateMarkdownPreview(files, activeFileId);
    }

    if (projectType === 'react') {
      return generateReactPreview(files, activeFileId);
    } else if (projectType === 'nextjs') {
      return generateNextjsPreview(files, activeFileId);
    } else {
      return generateHtmlPreview(files, activeFileId);
    }
  }, [files, activeFileId, projectType]);

  if (!isOpen) return null;

  return (
    <div className="flex-shrink-0 w-[400px] border-l border-border bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4" />
          <span className="font-medium text-sm">Preview</span>
          <Badge variant="secondary" className="text-xs">
            {projectType.toUpperCase()}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(focusedPanelId, false)}
          className="h-8 w-8 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* File List */}
      {files.length > 0 && (
        <div className="p-3 border-b border-border">
          <div className="text-xs font-medium text-muted-foreground mb-2">Files</div>
          <div className="space-y-1">
            {files.map((file) => {
              const IconComponent = fileTypeIcons[file.type];
              return (
                <div
                  key={file.id}
                  className={cn(
                    'flex items-center justify-between p-2 rounded-md cursor-pointer hover:bg-muted/50',
                    file.id === activeFileId && 'bg-muted'
                  )}
                  onClick={() => setActiveFile(focusedPanelId, file.id)}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <IconComponent className="h-3 w-3 flex-shrink-0" />
                    <span className="text-xs truncate">{file.filename}</span>
                    <Badge variant="outline" className={cn("text-xs h-4 px-1", fileTypeColors[file.type])}>
                      {file.type}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(focusedPanelId, file.id);
                    }}
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Preview Area */}
      <div className="flex-1 flex flex-col">
        {files.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <Eye className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
              <div className="text-sm font-medium mb-2">No files to preview</div>
              <div className="text-xs text-muted-foreground">
                Create HTML, CSS, or JS files in the chat to see them here
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col">
            <div className="p-2 border-b border-border bg-muted/30">
              <div className="text-xs font-medium">Live Preview</div>
            </div>
            <div className="flex-1">
              <iframe
                srcDoc={previewHtml}
                className="w-full h-full border-0"
                sandbox="allow-scripts allow-same-origin"
                title="HTML Preview"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
