import { abortAfter, hermesFetch } from './core';

export interface HermesUsageModelBreakdown {
  model: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface HermesUsageDay {
  day: string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface HermesUsageOverview {
  state_db_available: boolean;
  session_count: number;
  message_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  first_session_started_at: string | null;
  last_session_started_at: string | null;
  top_models: HermesUsageModelBreakdown[];
  recent_days: HermesUsageDay[];
}

export async function fetchInsights(days = 7): Promise<{ ok: boolean; days: number; report: string }> {
  return hermesFetch(`/insights?days=${days}`, {
    signal: abortAfter(60_000),
  });
}

export async function fetchHermesWorkspaceUsage(): Promise<HermesUsageOverview> {
  return hermesFetch<HermesUsageOverview>('/workspace/usage');
}
