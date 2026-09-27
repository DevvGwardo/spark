// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  PERMISSION_MODE_IDS,
  getPermissionModeSpec,
  isPermissionMode,
  isReadOnlyMode,
  resolvePermissionMode,
  shouldAutoApprove,
  type PermissionMode,
} from '../lib/permission-modes';

const ALL_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'];

const EXPECTED_FLAGS: Record<
  PermissionMode,
  { readOnly: boolean; autoApproveEdits: boolean; autoApproveAll: boolean; hasPrompt: boolean }
> = {
  default: { readOnly: false, autoApproveEdits: false, autoApproveAll: false, hasPrompt: false },
  plan: { readOnly: true, autoApproveEdits: false, autoApproveAll: false, hasPrompt: true },
  acceptEdits: { readOnly: false, autoApproveEdits: true, autoApproveAll: false, hasPrompt: true },
  bypassPermissions: { readOnly: false, autoApproveEdits: true, autoApproveAll: true, hasPrompt: true },
  dontAsk: { readOnly: false, autoApproveEdits: true, autoApproveAll: true, hasPrompt: true },
};

describe('permission modes: spec flags per mode', () => {
  for (const mode of ALL_MODES) {
    it(`has the contract flags for '${mode}'`, () => {
      const spec = PERMISSION_MODES[mode];
      const expected = EXPECTED_FLAGS[mode];

      expect(spec.id).toBe(mode);
      expect(spec.readOnly).toBe(expected.readOnly);
      expect(spec.autoApproveEdits).toBe(expected.autoApproveEdits);
      expect(spec.autoApproveAll).toBe(expected.autoApproveAll);

      if (expected.hasPrompt) {
        expect(typeof spec.prompt).toBe('string');
        expect((spec.prompt as string).length).toBeGreaterThan(0);
      } else {
        expect(spec.prompt).toBeNull();
      }
    });

    it(`has a non-empty label and description for '${mode}'`, () => {
      const spec = PERMISSION_MODES[mode];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    });
  }

  it('exposes every mode in PERMISSION_MODES (no missing, no extras)', () => {
    expect(Object.keys(PERMISSION_MODES).sort()).toEqual([...ALL_MODES].sort());
  });
});

describe('PERMISSION_MODE_IDS', () => {
  it('is in the stable display order', () => {
    expect(PERMISSION_MODE_IDS).toEqual([
      'default',
      'plan',
      'acceptEdits',
      'bypassPermissions',
      'dontAsk',
    ]);
  });
});

describe('DEFAULT_PERMISSION_MODE', () => {
  it('is the default mode id', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('default');
  });
});

describe('isPermissionMode', () => {
  it('accepts every valid mode id', () => {
    for (const mode of ALL_MODES) {
      expect(isPermissionMode(mode)).toBe(true);
    }
  });

  it('rejects non-string input', () => {
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode(0)).toBe(false);
    expect(isPermissionMode(1)).toBe(false);
    expect(isPermissionMode(true)).toBe(false);
    expect(isPermissionMode(false)).toBe(false);
    expect(isPermissionMode({ id: 'plan' })).toBe(false);
    expect(isPermissionMode(['plan'])).toBe(false);
  });

  it('rejects invalid and lookalike strings', () => {
    expect(isPermissionMode('')).toBe(false);
    expect(isPermissionMode('PLAN')).toBe(false);
    expect(isPermissionMode('plan-mode')).toBe(false);
    expect(isPermissionMode('accept_edits')).toBe(false);
    expect(isPermissionMode('bypass')).toBe(false);
    expect(isPermissionMode('dontask')).toBe(false);
  });

  it('narrows the type for valid input', () => {
    const value: unknown = 'plan';
    if (isPermissionMode(value)) {
      // value must be assignable to PermissionMode here.
      const mode: PermissionMode = value;
      expect(mode).toBe('plan');
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });
});

describe('resolvePermissionMode', () => {
  it('returns the explicit permissionMode when it is valid', () => {
    for (const mode of ALL_MODES) {
      expect(resolvePermissionMode({ permissionMode: mode })).toBe(mode);
    }
  });

  it('maps legacy planMode:true to plan', () => {
    expect(resolvePermissionMode({ planMode: true })).toBe('plan');
    expect(resolvePermissionMode({ permissionMode: undefined, planMode: true })).toBe('plan');
  });

  it('returns default when planMode is false', () => {
    expect(resolvePermissionMode({ planMode: false })).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ permissionMode: undefined, planMode: false })).toBe(
      DEFAULT_PERMISSION_MODE,
    );
  });

  it('a valid explicit permissionMode wins over planMode:true', () => {
    expect(resolvePermissionMode({ permissionMode: 'bypassPermissions', planMode: true })).toBe(
      'bypassPermissions',
    );
    expect(resolvePermissionMode({ permissionMode: 'default', planMode: true })).toBe('default');
    expect(resolvePermissionMode({ permissionMode: 'dontAsk', planMode: true })).toBe('dontAsk');
  });

  it('ignores an invalid permissionMode and falls through to planMode', () => {
    expect(resolvePermissionMode({ permissionMode: 'nope', planMode: true })).toBe('plan');
    expect(resolvePermissionMode({ permissionMode: 42, planMode: true })).toBe('plan');
    expect(resolvePermissionMode({ permissionMode: null, planMode: true })).toBe('plan');
  });

  it('only boolean-true planMode triggers plan (truthy-but-not-true does not)', () => {
    expect(resolvePermissionMode({ planMode: 1 })).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ planMode: 'true' })).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ planMode: {} })).toBe(DEFAULT_PERMISSION_MODE);
  });

  it('falls back to default for garbage / empty input', () => {
    expect(resolvePermissionMode({})).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ permissionMode: 'nope', planMode: 'maybe' })).toBe(
      DEFAULT_PERMISSION_MODE,
    );
    expect(resolvePermissionMode({ permissionMode: 42, planMode: 1 })).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ permissionMode: null, planMode: null })).toBe(
      DEFAULT_PERMISSION_MODE,
    );
    expect(resolvePermissionMode({ permissionMode: undefined, planMode: undefined })).toBe(
      DEFAULT_PERMISSION_MODE,
    );
  });

  it('never throws on weird input', () => {
    expect(() => resolvePermissionMode({})).not.toThrow();
    expect(() => resolvePermissionMode({ permissionMode: undefined })).not.toThrow();
    expect(() =>
      resolvePermissionMode({ permissionMode: { toString: () => 'plan' }, planMode: [] }),
    ).not.toThrow();
  });
});

describe('isReadOnlyMode', () => {
  it('is true only for plan', () => {
    expect(isReadOnlyMode('plan')).toBe(true);
    expect(isReadOnlyMode('default')).toBe(false);
    expect(isReadOnlyMode('acceptEdits')).toBe(false);
    expect(isReadOnlyMode('bypassPermissions')).toBe(false);
    expect(isReadOnlyMode('dontAsk')).toBe(false);
  });
});

describe('shouldAutoApprove', () => {
  const cases: Array<{ mode: PermissionMode; kind: 'edit' | 'command' | 'other'; expected: boolean }> = [
    { mode: 'default', kind: 'edit', expected: false },
    { mode: 'default', kind: 'command', expected: false },
    { mode: 'default', kind: 'other', expected: false },
    { mode: 'plan', kind: 'edit', expected: false },
    { mode: 'plan', kind: 'command', expected: false },
    { mode: 'plan', kind: 'other', expected: false },
    { mode: 'acceptEdits', kind: 'edit', expected: true },
    { mode: 'acceptEdits', kind: 'command', expected: false },
    { mode: 'acceptEdits', kind: 'other', expected: false },
    { mode: 'bypassPermissions', kind: 'edit', expected: true },
    { mode: 'bypassPermissions', kind: 'command', expected: true },
    { mode: 'bypassPermissions', kind: 'other', expected: true },
    { mode: 'dontAsk', kind: 'edit', expected: true },
    { mode: 'dontAsk', kind: 'command', expected: true },
    { mode: 'dontAsk', kind: 'other', expected: true },
  ];

  for (const { mode, kind, expected } of cases) {
    it(`shouldAutoApprove('${mode}', '${kind}') === ${expected}`, () => {
      expect(shouldAutoApprove(mode, kind)).toBe(expected);
    });
  }
});

describe('getPermissionModeSpec', () => {
  it('returns the spec whose id matches the requested mode', () => {
    for (const mode of ALL_MODES) {
      expect(getPermissionModeSpec(mode).id).toBe(mode);
    }
  });
});

describe('plan mode prompt (verbatim contract)', () => {
  it('still contains the PLAN MODE marker', () => {
    const prompt = getPermissionModeSpec('plan').prompt;
    expect(prompt).not.toBeNull();
    expect(prompt as string).toContain('PLAN MODE');
  });

  it('still contains the ## Implementation Plan header marker', () => {
    const prompt = getPermissionModeSpec('plan').prompt;
    expect(prompt as string).toContain('## Implementation Plan');
  });

  it('keeps the read-only tool restrictions intact', () => {
    const prompt = getPermissionModeSpec('plan').prompt as string;
    expect(prompt).toContain('write_file, patch, or execute_code');
    expect(prompt).toContain('Do NOT use shell redirects');
  });
});
