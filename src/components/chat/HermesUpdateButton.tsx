import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Download, Check, Loader2, AlertTriangle, X } from 'lucide-react';
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

interface UpdateProgress {
  step: number;
  totalSteps: number;
  label: string;
  done: boolean;
  success: boolean | null;
  error: string | null;
  newVersion: string | null;
}

const UpdateProgressModal: React.FC<{
  progress: UpdateProgress | null;
  updating: boolean;
  onClose: () => void;
}> = ({ progress, updating, onClose }) => {
  const step = progress?.step ?? 0;
  const total = progress?.totalSteps ?? 6;
  const pct = progress?.done && progress.success ? 100 : Math.round((step / total) * 100);
  const failed = progress?.done && progress.success === false;
  const succeeded = progress?.done && progress.success === true;
  const canClose = !updating || !!progress?.done;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md"
        onClick={canClose ? onClose : undefined}
      />
      <div className="relative mx-4 w-full max-w-[420px] overflow-hidden rounded-[20px] border border-[#1E1E22] bg-background shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-[#1E1E22] px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#16161A]">
            {succeeded ? (
              <Check className="h-4 w-4 text-emerald-400" />
            ) : failed ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <Download className="h-4 w-4 text-violet-400" />
            )}
          </div>
          <h2 className="text-sm font-semibold text-[#FAFAF9]">
            {succeeded ? 'Hermes Updated' : failed ? 'Update Failed' : 'Updating Hermes'}
          </h2>
          <div className="flex-1" />
          {canClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#16161A] text-[#6B6B70] transition-colors hover:bg-[#1E1E22] hover:text-[#FAFAF9]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {/* Progress bar */}
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-[#16161A]"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                failed ? 'bg-destructive' : succeeded ? 'bg-emerald-500' : 'bg-violet-500'
              )}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* Status line */}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            {!progress?.done && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />}
            <span className={cn(failed && 'text-destructive', succeeded && 'text-emerald-400')}>
              {failed
                ? progress?.error || 'Update failed'
                : succeeded
                  ? `Updated to ${progress?.newVersion || 'latest version'}`
                  : progress?.label || 'Starting update...'}
            </span>
            <div className="flex-1" />
            {!progress?.done && (
              <span className="font-mono text-[10px] tabular-nums">
                {step}/{total}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const HermesUpdateButton: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Clean up polling on unmount
  useEffect(() => stopPolling, [stopPolling]);

  // Auto-close the modal shortly after a successful update
  useEffect(() => {
    if (modalOpen && progress?.done && progress.success) {
      const t = setTimeout(() => setModalOpen(false), 1500);
      return () => clearTimeout(t);
    }
  }, [modalOpen, progress]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const baseUrl = getApiBaseUrl();
        const res = await fetch(`${baseUrl}/api/hermes/update/progress`);
        if (res.ok) {
          const data = await res.json() as UpdateProgress;
          setProgress(data);
          if (data.done) stopPolling();
        }
      } catch {
        // keep polling — transient network errors are fine
      }
    }, 750);
  }, [stopPolling]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setError(null);
    setResult(null);
    setProgress(null);
    setModalOpen(true);
    startPolling();

    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetch(`${baseUrl}/api/hermes/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResult(`Updated to ${data.newVersion}`);
        // Set terminal state directly — polling may stop before the final snapshot
        setProgress((prev) => ({
          step: prev?.totalSteps ?? 6,
          totalSteps: prev?.totalSteps ?? 6,
          label: 'Update complete',
          done: true,
          success: true,
          error: null,
          newVersion: data.newVersion ?? null,
        }));
        // Re-check status after update
        setTimeout(checkStatus, 2000);
      } else {
        setError(data.error || 'Update failed');
        setProgress((prev) => ({
          step: prev?.step ?? 0,
          totalSteps: prev?.totalSteps ?? 6,
          label: prev?.label ?? '',
          done: true,
          success: false,
          error: data.error || 'Update failed',
          newVersion: null,
        }));
      }
    } catch (err: any) {
      setError(err.message || 'Update failed');
      // POST itself failed — surface it in the modal since progress polling won't
      setProgress((prev) => ({
        step: prev?.step ?? 0,
        totalSteps: prev?.totalSteps ?? 6,
        label: prev?.label ?? '',
        done: true,
        success: false,
        error: err.message || 'Update failed',
        newVersion: null,
      }));
    } finally {
      setUpdating(false);
      stopPolling();
    }
  }, [checkStatus, startPolling, stopPolling]);

  // Don't render if status check failed (hermes not installed?)
  if (!status) return null;

  const hasUpdate = status.updateAvailable && !updating;
  const justUpdated = result && !error;
  const isBlocked = status.blockedReason && !updating;

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={handleUpdate}
        disabled={updating || !status.updateAvailable || !!isBlocked}
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
            ? (status.blockedReason ?? undefined)
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

      {error && !modalOpen && (
        <span className="text-[10px] text-destructive max-w-[120px] truncate" title={error}>
          {error}
        </span>
      )}

      {modalOpen && (
        <UpdateProgressModal
          progress={progress}
          updating={updating}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
};
