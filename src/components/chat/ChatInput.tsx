import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ArrowUp, Square, Plus, ChevronDown, Mic, MicOff, CornerDownLeft, Bot, ClipboardList, Loader2, Repeat } from 'lucide-react';
import { useHermesStore, DEFAULT_LOOP_STATE } from '@/stores/hermes-store';
import { usePanelId } from '@/contexts/PanelContext';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

// Commands that switch to a sidebar sub-tab — after running, open the sidebar
const SUBTAB_NAV_COMMANDS = new Set([
  'overview', 'cron', 'memories', 'skills', 'usage', 'chats', 'threads', 'queue',
]);
import { useSettingsStore, type Provider } from '@/stores/settings-store';
import { useShallow } from 'zustand/shallow';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { toolbarPopoverAlignment } from '@/hooks/chat-utils';
import { PROVIDERS, REASONING_EFFORTS, getVisibleModelOptions, supportsReasoningEffort } from '@/lib/providers';
import type { QueuedMessage } from '@/lib/chat-queue';
import { StreamingStatusBar } from './StreamingStatusBar';
import { useChatStore } from '@/stores/chat-store';
import { QueuedMessageTray } from './QueuedMessageTray';
import { CommandSuggestions, commandTakesArgs } from './CommandSuggestions';
import { HermesModelPicker } from './HermesModelPicker';
import { HermesEffortSlider } from './HermesEffortSlider';
import { parseCommand, findCommand, filterCommands, ensureHermesAgentCommandsLoaded, type CommandContext } from '@/lib/hermes-commands';
import { useCommandCallbacks } from '@/contexts/CommandCallbacksContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming: boolean;
  isAnotherPanelStreamingSameProfile?: boolean;
  toolCallCount?: number;
  disabled?: boolean;
  disabledPlaceholder?: string;
  hasMessages?: boolean;
  activeProvider?: string;
  activeModel?: string;
  agentStatusLabel?: string;
  /** Server start time (epoch ms) of the active run, for a remount-stable elapsed timer. */
  streamStartedAt?: number;
  queuedMessages?: QueuedMessage[];
  onRemoveQueuedMessage?: (messageId: string) => void;
  onSteerQueuedMessage?: (messageId: string) => void;
}

const REASONING_EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const;

export const ChatInput: React.FC<ChatInputProps> = React.memo(({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  isAnotherPanelStreamingSameProfile = false,
  toolCallCount = 0,
  disabled,
  disabledPlaceholder,
  hasMessages = false,
  activeModel: _activeModel,
  agentStatusLabel,
  streamStartedAt,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedProvider = useSettingsStore((s) => s.activeProvider);
  const providers = useSettingsStore((s) => s.providers);
  const availableModels = useSettingsStore((s) => s.availableModels);
  const updateProviderConfig = useSettingsStore((s) => s.updateProviderConfig);
  const config = providers[selectedProvider];
  const providerInfo = PROVIDERS[selectedProvider];
  const baseModels = availableModels[selectedProvider]?.length
    ? availableModels[selectedProvider]!
    : (providerInfo?.models || []);
  const models = getVisibleModelOptions(selectedProvider, baseModels, config.model);
  const displayModel = config.model.split('/').pop() || config.model;
  const reasoningSupported = supportsReasoningEffort(selectedProvider, config.model);
  const reasoningLabel = REASONING_EFFORT_LABELS[config.reasoningEffort];
  const planMode = useChatStore((s) => s.planMode);
  const setPlanMode = useChatStore((s) => s.setPlanMode);
  const panelId = usePanelId();
  const loop = useHermesStore((s) => s.loops[panelId]) ?? DEFAULT_LOOP_STATE;
  const setLoopEnabled = useHermesStore((s) => s.setLoopEnabled);
  const setLoopConfig = useHermesStore((s) => s.setLoopConfig);
  const [showLoopConfig, setShowLoopConfig] = useState(false);
  const loopConfigRef = useRef<HTMLDivElement>(null);

  // Close the loop config popover on outside click.
  useEffect(() => {
    if (!showLoopConfig) return;
    const onPointerDown = (e: PointerEvent) => {
      if (loopConfigRef.current && !loopConfigRef.current.contains(e.target as Node)) {
        setShowLoopConfig(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showLoopConfig]);

  const handleLoopToggle = () => {
    if (loop.enabled) {
      setLoopEnabled(panelId, false);
      setShowLoopConfig(false);
    } else {
      setLoopEnabled(panelId, true);
      setShowLoopConfig(true);
    }
  };
  const commandCallbacks = useCommandCallbacks();

  // Real UI store actions for command context
  const setActiveSubTab = useUIStore((s) => s.setActiveSubTab);
  const setMiniBrowserOpen = useUIStore((s) => s.setMiniBrowserOpen);
  const setMiniBrowserUrl = useUIStore((s) => s.setMiniBrowserUrl);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setActiveTab = useUIStore((s) => s.setActiveTab);

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    }
  }, [value]);

  // Load the installed hermes-agent's slash command catalog into the `/` menu.
  // Shared, deduped, and at-most-once per session across every panel — the
  // loader handles retries (transient only) and gives up on a 404 instead of
  // hammering a missing endpoint. Optional — local commands still work if it
  // never resolves.
  useEffect(() => {
    void ensureHermesAgentCommandsLoaded();
  }, []);

  const safeValue = value ?? '';

  // Voice input
  const { providers: settingsProviders } = useSettingsStore(
    useShallow((s) => ({ providers: s.providers }))
  );
  const voiceInput = useVoiceInput(settingsProviders as Record<Provider, { apiKey: string }>);

  // Use refs for stable references so handleMicToggle doesn't recreate every render
  const voiceStartRef = useRef(voiceInput.startRecording);
  const voiceStopRef = useRef(voiceInput.stopRecording);
  const voiceCancelRef = useRef(voiceInput.cancelRecording);
  const voiceIsRecordingRef = useRef(voiceInput.isRecording);
  const voiceIsTranscribingRef = useRef(voiceInput.isTranscribing);
  voiceStartRef.current = voiceInput.startRecording;
  voiceStopRef.current = voiceInput.stopRecording;
  voiceCancelRef.current = voiceInput.cancelRecording;
  voiceIsRecordingRef.current = voiceInput.isRecording;
  voiceIsTranscribingRef.current = voiceInput.isTranscribing;

  const safeValueRef = useRef(safeValue);
  safeValueRef.current = safeValue;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const handleMicToggle = useCallback(async () => {
    if (voiceIsTranscribingRef.current || disabledRef.current) return;

    if (voiceIsRecordingRef.current) {
      const transcribed = await voiceStopRef.current();
      if (transcribed) {
        const current = safeValueRef.current;
        const separator = current.trim() ? ' ' : '';
        onChange(current + separator + transcribed);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    } else {
      await voiceStartRef.current();
    }
  }, [onChange]);

  const executeCommand = useCallback(async (input: string): Promise<boolean> => {
    const parsed = parseCommand(input);
    if (!parsed) return false;

    const cmd = findCommand(parsed.command);
    if (!cmd) return false;
    // Skill/agent commands have no local handler — let them send to the bridge,
    // which expands skills and forwards the rest to the agent.
    if (!cmd.handler) return false;

    const context: CommandContext = {
      setActiveSubTab,
      setActiveTab,
      setMiniBrowserOpen,
      setMiniBrowserUrl,
      ...commandCallbacks,
    };

    try {
      const result = await cmd.handler(parsed.args, context);

      // Navigation commands need the sidebar open to show their result
      // Subtab nav commands (overview, cron, etc.) — open the chat sidebar
      if (SUBTAB_NAV_COMMANDS.has(parsed.command)) {
        setActiveTab('chat');
        setSidebarOpen(true);
      }
      // Main-tab nav commands (github, analyzer, knowledge) — no extra action needed,
      // setActiveTab was already called inside the handler via context.setActiveTab().

      // Only show result text for commands with actual feedback to display
      if (result && !result.startsWith('Switched to ')) {
        onChange(result);
      } else {
        onChange('');
      }
    } catch {
      onChange(`Error executing /${parsed.command}.`);
    }
    return true;
  }, [commandCallbacks, onChange, setActiveSubTab, setMiniBrowserOpen, setMiniBrowserUrl, setSidebarOpen, setActiveTab]);

  const handleSendOrCommand = useCallback(async () => {
    if (!safeValue.trim()) return;
    const wasCommand = await executeCommand(safeValue);
    if (!wasCommand) {
      onSend();
    }
  }, [safeValue, executeCommand, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showCommandSuggestions) {
        handleCommandSelectAtIndex(selectedIndex);
      } else if (safeValue.trim()) {
        handleSendOrCommand();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (voiceIsRecordingRef.current) {
        voiceCancelRef.current();
        return;
      }
      setShowCommandSuggestions(false);
      return;
    }
    if (showCommandSuggestions) {
      const filtered = filterCommands(safeValue);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
    }
  };

  // Select a command by index from the filtered list (used for Enter key + click)
  // No-arg commands execute immediately; arg commands fill the input.
  const handleCommandSelectAtIndex = useCallback(async (index: number) => {
    const filtered = filterCommands(safeValue);
    const cmd = filtered[index];
    if (!cmd) return;

    setShowCommandSuggestions(false);
    setSelectedIndex(0);

    if (commandTakesArgs(cmd) || !cmd.handler) {
      // Needs args, or is a skill/agent command — drop into the composer so the
      // user can review/add input, then send (skills are expanded by the bridge).
      onChange('/' + cmd.name + ' ');
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      // Local no-arg UI command — execute immediately and clear input
      onChange('');
      await executeCommand('/' + cmd.name);
    }
  }, [safeValue, onChange, executeCommand]);

  // Select a command by name (used when clicking a suggestion)
  const handleCommandSelect = useCallback(async (name: string) => {
    if (!name) return;
    const cmd = findCommand(name);
    if (!cmd) return;

    setShowCommandSuggestions(false);
    setSelectedIndex(0);

    if (commandTakesArgs(cmd) || !cmd.handler) {
      onChange('/' + cmd.name + ' ');
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      onChange('');
      await executeCommand('/' + cmd.name);
    }
  }, [onChange, executeCommand]);

  const hasContent = hasMessages;
  const hasQueuedMessages = queuedMessages.length > 0;
  const canQueueDraft = isStreaming && !!safeValue.trim() && !disabled;
  const placeholder = disabled
    ? (disabledPlaceholder || 'Input is temporarily unavailable')
    : (hasContent ? 'Ask for follow-up changes' : 'What do you want to build?');

  return (
    <div className="w-full max-w-[720px] mx-auto px-3 md:px-20 pb-3 pt-2" data-tour="composer">
      <div className="flex flex-col">
        <QueuedMessageTray
          messages={queuedMessages}
          onRemove={onRemoveQueuedMessage}
          onSteer={onSteerQueuedMessage}
          disabled={disabled}
          connected={hasQueuedMessages}
          waitingForOtherPanel={isAnotherPanelStreamingSameProfile}
        />

        <div
          className={cn(
            'relative overflow-visible border border-[#3F3F3F] bg-[#222222]',
            hasQueuedMessages ? 'rounded-b-[10px] rounded-t-none border-t-0' : 'rounded-[10px]',
          )}
        >
          <StreamingStatusBar
            isStreaming={isStreaming}
            toolCallCount={toolCallCount}
            statusLabel={agentStatusLabel}
            startedAt={streamStartedAt}
            embedded
          />

          {/* Command Suggestions */}
          {showCommandSuggestions && (
            <div className="px-3">
              <CommandSuggestions
                query={safeValue}
                visible={showCommandSuggestions}
                selectedIndex={selectedIndex}
                onSelect={handleCommandSelect}
                onSelectIndex={setSelectedIndex}
              />
            </div>
          )}

          {/* Textarea area */}
          <div className="flex items-end gap-2 px-4 py-3 min-h-[50px]">
            <textarea
              ref={textareaRef}
              value={safeValue}
              onChange={(e) => {
                const val = e.target.value;
                if (typeof onChange === 'function') onChange(val);
                setShowCommandSuggestions(val.startsWith('/'));
              }}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={disabled}
              className={cn(
                "flex-1 resize-none bg-transparent text-[13px] leading-relaxed placeholder:text-[hsl(var(--text-dim))] focus:outline-none min-h-[20px] max-h-[200px]",
                disabled && "opacity-50"
              )}
            />
          </div>

          {/* Bottom toolbar — the left control cluster clips before it can
              push the mic/send buttons out of the row in narrow panels. */}
          <div className="flex items-center gap-1 h-9 px-3 pb-1.5 min-w-0">
            <div data-toolbar-clip className="flex min-w-0 flex-1 items-center gap-1 overflow-x-clip">
            {/* Plus button */}
            <button
              className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-[#666666] hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Attach"
            >
              <Plus className="h-4 w-4" />
            </button>

            {/* Model selector — Hermes gets a provider+model picker over its configured providers */}
            {selectedProvider === 'hermes' ? (
              <>
                <HermesModelPicker />
                <HermesEffortSlider />
              </>
            ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex min-w-0 items-center gap-1 px-2 py-1 rounded-[6px] text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100 max-w-[120px] sm:max-w-none">
                  <Bot className="h-3 w-3 shrink-0" />
                  <span className="truncate">{displayModel}</span>
                  <ChevronDown className="h-3 w-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto">
                {models.map((model) => {
                  const label = model.split('/').pop() || model;
                  return (
                    <DropdownMenuItem
                      key={model}
                      onClick={() => updateProviderConfig(selectedProvider, { model })}
                      className={model === config.model ? 'bg-accent' : ''}
                    >
                      <span className="text-xs">{label}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            {selectedProvider !== 'hermes' && reasoningSupported && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={`Reasoning effort: ${reasoningLabel}`}
                    title="Adjust reasoning effort"
                    className="flex shrink-0 items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100 whitespace-nowrap"
                  >
                    <span className="hidden sm:inline">Reasoning:&nbsp;</span>
                    {reasoningLabel}
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {REASONING_EFFORTS.map((level) => (
                    <DropdownMenuItem
                      key={level}
                      onClick={() => updateProviderConfig(selectedProvider, { reasoningEffort: level })}
                      className={level === config.reasoningEffort ? 'bg-accent' : ''}
                    >
                      <span className="text-xs">{REASONING_EFFORT_LABELS[level]}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Plan mode toggle */}
            <button
              onClick={() => setPlanMode(!planMode)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                planMode
                  ? 'bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              title={planMode ? 'Exit Plan Mode' : 'Enter Plan Mode (read-only exploration)'}
            >
              <ClipboardList className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden sm:inline">Plan</span>
            </button>

            {/* Loop mode toggle — Hermes only. Reruns the agent until a judge
                verdict says the goal is met, bounded by iteration/time caps. */}
            {selectedProvider === 'hermes' && (
              <div className="relative shrink-0" ref={loopConfigRef}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={loop.enabled}
                  onClick={handleLoopToggle}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    loop.enabled
                      ? 'text-emerald-400'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                  title={
                    loop.enabled
                      ? 'Loop Mode on — click to disable'
                      : 'Enable Loop Mode (rerun the agent until the goal is met)'
                  }
                >
                  <Repeat className="h-3.5 w-3.5 shrink-0" />
                  <span className="hidden sm:inline tabular-nums">
                    {loop.enabled && isStreaming && loop.iteration > 0
                      ? loop.phase === 'judge'
                        ? `Judging ${loop.iteration}/${loop.config.maxIterations}`
                        : `Loop ${loop.iteration}/${loop.config.maxIterations}`
                      : 'Loop'}
                  </span>
                  {/* Switch track + thumb */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors duration-150',
                      loop.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform duration-150',
                        loop.enabled ? 'translate-x-3' : 'translate-x-0.5'
                      )}
                    />
                  </span>
                </button>
                {loop.enabled && !isStreaming && (
                  <button
                    onClick={() => setShowLoopConfig((v) => !v)}
                    className="ml-0.5 p-0.5 rounded text-emerald-400/70 hover:text-emerald-400"
                    title="Loop settings"
                    aria-label="Loop settings"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                )}
                {showLoopConfig && (
                  <div
                    className={cn(
                      'absolute bottom-full mb-2 z-50 w-60 rounded-lg border border-border bg-popover p-3 shadow-lg space-y-3',
                      toolbarPopoverAlignment(loopConfigRef.current),
                    )}
                  >
                    <div>
                      <p className="text-xs font-semibold text-foreground">Loop until the goal is met</p>
                      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        After each pass a judge checks your goal. The agent reruns with the judge's feedback until it passes or a cap is hit.
                      </p>
                    </div>
                    <label className="flex items-center justify-between gap-2 text-xs text-foreground">
                      Max iterations
                      <input
                        type="number"
                        min={1}
                        max={25}
                        value={loop.config.maxIterations}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) setLoopConfig(panelId, { maxIterations: Math.min(25, Math.max(1, n)) });
                        }}
                        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-2 text-xs text-foreground">
                      Time budget (min)
                      <input
                        type="number"
                        min={1}
                        max={480}
                        placeholder="∞"
                        value={loop.config.timeBudgetMinutes ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === '') {
                            setLoopConfig(panelId, { timeBudgetMinutes: null });
                            return;
                          }
                          const n = parseInt(raw, 10);
                          if (Number.isFinite(n) && n > 0) setLoopConfig(panelId, { timeBudgetMinutes: Math.min(480, n) });
                        }}
                        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            </div>

            {/* Mic button */}
            {voiceInput.isTranscribing ? (
              <button
                className="p-1.5 shrink-0 rounded-lg text-muted-foreground"
                title="Transcribing…"
                aria-label="Transcribing"
                disabled
              >
                <Loader2 className="h-4 w-4 animate-spin" />
              </button>
            ) : voiceInput.isRecording ? (
              <button
                onClick={handleMicToggle}
                disabled={disabled}
                className={cn(
                  'p-1.5 shrink-0 rounded-lg transition-colors duration-100',
                  'text-red-500 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20',
                  disabled && 'opacity-50 pointer-events-none'
                )}
                title="Stop recording"
                aria-label="Stop recording"
              >
                <MicOff className="h-4 w-4" />
              </button>
            ) : (
              <button
                onClick={handleMicToggle}
                disabled={disabled}
                className={cn(
                  'p-1.5 shrink-0 rounded-lg transition-colors duration-100',
                  voiceInput.error
                    ? 'text-amber-500 hover:text-amber-400'
                    : 'text-[#555555] hover:text-foreground hover:bg-muted',
                  disabled && 'opacity-50 pointer-events-none'
                )}
                title={voiceInput.error || 'Voice input'}
                aria-label={voiceInput.error || 'Voice input'}
              >
                <Mic className="h-4 w-4" />
              </button>
            )}
            {voiceInput.error && (
              <span className="text-[10px] text-amber-500 max-w-[120px] shrink truncate" title={voiceInput.error}>
                {voiceInput.error}
              </span>
            )}

            {/* Send / Stop */}
            {isStreaming ? (
              <>
                {canQueueDraft && (
                  <button
                    onClick={onSend}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-100 hover:bg-muted"
                    title="Queue this message"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                    Queue
                  </button>
                )}
                <button
                  onClick={onStop}
                  className="h-[30px] w-[30px] shrink-0 flex items-center justify-center rounded-[8px] bg-primary text-primary-foreground hover:opacity-80 transition-opacity duration-100"
                  title="Stop generating"
                >
                  <Square className="h-3.5 w-3.5" />
                </button>
              </>
            ) : (
              <button
                onClick={handleSendOrCommand}
                disabled={!safeValue.trim() || disabled}
                className={cn(
                  "h-[30px] w-[30px] shrink-0 flex items-center justify-center rounded-[8px] transition-opacity duration-100",
                  safeValue.trim()
                    ? "bg-primary text-primary-foreground hover:opacity-80"
                    : "bg-muted text-muted-foreground"
                )}
                title="Send message"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
