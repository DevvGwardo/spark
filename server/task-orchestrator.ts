import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { teamCoordinator } from './team-coordinator';
import { analyzeTask } from './team-formation';

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
};

export type QueueCardStatus = 'queued' | 'running' | 'done' | 'review' | 'blocked' | 'failed';

export interface QueueCard {
  id: string;
  title: string;
  spec: string;
  acceptanceCriteria: string[];
  assignedWorker: string | null;
  status: QueueCardStatus;
  startedAt?: number;
  completedAt?: number;
  reportSummary?: string;
}

export interface QueueState {
  queued: QueueCard[];
  running: QueueCard[];
  completed: QueueCard[];
  stats: { completed: number; failed: number };
  enabled: boolean;
}

interface CardRecord {
  id: string;
  title: string;
  status: string;
  spec: string;
  acceptanceCriteria: string[];
  teamMode?: boolean;
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
      systemPrompt: systemPrompt || '',
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

        // Mark card as running BEFORE dispatch to prevent TOCTOU races
        // (another tick picking up the same card while dispatch is in flight)
        await updateCardStatus(card.id, 'running');

        console.log(
          `[orchestrator] Dispatched card "${card.title}" (${card.id}) → conversation ${conversationId}`,
        );

        // Check if this card should use team dispatch
        const taskText = `${card.title} ${card.spec ?? ''}`;
        const formation = analyzeTask(taskText, []);
        if (card.teamMode || formation.strategy !== 'single_agent') {
          console.log(`[orchestrator] Card "${card.title}" qualifies for team dispatch (strategy=${formation.strategy}, reason="${formation.reason}")`);
          void dispatchAsTeam(card).catch((err) => {
            console.error(`[orchestrator] Team dispatch failed for card ${card.id}, reverting:`, err);
            state.activeTasks.delete(card.id);
            updateCardStatus(card.id, 'ready').catch(() => {});
          });
        } else {
          // Spawn background agent process
          if (!card.id) {
            console.warn(`[orchestrator] Cannot spawn agent: missing card ID`);
          } else {
            void spawnKanbanAgent(card.id);
          }
        }
      } catch (err) {
        console.error(`[orchestrator] Failed to dispatch card ${card.id}:`, err);
        // Roll back: remove from active tasks, set card back to ready
        state.activeTasks.delete(card.id);
        await updateCardStatus(card.id, 'ready').catch(() => {});
      }
    }
  } finally {
    state.isProcessing = false;
  }
}

// ─── Background agent runner ────────────────────────────────────────────────

// Resolve scripts directory relative to project root. Works for both tsx (live)
// and bundled Electron (where import.meta.url points to out/main/index.js).
const SCRIPTS_DIR = (() => {
  // Check if we're running from source (tsx) or bundle (Electron)
  const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts');
  if (fs.existsSync(sourceDir)) return sourceDir;
  // Fallback: bundle path — go up from out/main/ to project root
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'scripts');
})();

/**
 * Spawn a background kanban agent process for a specific card.
 * The agent runs via the Python runner script which loads AIAgent from
 * the hermes-agent and processes the card autonomously.
 * The agent uses kanban_tools (kanban_read_current_card, kanban_update_status,
 * kanban_append_report) to report progress back to the kanban API.
 */
async function spawnKanbanAgent(cardId: string): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const venvDir = process.env.HERMES_BRIDGE_VENV || (() => {
    const candidates = [
      path.join(repoRoot, 'hermes-bridge', '.venv'),
      path.join(repoRoot, 'hermes-bridge', 'venv'),
      path.join(SCRIPTS_DIR, '..', '..', 'hermes-bridge', '.venv'),
      path.join(SCRIPTS_DIR, '..', '..', 'hermes-bridge', 'venv'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(repoRoot, 'hermes-bridge', 'venv'); // fallback
  })();
  const pythonBin = path.join(venvDir, 'bin', 'python3');
  const scriptPath = path.join(SCRIPTS_DIR, 'run-kanban-agent.py');

  if (!fs.existsSync(scriptPath)) {
    console.error(`[orchestrator] Kanban agent runner script not found: ${scriptPath}`);
    return;
  }

  const child = spawn(pythonBin, [scriptPath], {
    env: {
      ...process.env,
      KANBAN_CARD_ID: cardId,
      CLOUDCHAT_API_BASE: API_BASE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  child.on('close', (code: number | null) => {
    const exitCode = code ?? -1;
    if (exitCode !== 0) {
      console.error(`[orchestrator] Kanban agent for card ${cardId.slice(0, 12)}... exited with code ${exitCode}`);
      if (stderr) console.error(`[orchestrator] stderr: ${stderr.slice(0, 500)}`);
    } else {
      console.log(`[orchestrator] Kanban agent for card ${cardId.slice(0, 12)}... completed successfully`);
    }
    // Log brief stdout summary
    const stdoutLines = stdout.trim().split('\n').filter(l => l.includes('[kanban-runner]'));
    for (const line of stdoutLines) {
      console.log(line);
    }
  });

  child.on('error', (err: Error) => {
    console.error(`[orchestrator] Failed to spawn kanban agent: ${err.message}`);
  });
}

// ─── Team dispatch helper ───────────────────────────────────────────────────

/**
 * Dispatch a kanban card as a multi-agent team.
 * Falls back to single-agent dispatch on failure.
 */
async function dispatchAsTeam(card: CardRecord): Promise<void> {
  try {
    // Create the team
    const team = await teamCoordinator.createTeam(card);

    // Decompose the task into subtasks
    const subtasks = await teamCoordinator.decomposeTask(card);

    // Assign subtasks to agents
    const assigned = teamCoordinator.assignSubtasks(subtasks, team.agents);
    team.subtasks = assigned;

    // Dispatch the team
    await teamCoordinator.dispatchTeam(team.id);

    console.log(
      `[orchestrator] Team dispatched for card "${card.title}" — ${team.agents.length} agents, ${assigned.length} subtasks`,
    );
  } catch (err) {
    console.error(`[orchestrator] Team dispatch failed for card ${card.id}, falling back to single agent:`, err);
    // Graceful degradation: fall back to single-agent
    if (card.id) {
      void spawnKanbanAgent(card.id).catch(() => {});
    }
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

  /**
   * Dispatch a specific kanban card as a background agent task.
   * Spawns a Python subprocess that runs the Hermes AIAgent with
   * kanban tools. Does NOT create a chat panel or use any chat UI.
   */
  async dispatchCard(cardId: string): Promise<{ ok: boolean; error?: string }> {
    // Already running in this process — treat as success
    if (state.activeTasks.has(cardId)) {
      return { ok: true };
    }

    try {
      // Fetch the card
      const allCards = await fetchCards('');
      const card = allCards.find((c) => c.id === cardId);
      if (!card) {
        return { ok: false, error: 'Card not found' };
      }

      // Card is already running (dispatched by another process) — ack without spawning
      if (card.status === 'running') {
        state.activeTasks.set(cardId, {
          cardId,
          conversationId: '',
          startedAt: Date.now(),
        });
        return { ok: true };
      }

      // Build system prompt
      const systemPrompt = buildKanbanTaskPrompt(card);

      // Create a conversation to track the task
      const conversationId = await createConversation(
        `[Task] ${card.title}`,
        systemPrompt,
        ['kanban-task'],
      );
      if (!conversationId) {
        return { ok: false, error: 'Failed to create conversation' };
      }

      // Track the task
      state.activeTasks.set(cardId, {
        cardId,
        conversationId,
        startedAt: Date.now(),
      });

      // Mark card as running
      await updateCardStatus(cardId, 'running');

      // Check if this card should use team dispatch
      const taskText = `${card.title} ${card.spec ?? ''}`;
      const formation = analyzeTask(taskText, []);
      if (card.teamMode || formation.strategy !== 'single_agent') {
        console.log(
          `[orchestrator] Dispatching card "${card.title}" (${cardId.slice(0, 12)}...) → team dispatch (${formation.strategy})`,
        );
        void dispatchAsTeam(card).catch((err) => {
          console.error(`[orchestrator] Team dispatch failed for card ${cardId}, reverting:`, err);
          state.activeTasks.delete(cardId);
          updateCardStatus(cardId, 'ready').catch(() => {});
        });
      } else {
        // Spawn the background agent process
        console.log(
          `[orchestrator] Dispatching card "${card.title}" (${cardId.slice(0, 12)}...) → background agent`,
        );
        void spawnKanbanAgent(cardId);
      }

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[orchestrator] Failed to dispatch card ${cardId}:`, err);
      // Roll back
      state.activeTasks.delete(cardId);
      await updateCardStatus(cardId, 'ready');
      return { ok: false, error: msg };
    }
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

    /**
   * Get full queue state with enriched card details.
   * Returns categorized cards (queued/ready, running, completed) with
   * kanban card data joined with orchestrator state.
   */
  async getQueueState(): Promise<QueueState> {
    // Fetch all kanban cards
    let allCards: any[] = [];
    try {
      const res = await fetch(`${API_BASE}/api/hermes/kanban`);
      if (res.ok) {
        const data = await res.json();
        allCards = data.cards ?? [];
      }
    } catch {
      // fallback to empty
    }

    // Build lookup map
    const cardMap = new Map<string, any>();
    for (const card of allCards) {
      cardMap.set(card.id, card);
    }

    const queuedCards: QueueCard[] = [];
    const runningCards: QueueCard[] = [];
    const completedCards: QueueCard[] = [];
    const now = Date.now();

    for (const card of allCards) {
      const status = card.status;
      const activeTask = state.activeTasks.get(card.id);
      const isRunning = status === 'running' || activeTask !== undefined;

      const queueCard: QueueCard = {
        id: card.id,
        title: card.title || 'Untitled',
        spec: card.spec || '',
        acceptanceCriteria: Array.isArray(card.acceptanceCriteria) ? card.acceptanceCriteria : [],
        assignedWorker: card.assignedWorker || null,
        status: 'queued',
        reportSummary: card.reportPath || undefined,
      };

      if (status === 'ready') {
        queueCard.status = 'queued';
        queuedCards.push(queueCard);
      } else if (isRunning) {
        queueCard.status = 'running';
        queueCard.startedAt = activeTask?.startedAt ?? now;
        runningCards.push(queueCard);
      } else if (status === 'done' || status === 'review') {
        queueCard.status = status;
        queueCard.completedAt = card.updatedAt || now;
        completedCards.push(queueCard);
        if (status === 'done') state.stats.completed++;
      } else if (status === 'blocked') {
        queueCard.status = 'blocked';
        queueCard.completedAt = card.updatedAt || now;
        completedCards.push(queueCard);
        state.stats.failed++;
      }
    }

    // Sort queued by updatedAt (oldest first), running by startedAt, completed by completedAt (newest first)
    const sortBy = (arr: QueueCard[], key: 'startedAt' | 'completedAt' | undefined, asc: boolean) => {
      return arr.sort((a, b) => {
        const aVal = key ? (a[key] ?? 0) : 0;
        const bVal = key ? (b[key] ?? 0) : 0;
        return asc ? aVal - bVal : bVal - aVal;
      });
    };

    return {
      queued: sortBy(queuedCards, undefined, true),
      running: sortBy(runningCards, 'startedAt', true),
      completed: sortBy(completedCards, 'completedAt', false).slice(0, 20), // keep last 20
      stats: { completed: state.stats.completed, failed: state.stats.failed },
      enabled: state.enabled,
    };
  },

async cancelTask(cardId: string): Promise<boolean> {
    const task = state.activeTasks.get(cardId);
    if (!task) return false;

    state.activeTasks.delete(cardId);
    await updateCardStatus(cardId, 'ready');
    return true;
  },
};
