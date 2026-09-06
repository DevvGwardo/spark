import { describe, expect, it } from 'vitest';
import {
  extractToolActivityLabel,
  getRunningToolLabel,
  getToolInvocationKey,
  getToolPathArg,
  normalizeToolName,
} from '@/lib/tool-activity';

describe('getToolPathArg', () => {
  it('reads ACP aliases (file_path, file, pattern, command)', () => {
    expect(getToolPathArg({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(getToolPathArg({ file: 'src/b.ts' })).toBe('src/b.ts');
    expect(getToolPathArg({ filePath: 'src/c.ts' })).toBe('src/c.ts');
    expect(getToolPathArg({ pattern: 'useState' })).toBe('useState');
    expect(getToolPathArg({ command: 'npm test' })).toBe('npm test');
    expect(getToolPathArg({ path: 'src/d.ts' })).toBe('src/d.ts');
    expect(getToolPathArg({})).toBeUndefined();
    expect(getToolPathArg(null)).toBeUndefined();
  });
});

describe('normalizeToolName', () => {
  it('unifies ACP titles with SDK names', () => {
    expect(normalizeToolName('read')).toBe('read_file');
    expect(normalizeToolName('read_repo_file')).toBe('read_file');
    expect(normalizeToolName('search')).toBe('search_files');
    expect(normalizeToolName('shell')).toBe('terminal');
    expect(normalizeToolName('run_command')).toBe('terminal');
  });

  it('strips hermes title prefixes (live bridge sends titles as names)', () => {
    expect(normalizeToolName('read: /Users/devgwardo/.cloudchat/repos/DevvGwardo/grok-glm-flash/package.json')).toBe(
      'read_file',
    );
    expect(normalizeToolName('search: useState')).toBe('search_files');
    expect(normalizeToolName('terminal: npm test')).toBe('terminal');
    expect(normalizeToolName('write: src/a.ts')).toBe('edit');
  });
});

describe('getToolInvocationKey', () => {
  it('keys ACP file_path calls distinctly from empty calls', () => {
    const a = getToolInvocationKey({ toolName: 'read', args: { file_path: 'src/a.ts' } }, 0);
    const b = getToolInvocationKey({ toolName: 'read', args: { file_path: 'src/b.ts' } }, 1);
    expect(a).not.toBe(b);
    expect(a).toContain('src/a.ts');
  });

  it('distinguishes terminal calls by command instead of collapsing', () => {
    const a = getToolInvocationKey({ toolName: 'terminal', args: { command: 'ls' } }, 0);
    const b = getToolInvocationKey({ toolName: 'terminal', args: { command: 'pwd' } }, 0);
    expect(a).not.toBe(b);
  });
});

describe('extractToolActivityLabel / getRunningToolLabel', () => {
  it('labels ACP search + read shapes', () => {
    expect(extractToolActivityLabel('search_files', '{"pattern":"useState","path":"src"}')).toBe('useState');
    expect(getRunningToolLabel({ tool: 'read', input: '{"file_path":"src/a.ts"}' })).toBe('Reading src/a.ts');
    expect(getRunningToolLabel({ tool: 'search_files', input: '{"pattern":"useState","path":"src"}' })).toBe(
      'Searching useState',
    );
    expect(getRunningToolLabel({ tool: 'shell', input: '{"command":"npm test"}' })).toBe('Running npm test');
  });

  it('labels live hermes titles without duplicating the path', () => {
    expect(
      getRunningToolLabel({
        tool: 'read: /Users/devgwardo/.cloudchat/repos/DevvGwardo/grok-glm-flash/package.json',
        input: '{"path": "/Users/devgwardo/.cloudchat/repos/DevvGwardo/grok-glm-flash/package.json"}',
      }),
    ).toBe('Reading grok-glm-flash/package.json');
    expect(getRunningToolLabel({ tool: 'search: useState', input: '{"pattern":"useState","path":"src"}' })).toBe(
      'Searching useState',
    );
  });
});
