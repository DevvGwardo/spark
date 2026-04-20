import React, { useState, useEffect, useCallback } from 'react';
import { Download, Check, Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApiBaseUrl } from '@/lib/api';

interface UpdateStatus {
  commitsBehind: number;
  updateAvailable: boolean;
  currentVersion: string;
  updateInProgress: boolean;
  currentBranch?: string;
  dirty?: boolean;
  hasConflicts?: boolean;
  stashCount?: number;
  blockedReason?: string | null;
}

export const HermesUpdateButton: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/hermes/update/status`);
      if (res.ok) {
        const data = await res.json() as UpdateStatus;
        setStatus(data);
      }
    } catch {
      // silently fail — hermes might not be installed
    }
  }, []);

  // Check on mount and every 5 minutes
  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setError(null);
    setResult(null);

    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/hermes/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResult(`Updated to ${data.newVersion}`);
        // Re-check status after update
        setTimeout(checkStatus, 2000);
      } else {
        setError(data.error || 'Update failed');
      }
    } catch (err: any) {
      setError(err.message || 'Update failed');
    } finally {
      setUpdating(false);
    }
  }, [checkStatus]);

  // Don't render if status check failed (hermes not installed?)
  if (!status) return null;

  const hasUpdate = status.updateAvailable && !updating;
  const justUpdated = result && !error;
  const isBlocked = status.blockedReason && !updating;

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={handleUpdate}
        disabled={updating || !status.updateAvailable || isBlocked}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
          isBlocked
            ? 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30 cursor-not-allowed'
            : hasUpdate
              ? 'bg-violet-500/15 text-violet-400 ring-1 ring-violet-500/30 hover:bg-violet-500/25'
              : justUpdated
                ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
        )}
        title={
          isBlocked
            ? status.blockedReason
            : updating
              ? 'Updating Hermes...'
              : hasUpdate
                ? `${status.commitsBehind} update${status.commitsBehind !== 1 ? 's' : ''} available`
                : 'Hermes is up to date'
        }
      >
        {updating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isBlocked ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : justUpdated ? (
          <Check className="h-3.5 w-3.5" />
        ) : hasUpdate ? (
          <Download className="h-3.5 w-3.5" />
        ) : (
          <Check className="h-3.5 w-3.5" />
        )}
        <span>
          {isBlocked
            ? 'Blocked'
            : updating
              ? 'Updating...'
              : justUpdated
                ? 'Updated!'
                : hasUpdate
                  ? `Update (${status.commitsBehind})`
                  : 'Up to date'}
        </span>
      </button>

      {error && (
        <span className="text-[10px] text-destructive max-w-[120px] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
};
