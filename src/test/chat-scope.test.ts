import { describe, it, expect } from 'vitest';
import { getChatScopeId } from '@/lib/chat-scope';

describe('getChatScopeId', () => {
  it('returns conversationId when it is a non-empty string', () => {
    expect(getChatScopeId('panel-1', 'conv-abc')).toBe('conv-abc');
  });

  it('returns panelId when conversationId is null', () => {
    expect(getChatScopeId('panel-1', null)).toBe('panel-1');
  });

  it('returns panelId when conversationId is undefined', () => {
    expect(getChatScopeId('panel-1', undefined)).toBe('panel-1');
  });

  it('returns panelId when conversationId is an empty string', () => {
    expect(getChatScopeId('panel-1', '')).toBe('panel-1');
  });

  it('returns panelId when conversationId is whitespace-only', () => {
    expect(getChatScopeId('panel-1', '   ')).toBe('panel-1');
  });
});
