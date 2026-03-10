import React, { useState } from 'react';
import { X, GitPullRequest, Loader2, Check, AlertCircle, ExternalLink } from 'lucide-react';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';

interface FileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
  originalContent?: string;
}

interface CreatePRModalProps {
  isOpen: boolean;
  onClose: () => void;
  owner: string;
  repo: string;
  baseBranch: string;
  files: FileChange[];
  onSuccess?: () => void;
}

export const CreatePRModal: React.FC<CreatePRModalProps> = ({
  isOpen,
  onClose,
  owner,
  repo,
  baseBranch,
  files,
  onSuccess,
}) => {
  const { githubPAT } = useSettingsStore();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [branchName, setBranchName] = useState(`ai/chat-changes-${Date.now()}`);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ number: number; url: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !branchName.trim() || files.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${getApiBaseUrl()}/functions/v1/github-integration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create-pr',
            pat: githubPAT,
            owner,
            repo,
            title,
            body,
            branch: branchName,
            baseBranch,
            files: files.map(f => ({ path: f.path, content: f.content, action: f.action || 'edit' })),
          }),
        }
      );

      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        setSuccess(data.pr);
        onSuccess?.();
      }
    } catch (err) {
      setError('Failed to create pull request');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-foreground/10 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative bg-background border border-border rounded-xl w-full max-w-lg mx-4 shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <GitPullRequest className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Create Pull Request</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {success ? (
            <div className="text-center py-4">
              <div className="h-12 w-12 rounded-full bg-accent flex items-center justify-center mx-auto mb-4">
                <Check className="h-6 w-6 text-accent-foreground" />
              </div>
              <h3 className="text-sm font-medium mb-2">Pull Request Created!</h3>
              <p className="text-xs text-muted-foreground mb-4">
                PR #{success.number} has been created successfully.
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-input text-sm font-medium hover:bg-secondary transition-colors"
                >
                  Done
                </button>
                <a
                  href={success.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  View on GitHub
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Target info */}
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary text-xs">
                <span className="text-muted-foreground">Target:</span>
                <span className="font-medium">{owner}/{repo}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono">{baseBranch}</span>
              </div>

              {/* Files to change */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Files to change ({files.length})
                </label>
                <div className="rounded-lg border border-input bg-secondary/30 max-h-24 overflow-y-auto">
                  {files.map(file => (
                    <div key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border last:border-0">
                      <span className={cn(
                        'text-[10px] font-medium uppercase px-1.5 py-0.5 rounded',
                        file.action === 'create' ? 'bg-emerald-500/10 text-emerald-500' :
                        file.action === 'delete' ? 'bg-destructive/10 text-destructive' :
                        'bg-amber-500/10 text-amber-500'
                      )}>
                        {file.action || 'edit'}
                      </span>
                      <span className="font-mono truncate">{file.path}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Branch name */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Branch name
                </label>
                <input
                  type="text"
                  value={branchName}
                  onChange={e => setBranchName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="feature/ai-changes"
                />
              </div>

              {/* Title */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  PR Title
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="feat: AI-generated improvements"
                  required
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Description (optional)
                </label>
                <textarea
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="Describe the changes..."
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 text-destructive text-xs">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 px-4 py-2 rounded-lg border border-input text-sm font-medium hover:bg-secondary transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !title.trim() || files.length === 0}
                  className={cn(
                    'flex-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium transition-colors',
                    'hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed',
                    'flex items-center justify-center gap-2'
                  )}
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <GitPullRequest className="h-4 w-4" />
                      Create PR
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
