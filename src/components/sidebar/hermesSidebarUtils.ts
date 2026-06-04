import type { CronRun } from '@/lib/hermes-api';

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1000 ? 1 : 0,
  }).format(value);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

export interface CronRunSummary {
  total: number;
  succeeded: number;
  failed: number;
  // Fraction of finished (success + error) runs that succeeded, 0–1. Running
  // runs are excluded from the rate; an empty list yields a rate of 0.
  successRate: number;
}

export function summarizeCronRuns(runs: Array<Pick<CronRun, 'status'>>): CronRunSummary {
  const succeeded = runs.filter((run) => run.status === 'success').length;
  const failed = runs.filter((run) => run.status === 'error').length;
  const finished = succeeded + failed;
  return {
    total: runs.length,
    succeeded,
    failed,
    successRate: finished === 0 ? 0 : succeeded / finished,
  };
}
