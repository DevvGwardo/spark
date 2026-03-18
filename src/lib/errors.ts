function formatPathLabel(path: unknown[]): string {
  if (path.length >= 2 && path[0] === 'changes' && typeof path[1] === 'number') {
    const changeNumber = path[1] + 1;
    const field = typeof path[path.length - 1] === 'string' ? path[path.length - 1] : null;
    return field ? `change ${changeNumber} → ${field}` : `change ${changeNumber}`;
  }

  return path
    .map((segment) => (typeof segment === 'number' ? String(segment + 1) : String(segment)))
    .join(' → ');
}

function parseToolValidationError(message: string): string | null {
  const toolMatch = message.match(/^Invalid arguments for tool\s+([a-zA-Z0-9_]+):/);
  if (!toolMatch) {
    return null;
  }

  const toolName = toolMatch[1];
  const issuesMatch = message.match(/Error message:\s*(\[[\s\S]*\])$/);
  if (!issuesMatch) {
    return `Invalid arguments for ${toolName}. The model sent malformed tool input.`;
  }

  try {
    const issues = JSON.parse(issuesMatch[1]) as Array<{
      code?: string;
      expected?: string;
      received?: string;
      path?: unknown[];
      message?: string;
    }>;

    if (!Array.isArray(issues) || issues.length === 0) {
      return `Invalid arguments for ${toolName}. The model sent malformed tool input.`;
    }

    const missingFieldsByChange = new Map<number, string[]>();
    const genericIssues: string[] = [];

    for (const issue of issues) {
      const path = Array.isArray(issue.path) ? issue.path : [];
      if (
        issue.code === 'invalid_type' &&
        issue.received === 'undefined' &&
        path[0] === 'changes' &&
        typeof path[1] === 'number' &&
        typeof path[path.length - 1] === 'string'
      ) {
        const changeIndex = path[1];
        const field = path[path.length - 1] as string;
        const existing = missingFieldsByChange.get(changeIndex) ?? [];
        if (!existing.includes(field)) {
          existing.push(field);
        }
        missingFieldsByChange.set(changeIndex, existing);
        continue;
      }

      genericIssues.push(
        `${formatPathLabel(path)}${issue.message ? `: ${issue.message}` : ''}`.trim(),
      );
    }

    const summaries: string[] = [];

    for (const [changeIndex, fields] of [...missingFieldsByChange.entries()].sort((a, b) => a[0] - b[0])) {
      summaries.push(`change ${changeIndex + 1} is missing ${fields.join(', ')}`);
    }

    summaries.push(...genericIssues.slice(0, 2));

    if (summaries.length === 0) {
      return `Invalid arguments for ${toolName}. The model sent malformed tool input.`;
    }

    return `Invalid arguments for ${toolName}. ${summaries.join('; ')}.`;
  } catch {
    return `Invalid arguments for ${toolName}. The model sent malformed tool input.`;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message && error.message !== '[object Object]') {
      return getErrorMessage(error.message);
    }

    if ('cause' in error && error.cause) {
      return getErrorMessage(error.cause);
    }
  }

  if (typeof error === 'string') {
    const trimmed = error.trim();
    if (!trimmed) {
      return 'Unknown error';
    }

    if (trimmed === '[object Object]') {
      return 'The provider returned a structured error object without a readable message.';
    }

    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return getErrorMessage(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }

    const toolValidationMessage = parseToolValidationError(trimmed);
    if (toolValidationMessage) {
      return toolValidationMessage;
    }

    return trimmed;
  }

  if (Array.isArray(error)) {
    const parts = error
      .map((item) => getErrorMessage(item))
      .filter((item) => item && item !== 'Unknown error');
    return parts[0] || 'Unknown error';
  }

  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    const nestedKeys = ['message', 'error', 'detail', 'details', 'cause', 'statusText'];
    for (const key of nestedKeys) {
      if (candidate[key] !== undefined && candidate[key] !== error) {
        const nested = getErrorMessage(candidate[key]);
        if (nested && nested !== 'Unknown error') {
          return nested;
        }
      }
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}' && serialized !== '[]') {
        return serialized;
      }
    } catch (err) {
      console.warn('[errors] Failed to JSON.stringify error object', err);
    }
  }

  return 'Unknown error';
}
