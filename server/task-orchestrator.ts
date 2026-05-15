import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ActiveTask {
  cardId: string;
  conversationId: string;
  startedAt: number;
}

export interface OrchestratorStatus {
  enabled: boolean;
  activeTasks: ActiveTask[];
  maxConcurrent: number;
  stats: { completed: number; failed: number; startedAt: number | null };
}

interface CardRecord {
  id: string;
  title: string;
  status: string;
  spec: string;
  acceptanceCriteria: string[];
}

// ─── Orchestrator Singleton ─────────────────────────────────────────────────

const API_BASE = process.env.CLOUDCHAT_API_BASE || 'http://localhost:3001';

const state = {
  activeTasks: new Map<string, ActiveTask>(),
  enabled: false,
  maxConcurrent: Number(process.env.KANBAN_MAX_CONCURRENT_TASKS) || 3,
  pollInterval: Number(process.env.KANBAN_POLL_INTERVAL_MS) || 5000,
  isProcessing: false,
  intervalId: null as ReturnType<typeof setInterval> | null,
  stats: { completed: 0, failed: 0, startedAt: null as number | null },
};

// ─── Card fetcher ──────────────────────────────────────────────────────────

async function fetchCards(status: string): Promise<CardRecord[]> {
  try {
    const res = await fetch(`${API_BASE}/api/hermes/kanban?status=${encodeURIComponent(status)}`);
    if (!res.ok) return [];
    const data = await res.json() as { cards?: CardRecord[] };
    return data.cards ?? [];
  } catch {
    return [];
  }
}

async function updateCardStatus(cardId: string, status: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/hermes/kanban/${cardId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createConversation(title: string, systemPrompt?: string, tags?: string[]): Promise<string | null> {
  const id = randomUUID();
  try {
    const body: Record<string, unknown> = {
      id,
      title,
      provider: 'hermes',
      model: 'default',
      system_prompt: systemPrompt || '',
      tags: tags || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const res = await fetch(`${API_BASE}/functions/v1/chat-store/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? id : null;
  } catch {
    return null;
  }
}

// ─── System prompt builder ─────────────────────────────────────────────────

function buildKanbanTaskPrompt(card: CardRecord): string {
  const lines = [
    'You are working on a Kanban task card. Use the kanban tools to read card details and report progress.',
    '',
    `Title: ${card.title}`,
  ];

  if (card.spec?.trim()) {
    lines.push('', 'Spec:', card.spec.trim());
  }

  if (card.acceptanceCriteria?.length > 0) {
    lines.push('', 'Acceptance criteria:');
    for (const c of card.acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  lines.push(
    '',
    'Available kanban tools:',
    '- kanban_read_current_card — read the full card details and status',
    '- kanban_update_status — update card status (review/blocked/done)',
    '- kanban_append_report — add progress notes',
    '',
    'When you complete the task, call kanban_update_status with status="done" and a report_summary of what was accomplished.',
  );

  return lines.join('\n');
}

// ─── Completion detection ─────────────────────────────────────────────────

async function detectCompletions(): Promise<void> {
  if (state.activeTasks.size === 0) return;

  // Fetch all running cards from the API
  const runningCards = await fetchCards('running');
  const runningIds = new Set(runningCards.map((c) => c.id));

  // Find tracked cards that are no longer running (moved by the agent)
  for (const [cardId, task] of state.activeTasks) {
    if (!runningIds.has(cardId)) {
      // Card was moved out of running by the agent's kanban_update_status call
      state.activeTasks.delete(cardId);

      // Try to determine the final status
      const allCards = await fetchCards('');
      const card = allCards.find((c) => c.id === cardId);
      const finalStatus = card?.status || 'unknown';

      if (finalStatus === 'done') {
        state.stats.completed++;
      } else if (finalStatus === 'blocked') {
        state.stats.failed++;
      }

      console.log(
        `[orchestrator] Card "${cardId.slice(0, 12)}..." completed → ${finalStatus} (freed slot)`,
      );
    }
  }
}

// ─── Poll tick ──────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (state.isProcessing || !state.enabled) return;
  state.isProcessing = true;

  try {
    // Check if any tracked cards have been moved out of 'running' by the agent
    await detectCompletions();

    const readyCards = await fetchCards('ready');
    const available = state.maxConcurrent - state.activeTasks.size;

    if (available <= 0 || readyCards.length === 0) return;

    const toDispatch = readyCards
      .filter((card) => !state.activeTasks.has(card.id))
      .slice(0, available);

    for (const card of toDispatch) {
      try {
        // Build system prompt from card
        const systemPrompt = buildKanbanTaskPrompt(card);

        // Create a conversation to track the task
        const conversationId = await createConversation(
          `[Task] ${card.title}`,
          systemPrompt,
          ['kanban-task'],
        );
        if (!conversationId) {
          console.warn(`[orchestrator] Failed to create conversation for card ${card.id}`);
          continue;
        }

        // Track the task
        state.activeTasks.set(card.id, {
          cardId: card.id,
          conversationId,
          startedAt: Date.now(),
        });

        // Mark card as running
        await updateCardStatus(card.id, 'running');

        console.log(
          `[orchestrator] Dispatched card "${card.title}" (${card.id}) → conversation ${conversationId}`,
        );
      } catch (err) {
        console.error(`[orchestrator] Failed to dispatch card ${card.id}:`, err);
        // Roll back: remove from active tasks, set card back to ready
        state.activeTasks.delete(card.id);
        await updateCardStatus(card.id, 'ready');
      }
    }
  } finally {
    state.isProcessing = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const taskOrchestrator = {
  start(): void {
    if (state.enabled) return;
    state.enabled = true;
    state.stats.startedAt = Date.now();
    state.intervalId = setInterval(() => void tick(), state.pollInterval);
    // Fire first tick immediately
    void tick();
    console.log(`[orchestrator] Started (maxConcurrent=${state.maxConcurrent}, poll=${state.pollInterval}ms)`);
  },

  stop(): void {
    state.enabled = false;
    if (state.intervalId) {
      clearInterval(state.intervalId);
      state.intervalId = null;
    }
    console.log('[orchestrator] Stopped');
  },

  getStatus(): OrchestratorStatus {
    return {
      enabled: state.enabled,
      activeTasks: Array.from(state.activeTasks.values()),
      maxConcurrent: state.maxConcurrent,
      stats: { ...state.stats },
    };
  },

  async dispatchNow(): Promise<{ dispatched: number }> {
    const before = state.activeTasks.size;
    await tick();
    return { dispatched: state.activeTasks.size - before };
  },

  async handleCardCompletion(cardId: string, cardStatus: 'review' | 'done' | 'blocked'): Promise<boolean> {
    const task = state.activeTasks.get(cardId);
    if (!task) return false;

    state.activeTasks.delete(cardId);

    if (cardStatus === 'done') {
      state.stats.completed++;
    } else if (cardStatus === 'blocked') {
      state.stats.failed++;
    }

    return true;
  },

  async cancelTask(cardId: string): Promise<boolean> {
    const task = state.activeTasks.get(cardId);
    if (!task) return false;

    state.activeTasks.delete(cardId);
    await updateCardStatus(cardId, 'ready');
    return true;
  },
};
