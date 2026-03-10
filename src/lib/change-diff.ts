export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  lineNum: number | null;
  content: string;
}

export function countContentLines(content?: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

export function getChangeLineDelta(change: {
  action: 'create' | 'edit' | 'delete';
  content: string;
  originalContent?: string;
}): { added: number; removed: number } {
  const newLines = countContentLines(change.content);
  const oldLines = countContentLines(change.originalContent);

  if (change.action === 'create') {
    return { added: newLines, removed: 0 };
  }

  if (change.action === 'delete') {
    return { added: 0, removed: oldLines };
  }

  return {
    added: Math.max(0, newLines - oldLines),
    removed: Math.max(0, oldLines - newLines),
  };
}

export function computeDiffLines(oldText: string, newText: string, contextLines = 2): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  if (m + n > 2000) {
    return newLines.slice(0, 20).map((line, i) => ({
      type: 'added' as const,
      lineNum: i + 1,
      content: line,
    }));
  }

  const dp = new Array(m + 1).fill(null).map(() => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const rawDiff: Array<{ type: 'equal' | 'added' | 'removed'; line: string; oldIdx: number; newIdx: number }> = [];
  let i = 0;
  let j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      rawDiff.push({ type: 'equal', line: oldLines[i], oldIdx: i, newIdx: j });
      i += 1;
      j += 1;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      rawDiff.push({ type: 'added', line: newLines[j], oldIdx: i, newIdx: j });
      j += 1;
    } else if (i < m) {
      rawDiff.push({ type: 'removed', line: oldLines[i], oldIdx: i, newIdx: j });
      i += 1;
    }
  }

  const changedIndices = new Set<number>();
  rawDiff.forEach((diff, idx) => {
    if (diff.type === 'equal') return;
    for (let k = Math.max(0, idx - contextLines); k <= Math.min(rawDiff.length - 1, idx + contextLines); k += 1) {
      changedIndices.add(k);
    }
  });

  const result: DiffLine[] = [];
  let lastIncluded = -1;

  rawDiff.forEach((diff, idx) => {
    if (!changedIndices.has(idx)) return;

    if (lastIncluded !== -1 && idx - lastIncluded > 1) {
      result.push({ type: 'context', lineNum: null, content: '···' });
    }

    if (diff.type === 'equal') {
      result.push({ type: 'context', lineNum: diff.newIdx + 1, content: diff.line });
    } else if (diff.type === 'added') {
      result.push({ type: 'added', lineNum: diff.newIdx + 1, content: diff.line });
    } else {
      result.push({ type: 'removed', lineNum: diff.oldIdx + 1, content: diff.line });
    }

    lastIncluded = idx;
  });

  return result;
}
