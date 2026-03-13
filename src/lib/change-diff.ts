export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  lineNum: number | null;
  content: string;
}

export interface ChangeLineSummary {
  affectedLines: number;
  rangeLabel: string | null;
}

export function countContentLines(content?: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

function getLcsLength(oldLines: string[], newLines: string[]): number {
  if (oldLines.length === 0 || newLines.length === 0) return 0;

  let previous = new Array(newLines.length + 1).fill(0);
  let current = new Array(newLines.length + 1).fill(0);

  for (let oldIndex = 1; oldIndex <= oldLines.length; oldIndex += 1) {
    for (let newIndex = 1; newIndex <= newLines.length; newIndex += 1) {
      current[newIndex] =
        oldLines[oldIndex - 1] === newLines[newIndex - 1]
          ? previous[newIndex - 1] + 1
          : Math.max(previous[newIndex], current[newIndex - 1]);
    }

    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[newLines.length];
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

  if (!change.originalContent) {
    return { added: newLines, removed: 0 };
  }

  const oldContentLines = change.originalContent.split('\n');
  const newContentLines = change.content.split('\n');
  const sharedLines = getLcsLength(oldContentLines, newContentLines);

  return {
    added: newContentLines.length - sharedLines,
    removed: oldContentLines.length - sharedLines,
  };
}

function formatLineRangeLabel(lineNumbers: number[]): string | null {
  if (lineNumbers.length === 0) return null;

  const segments: Array<{ start: number; end: number }> = [];
  let start = lineNumbers[0];
  let end = lineNumbers[0];

  for (let i = 1; i < lineNumbers.length; i += 1) {
    const line = lineNumbers[i];
    if (line === end + 1) {
      end = line;
      continue;
    }
    segments.push({ start, end });
    start = line;
    end = line;
  }

  segments.push({ start, end });

  const visibleSegments = segments.slice(0, 2).map(({ start: segStart, end: segEnd }) =>
    segStart === segEnd ? `L${segStart}` : `L${segStart}-L${segEnd}`,
  );

  if (segments.length > 2) {
    visibleSegments.push(`+${segments.length - 2} more`);
  }

  return visibleSegments.join(', ');
}

export function summarizeChangeLines(change: {
  action: 'create' | 'edit' | 'delete';
  content: string;
  originalContent?: string;
}): ChangeLineSummary {
  const newLines = countContentLines(change.content);
  const oldLines = countContentLines(change.originalContent);

  if (change.action === 'create') {
    return {
      affectedLines: newLines,
      rangeLabel: newLines > 0 ? `L1-L${newLines}` : null,
    };
  }

  if (change.action === 'delete') {
    return {
      affectedLines: oldLines,
      rangeLabel: oldLines > 0 ? `L1-L${oldLines}` : null,
    };
  }

  if (!change.originalContent) {
    const fallback = Math.max(newLines, oldLines);
    return {
      affectedLines: fallback,
      rangeLabel: fallback > 0 ? `L1-L${fallback}` : null,
    };
  }

  if (newLines + oldLines > 2000) {
    const { added, removed } = getChangeLineDelta(change);
    return {
      affectedLines: added + removed,
      rangeLabel: null,
    };
  }

  const lineNumbers = Array.from(
    new Set(
      computeDiffLines(change.originalContent, change.content, 0)
        .filter((line) => line.type !== 'context' && line.lineNum !== null)
        .map((line) => line.lineNum as number),
    ),
  ).sort((a, b) => a - b);

  if (lineNumbers.length === 0) {
    return { affectedLines: 0, rangeLabel: null };
  }

  return {
    affectedLines: lineNumbers.length,
    rangeLabel: formatLineRangeLabel(lineNumbers),
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
