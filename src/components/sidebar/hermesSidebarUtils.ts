import type { CronRun, HermesSession, HermesSkillSummary, HermesWorkspaceFile } from '@/lib/hermes-api';

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

export type UsageBudgetLevel = 'ok' | 'warn' | 'over';

// Classify spend against a budget: 'warn' at ≥75%, 'over' at ≥100%, else 'ok'.
// A zero, negative, or missing budget is treated as 'ok' (no budget to exceed).
export function usageBudgetLevel(spent: number, budget: number): UsageBudgetLevel {
  if (!budget || budget <= 0) return 'ok';
  const ratio = spent / budget;
  if (ratio >= 1) return 'over';
  if (ratio >= 0.75) return 'warn';
  return 'ok';
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

export interface SessionStatusCounts {
  active: number;
  completed: number;
  error: number;
  total: number;
}

// Tally sessions by status. Unknown statuses count toward `total` only, never
// toward the named buckets; an empty list yields all zeros.
export function countSessionStatuses(
  sessions: Array<Pick<HermesSession, 'status'>>,
): SessionStatusCounts {
  const counts: SessionStatusCounts = { active: 0, completed: 0, error: 0, total: 0 };
  for (const session of sessions) {
    counts.total += 1;
    if (session.status === 'active' || session.status === 'completed' || session.status === 'error') {
      counts[session.status] += 1;
    }
  }
  return counts;
}

type FilterableSkill = Pick<HermesSkillSummary, 'name' | 'summary' | 'category' | 'path'>;

// Case-insensitive substring filter over a skill's name/summary/category/path.
// An empty (or whitespace-only) query returns every skill unchanged.
export function filterSkills<T extends FilterableSkill>(skills: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return skills;
  return skills.filter((skill) =>
    `${skill.name} ${skill.summary} ${skill.category} ${skill.path}`.toLowerCase().includes(needle),
  );
}

type ExportableMemory = Pick<HermesWorkspaceFile, 'label' | 'content'>;

// Render the Hermes memory files as a single markdown document — one `##`
// heading plus body per memory. An empty list yields a valid empty-state
// document rather than throwing.
export function memoriesToMarkdown(memories: ExportableMemory[]): string {
  if (memories.length === 0) {
    return '# Hermes Memories\n\n_No memories to export._\n';
  }
  const sections = memories.map((memory) => `## ${memory.label}\n\n${memory.content.trim()}\n`);
  return `# Hermes Memories\n\n${sections.join('\n')}`;
}
