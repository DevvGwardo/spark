// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildOutputStylePrompt,
  DEFAULT_OUTPUT_STYLE,
  getOutputStyleSpec,
  isOutputStyle,
  OUTPUT_STYLE_IDS,
  OUTPUT_STYLES,
  resolveOutputStyle,
  type OutputStyle,
} from '../lib/output-styles';

describe('output styles: structure', () => {
  it('exposes exactly the four styles in OUTPUT_STYLES', () => {
    expect(Object.keys(OUTPUT_STYLES).sort()).toEqual(
      ['concise', 'default', 'explanatory', 'learning'],
    );
  });

  it('exposes OUTPUT_STYLE_IDS in the stable canonical order', () => {
    expect(OUTPUT_STYLE_IDS).toEqual([
      'default',
      'explanatory',
      'concise',
      'learning',
    ]);
  });

  it('every OUTPUT_STYLE_IDS entry has a matching spec in OUTPUT_STYLES', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      expect(OUTPUT_STYLES[id].id).toBe(id);
    }
  });

  it('DEFAULT_OUTPUT_STYLE is "default"', () => {
    expect(DEFAULT_OUTPUT_STYLE).toBe('default');
  });
});

describe('output styles: spec fields', () => {
  it('default has null prompt and turnReminder', () => {
    const spec = OUTPUT_STYLES.default;
    expect(spec.prompt).toBeNull();
    expect(spec.turnReminder).toBeNull();
  });

  it('every non-default style has a non-empty prompt and turnReminder', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      if (id === 'default') continue;
      const spec = OUTPUT_STYLES[id];
      expect(typeof spec.prompt).toBe('string');
      expect(spec.prompt!.length).toBeGreaterThan(0);
      expect(typeof spec.turnReminder).toBe('string');
      expect(spec.turnReminder!.length).toBeGreaterThan(0);
    }
  });

  it('every style has a non-empty label and description', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      const spec = OUTPUT_STYLES[id];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('concise description states it responds tersely, leading with results and skipping preamble and narration', () => {
    const desc = OUTPUT_STYLES.concise.description.toLowerCase();
    expect(desc).toContain('tersely');
    expect(desc).toContain('leading with results');
    expect(desc).toContain('preamble');
    expect(desc).toContain('narration');
  });

  it('each non-default style has a distinct turnReminder', () => {
    const reminders: OutputStyle[] = ['explanatory', 'concise', 'learning'];
    const texts = reminders.map((id) => OUTPUT_STYLES[id].turnReminder);
    expect(new Set(texts).size).toBe(3);
  });
});

describe('output styles: prompts are distinct', () => {
  it('concise genuinely differs from explanatory and learning', () => {
    const concise = OUTPUT_STYLES.concise.prompt;
    const explanatory = OUTPUT_STYLES.explanatory.prompt;
    const learning = OUTPUT_STYLES.learning.prompt;
    expect(concise).not.toBe(explanatory);
    expect(concise).not.toBe(learning);
    expect(explanatory).not.toBe(learning);
  });
});

describe('isOutputStyle', () => {
  it('accepts each valid id', () => {
    expect(isOutputStyle('default')).toBe(true);
    expect(isOutputStyle('explanatory')).toBe(true);
    expect(isOutputStyle('concise')).toBe(true);
    expect(isOutputStyle('learning')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isOutputStyle('verbose')).toBe(false);
    expect(isOutputStyle('DEFAULT')).toBe(false);
    expect(isOutputStyle('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isOutputStyle(null)).toBe(false);
    expect(isOutputStyle(undefined)).toBe(false);
    expect(isOutputStyle(42)).toBe(false);
    expect(isOutputStyle({ id: 'concise' })).toBe(false);
    expect(isOutputStyle(['concise'])).toBe(false);
    expect(isOutputStyle(true)).toBe(false);
  });
});

describe('resolveOutputStyle', () => {
  it('returns the value when valid', () => {
    expect(resolveOutputStyle('default')).toBe('default');
    expect(resolveOutputStyle('explanatory')).toBe('explanatory');
    expect(resolveOutputStyle('concise')).toBe('concise');
    expect(resolveOutputStyle('learning')).toBe('learning');
  });

  it('falls back to DEFAULT_OUTPUT_STYLE for unknown strings', () => {
    expect(resolveOutputStyle('verbose')).toBe(DEFAULT_OUTPUT_STYLE);
    expect(resolveOutputStyle('')).toBe(DEFAULT_OUTPUT_STYLE);
  });

  it('falls back to DEFAULT_OUTPUT_STYLE for null', () => {
    expect(resolveOutputStyle(null)).toBe(DEFAULT_OUTPUT_STYLE);
  });

  it('falls back to DEFAULT_OUTPUT_STYLE for undefined', () => {
    expect(resolveOutputStyle(undefined)).toBe(DEFAULT_OUTPUT_STYLE);
  });

  it('falls back to DEFAULT_OUTPUT_STYLE for objects', () => {
    expect(resolveOutputStyle({ id: 'concise' })).toBe(DEFAULT_OUTPUT_STYLE);
    expect(resolveOutputStyle({})).toBe(DEFAULT_OUTPUT_STYLE);
  });

  it('falls back to DEFAULT_OUTPUT_STYLE for numbers', () => {
    expect(resolveOutputStyle(0)).toBe(DEFAULT_OUTPUT_STYLE);
    expect(resolveOutputStyle(42)).toBe(DEFAULT_OUTPUT_STYLE);
  });

  it('never throws', () => {
    expect(() => resolveOutputStyle(null)).not.toThrow();
    expect(() => resolveOutputStyle(undefined)).not.toThrow();
    expect(() => resolveOutputStyle({})).not.toThrow();
    expect(() => resolveOutputStyle(Symbol('x'))).not.toThrow();
  });
});

describe('getOutputStyleSpec', () => {
  it('returns the matching spec for each id', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      expect(getOutputStyleSpec(id)).toBe(OUTPUT_STYLES[id]);
    }
  });

  it('default spec has null prompt/turnReminder', () => {
    const spec = getOutputStyleSpec('default');
    expect(spec.prompt).toBeNull();
    expect(spec.turnReminder).toBeNull();
  });
});

describe('buildOutputStylePrompt', () => {
  it('returns null for default', () => {
    expect(buildOutputStylePrompt('default')).toBeNull();
  });

  it('returns a non-null, non-empty block for each non-default style', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      if (id === 'default') continue;
      const block = buildOutputStylePrompt(id);
      expect(block).not.toBeNull();
      expect(block!.length).toBeGreaterThan(0);
    }
  });

  it('the block contains the turnReminder for each non-default style', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      if (id === 'default') continue;
      const block = buildOutputStylePrompt(id);
      const reminder = OUTPUT_STYLES[id].turnReminder!;
      expect(block).toContain(reminder);
    }
  });

  it('the block contains the prompt for each non-default style', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      if (id === 'default') continue;
      const block = buildOutputStylePrompt(id);
      const prompt = OUTPUT_STYLES[id].prompt!;
      expect(block).toContain(prompt);
    }
  });

  it('prompt and turnReminder are separated by a blank line', () => {
    for (const id of OUTPUT_STYLE_IDS) {
      if (id === 'default') continue;
      const block = buildOutputStylePrompt(id);
      expect(block).toContain('\n\n');
    }
  });
});
