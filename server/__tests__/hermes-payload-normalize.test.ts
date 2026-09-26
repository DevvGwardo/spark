// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeHermesAgentLoopPayload } from '../lib/hermes';

describe('normalizeHermesAgentLoopPayload', () => {
  it('passes through approval_request events from the ACP transport', () => {
    const payload = JSON.stringify({
      id: 'chatcmpl-acp-test',
      choices: [{
        index: 0,
        delta: {
          approval_request: {
            approval_id: 'acp-123-1',
            session_id: 'sess-1',
            tool: 'Approve edit: /tmp/x.txt',
            kind: 'edit',
            summary: 'Approve edit: /tmp/x.txt',
            excerpt: '{"tool":"write_file","arguments":{}}',
            options: [{ option_id: 'allow_once', name: 'Allow edit' }, { option_id: 'deny', name: 'Deny' }],
          },
        },
        finish_reason: null,
      }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    const approval = normalized!.data!.find((d) => d.type === 'approval_request');
    expect(approval).toBeDefined();
    expect(approval).toMatchObject({
      type: 'approval_request',
      approval_id: 'acp-123-1',
      tool: 'Approve edit: /tmp/x.txt',
    });
  });

  it('passes through tool_activity and agent_status unchanged', () => {
    const payload = JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_activity: { tool: 'terminal: ls', status: 'running', input: '', output: null },
          agent_status: { phase: 'starting', label: 'Starting', elapsed_ms: 0 },
        },
        finish_reason: null,
      }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    const tool = normalized!.data!.find((d) => d.type === 'hermes_tool_activity');
    expect(tool).toMatchObject({ type: 'hermes_tool_activity', activity: { tool: 'terminal: ls', status: 'running' } });
    const status = normalized!.data!.find((d) => d.type === 'agent_status');
    expect(status).toMatchObject({ type: 'agent_status', status: { phase: 'starting' } });
  });

  it('returns null on malformed JSON', () => {
    expect(normalizeHermesAgentLoopPayload('not-json')).toBeNull();
  });

  it('passes through tool_call_begin/delta/end, stream_retry and plan_update unchanged', () => {
    const payload = JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_call_begin: { call_id: 'call-1', name: 'terminal', ts: 1712345678901 },
          tool_call_delta: { call_id: 'call-1', output: 'partial output' },
          tool_call_end: {
            call_id: 'call-1',
            name: 'terminal',
            success: true,
            exit_code: 0,
            duration_ms: 42,
            output_truncated: true,
            output_truncated_lines: 3,
          },
          stream_retry: { attempt: 2, max_attempts: 3, reason: 'timeout', delay_ms: 500 },
          plan_update: { steps: [{ step: 1, status: 'in_progress' }] },
        },
        finish_reason: null,
      }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    const data = normalized!.data!;

    expect(data.find((d) => d.type === 'tool_call_begin')).toMatchObject({
      type: 'tool_call_begin',
      call_id: 'call-1',
      name: 'terminal',
      ts: 1712345678901,
    });
    expect(data.find((d) => d.type === 'tool_call_delta')).toMatchObject({
      type: 'tool_call_delta',
      call_id: 'call-1',
      output: 'partial output',
    });
    expect(data.find((d) => d.type === 'tool_call_end')).toMatchObject({
      type: 'tool_call_end',
      call_id: 'call-1',
      name: 'terminal',
      success: true,
      exit_code: 0,
      duration_ms: 42,
      output_truncated: true,
      output_truncated_lines: 3,
    });
    expect(data.find((d) => d.type === 'stream_retry')).toMatchObject({
      type: 'stream_retry',
      attempt: 2,
      max_attempts: 3,
      reason: 'timeout',
      delay_ms: 500,
    });
    expect(data.find((d) => d.type === 'plan_update')).toMatchObject({
      type: 'plan_update',
      steps: [{ step: 1, status: 'in_progress' }],
    });
  });

  it('passes through new fields at the top level of the SSE payload too', () => {
    const payload = JSON.stringify({
      tool_call_begin: { call_id: 'top-1', name: 'read_file', ts: 1 },
      stream_retry: { attempt: 1, max_attempts: 2, reason: 'retry', delay_ms: 100 },
      choices: [{ index: 0, delta: {}, finish_reason: null }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    const data = normalized!.data!;
    expect(data.find((d) => d.type === 'tool_call_begin')).toMatchObject({ type: 'tool_call_begin', call_id: 'top-1' });
    expect(data.find((d) => d.type === 'stream_retry')).toMatchObject({ type: 'stream_retry', attempt: 1 });
  });

  it('passes through the extended approval_request fields including available_decisions', () => {
    const payload = JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          approval_request: {
            approval_id: 'acp-456',
            tool: 'run_command',
            command: 'npm install',
            cwd: '/workspace',
            reason: 'Install dependencies',
            available_decisions: ['approved', 'approved_for_session', 'denied', 'timed_out', 'abort'],
          },
        },
        finish_reason: null,
      }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    const approval = normalized!.data!.find((d) => d.type === 'approval_request');
    expect(approval).toMatchObject({
      type: 'approval_request',
      approval_id: 'acp-456',
      tool: 'run_command',
      command: 'npm install',
      cwd: '/workspace',
      reason: 'Install dependencies',
      available_decisions: ['approved', 'approved_for_session', 'denied', 'timed_out', 'abort'],
    });
  });

  it('captures cached tokens from usage payloads', () => {
    const payload = JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 60 },
      },
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
    });

    const normalized = normalizeHermesAgentLoopPayload(payload);
    expect(normalized).not.toBeNull();
    expect(normalized!.usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 60,
    });
  });
});
