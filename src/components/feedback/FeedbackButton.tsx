import React, { useEffect, useState } from 'react';
import { Bug, MessageSquarePlus, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';

const REPO_BASE = 'https://github.com/DevvGwardo/cloud-chat-hub';

type TemplateKey = 'bug_report' | 'feature_request' | 'feedback';

interface IssueLinkOptions {
  template: TemplateKey;
  appVersion: string;
  platform: string;
  electronVersion: string;
}

function buildIssueUrl({ template, appVersion, platform, electronVersion }: IssueLinkOptions): string {
  // Pre-fill the version & OS fields the templates expect.
  const params = new URLSearchParams();
  params.set('template', `${template}.yml`);
  params.set('app-version', appVersion || 'unknown');
  // GitHub form templates can take dropdown defaults via field name.
  // We pre-fill the OS dropdown best-effort; user can correct it.
  const osDefault =
    platform === 'darwin'
      ? 'macOS (Apple Silicon)'
      : platform === 'win32'
        ? 'Windows 11'
        : 'Other';
  params.set('os', osDefault);
  // Add a "Logs" hint with electron version so reports are auto-informative.
  if (template === 'bug_report') {
    params.set('logs', `Electron ${electronVersion} on ${platform}`);
  }
  return `${REPO_BASE}/issues/new?${params.toString()}`;
}

export const FeedbackButton: React.FC<{ className?: string }> = ({ className }) => {
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    const electronAPI = window.electronAPI;
    if (!electronAPI?.getAppVersion) {
      return;
    }
    electronAPI.getAppVersion().then(setAppVersion).catch(() => {});
  }, []);

  const electronAPI = window.electronAPI;
  const platform = electronAPI?.platform ?? 'unknown';
  const electronVersion = electronAPI?.versions?.electron ?? '';

  const open = (template: TemplateKey) => {
    const url = buildIssueUrl({ template, appVersion, platform, electronVersion });
    if (electronAPI) {
      // In Electron, will-navigate handler routes external URLs through shell.openExternal
      window.open(url, '_blank', 'noopener');
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Send beta feedback"
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] text-[hsl(var(--text-faint))] hover:text-foreground hover:bg-muted transition-colors duration-100',
            className,
          )}
        >
          <MessageSquarePlus className="h-3 w-3" />
          <span>Feedback</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          Beta {appVersion && `· v${appVersion}`}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => open('bug_report')} className="gap-2 text-[12px]">
          <Bug className="h-3.5 w-3.5 text-red-400" />
          Report a bug
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open('feature_request')} className="gap-2 text-[12px]">
          <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
          Request a feature
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open('feedback')} className="gap-2 text-[12px]">
          <MessageSquarePlus className="h-3.5 w-3.5 text-sky-400" />
          Share feedback
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
