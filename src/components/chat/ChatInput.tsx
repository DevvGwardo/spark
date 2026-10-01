import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ArrowUp, Square, Plus, ChevronDown, Mic, MicOff, CornerDownLeft, Bot, ClipboardList, Loader2, Repeat, X, Flag, SlidersHorizontal } from 'lucide-react';
import { useHermesStore, DEFAULT_LOOP_STATE } from '@/stores/hermes-store';
import { usePanelId, useChatScopeId } from '@/hooks/use-panel-context';
import { useChangesetStore } from '@/stores/changeset-store';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';
import { getApiBaseUrl } from '@/lib/api';

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
import { ContextMeter } from './ContextMeter';
import { useChatStore } from '@/stores/chat-store';
import { QueuedMessageTray } from './QueuedMessageTray';
import { CommandSuggestions } from './CommandSuggestions';
import { buildPickerSuggestions, type ContextRefSuggestion } from '@/lib/context-refs';
import { ContextRefSuggestions } from './ContextRefSuggestions';
import { HermesModelPicker } from './HermesModelPicker';
import { HermesEffortSlider } from './HermesEffortSlider';
import { parseCommand, findCommand, filterCommands, ensureHermesAgentCommandsLoaded, commandTakesArgs, type CommandContext } from '@/lib/hermes-commands';
import {
  detectContextRefQuery,
  estimateContextRefTokens,
  filterFileSuggestions,
  filterFolderSuggestions,
  hasContextRefs,
  searchWorkspaceFiles,
  type ContextRefQuery,
} from '@/lib/context-refs';
import { fetchGoalsConfig, updateGoalsConfig, type GoalsConfig } from '@/lib/hermes-api';
import { useCommandCallbacks } from '@/hooks/use-command-callbacks';
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
  /** Fluent live tool verb ("Reading foo.ts") for the streaming status bar. */
  currentTool?: string;
  /** Server start time (epoch ms) of the active run, for a remount-stable elapsed timer. */
  streamStartedAt?: number;
  queuedMessages?: QueuedMessage[];
  onRemoveQueuedMessage?: (messageId: string) => void;
  onSteerQueuedMessage?: (messageId: string) => void;
  /** Send composed content directly (used when image attachments are present). */
  onSendContent?: (content: string) => void;
  /** Enable @file:/@folder:/@diff/@url: context ref autocomplete (off in room chat). */
  contextRefsEnabled?: boolean;
}

interface PastedImageAttachment {
  id: string;
  /** Object URL for the local thumbnail preview. */
  previewUrl: string;
  /** Absolute server path, set once the upload finishes. */
  path?: string;
  status: 'uploading' | 'ready';
}

// Image types the upload endpoint accepts for pasted images.
const PASTEABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
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
  currentTool,
  streamStartedAt,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
  onSendContent,
  contextRefsEnabled = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [contextRefQuery, setContextRefQuery] = useState<ContextRefQuery | null>(null);
  const [contextRefSuggestions, setContextRefSuggestions] = useState<ContextRefSuggestion[]>([]);
  const [contextRefIndex, setContextRefIndex] = useState(0);
  const [contextRefLoading, setContextRefLoading] = useState(false);
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
  const streamRetry = useChatStore((s) => s.streamRetry);
  const panelId = usePanelId();
  const scopeId = useChatScopeId();
  const activeRepo = useChangesetStore((s) => s.getChangeset(scopeId).activeRepo);
  const repoFileTree = useChangesetStore((s) => s.getChangeset(scopeId).repoFileTree);
  const loop = useHermesStore((s) => s.loops[panelId]) ?? DEFAULT_LOOP_STATE;
  const setLoopEnabled = useHermesStore((s) => s.setLoopEnabled);
  const setLoopConfig = useHermesStore((s) => s.setLoopConfig);
  const [showLoopConfig, setShowLoopConfig] = useState(false);
  const [goalsConfig, setGoalsConfig] = useState<GoalsConfig>({ max_turns: 20, enabled: true });
  const [goalsBusy, setGoalsBusy] = useState(false);
  const [showGoalsConfig, setShowGoalsConfig] = useState(false);

  // Close the goals popover on outside click (popover lives in the menu).
  useEffect(() => {
    if (!showGoalsConfig) return;
    const onPointerDown = (e: PointerEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(e.target as Node)) {
        setShowGoalsConfig(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showGoalsConfig]);

  // Codex-style simplification: Plan / Loop / Goals live in one overflow menu
  // instead of three always-visible toggles on the composer toolbar.
  const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!optionsMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(e.target as Node)) {
        setOptionsMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOptionsMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [optionsMenuOpen]);

  useEffect(() => {
    if (selectedProvider !== 'hermes') return;
    let cancelled = false;
    void fetchGoalsConfig()
      .then((cfg) => {
        if (!cancelled) setGoalsConfig(cfg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedProvider]);

  const handleGoalsToggle = async () => {
    if (selectedProvider !== 'hermes' || goalsBusy) return;
    const nextEnabled = !goalsConfig.enabled;
    setGoalsBusy(true);
    try {
      const saved = await updateGoalsConfig({ enabled: nextEnabled });
      setGoalsConfig(saved);
      if (nextEnabled) setShowGoalsConfig(true);
      else setShowGoalsConfig(false);
    } catch {
      // keep prior state on failure
    } finally {
      setGoalsBusy(false);
    }
  };

  const handleGoalsMaxTurns = async (maxTurns: number) => {
    if (selectedProvider !== 'hermes' || goalsBusy) return;
    const clamped = Math.max(1, Math.min(200, maxTurns));
    setGoalsBusy(true);
    try {
      const saved = await updateGoalsConfig({ max_turns: clamped });
      setGoalsConfig(saved);
    } catch {
      // keep prior state on failure
    } finally {
      setGoalsBusy(false);
    }
  };

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
  const setMiniBrowserDocked = useUIStore((s) => s.setMiniBrowserDocked);
  const setRightSidebarHidden = useUIStore((s) => s.setRightSidebarHidden);
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
  const contextRefsActive = contextRefsEnabled && selectedProvider === 'hermes';
  const showContextRefSuggestions = contextRefsActive && contextRefQuery !== null && contextRefSuggestions.length > 0;

  // Load context-ref file/folder suggestions when the user types a partial path.
  useEffect(() => {
    if (!contextRefsActive || !contextRefQuery || contextRefQuery.kind === 'picker' || contextRefQuery.kind === 'diff') {
      if (contextRefQuery?.kind === 'picker') {
        setContextRefSuggestions(buildPickerSuggestions(''));
      }
      return;
    }

    let cancelled = false;
    const load = async () => {
      setContextRefLoading(true);
      try {
        if (contextRefQuery.kind === 'file') {
          let paths: string[] = [];
          if (activeRepo?.localPath) {
            paths = await searchWorkspaceFiles(activeRepo.localPath, contextRefQuery.query || '.', 20);
          } else if (repoFileTree.length > 0) {
            paths = filterFileSuggestions(repoFileTree, contextRefQuery.query, 20);
          }
          if (!cancelled) {
            setContextRefSuggestions(
              paths.map((p) => ({ label: p, insert: `@file:${p} `, kind: 'file' as const })),
            );
          }
        } else if (contextRefQuery.kind === 'folder') {
          let paths: string[] = [];
          if (repoFileTree.length > 0) {
            paths = filterFolderSuggestions(repoFileTree, contextRefQuery.query, 20);
          } else if (activeRepo?.localPath) {
            const searched = await searchWorkspaceFiles(activeRepo.localPath, contextRefQuery.query || '.', 40);
            paths = filterFolderSuggestions(searched, contextRefQuery.query, 20);
          }
          if (!cancelled) {
            setContextRefSuggestions(
              paths.map((p) => ({ label: p || '.', insert: `@folder:${p} `, kind: 'folder' as const })),
            );
          }
        } else if (contextRefQuery.kind === 'url') {
          if (!cancelled) {
            setContextRefSuggestions(
              contextRefQuery.query
                ? [{ label: contextRefQuery.query, insert: `@url:${contextRefQuery.query} `, kind: 'url' }]
                : [{ label: 'https://', insert: '@url:https://', kind: 'url', hint: 'Paste a URL' }],
            );
          }
        }
      } finally {
        if (!cancelled) setContextRefLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeRepo?.localPath, contextRefQuery, contextRefsActive, repoFileTree]);

  useEffect(() => {
    if (contextRefQuery?.kind === 'picker') {
      setContextRefSuggestions(buildPickerSuggestions(''));
    }
  }, [contextRefQuery?.kind]);

  const updateContextRefState = useCallback((val: string, cursorPos?: number) => {
    if (!contextRefsActive || val.startsWith('/')) {
      setContextRefQuery(null);
      setContextRefSuggestions([]);
      return;
    }
    const detected = detectContextRefQuery(val, cursorPos ?? val.length);
    setContextRefQuery(detected);
    if (!detected) {
      setContextRefSuggestions([]);
    }
  }, [contextRefsActive]);

  const insertContextRef = useCallback((insert: string) => {
    if (!contextRefQuery) return;
    const before = safeValue.slice(0, contextRefQuery.replaceStart);
    const after = safeValue.slice(contextRefQuery.replaceEnd);
    const next = before + insert + after;
    onChange(next);
    setContextRefQuery(null);
    setContextRefSuggestions([]);
    setContextRefIndex(0);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [contextRefQuery, onChange, safeValue]);

  const contextRefTokenEstimate = hasContextRefs(safeValue)
    ? estimateContextRefTokens(safeValue)
    : undefined;

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

  // Paste an image → show a thumbnail chip immediately, upload it to
  // ~/.hermes/images in the background, and compose the saved path into the
  // message at send time. The path renders inline in the sent message and is
  // readable by the hermes agent.
  const [attachments, setAttachments] = useState<PastedImageAttachment[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const attachmentIdRef = useRef(0);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Shared by paste and the Attach button: thumbnail each file immediately,
  // upload it to ~/.hermes/images in the background, and compose the saved
  // path into the message at send time.
  const attachFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setPasteError(null);

    for (const file of files) {
      const id = `pasted-${++attachmentIdRef.current}`;
      const previewUrl = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, { id, previewUrl, status: 'uploading' }]);

      void (async () => {
        try {
          const data = await fileToBase64(file);
          const res = await fetch(`${getApiBaseUrl()}/functions/v1/images/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data, mimeType: file.type }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || typeof json?.path !== 'string') {
            throw new Error(json?.error || 'Image upload failed');
          }
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, path: json.path, status: 'ready' as const } : a))
          );
        } catch (err) {
          setPasteError(err instanceof Error ? err.message : 'Image upload failed');
          removeAttachment(id);
        }
      })();
    }
  }, [removeAttachment]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => PASTEABLE_IMAGE_TYPES.has(i.type))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;

    e.preventDefault();
    attachFiles(files);
  }, [attachFiles]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const readyAttachmentPaths = attachments
    .filter((a) => a.status === 'ready' && a.path)
    .map((a) => a.path as string);
  const hasUploadingAttachments = attachments.some((a) => a.status === 'uploading');

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
      setMiniBrowserDocked,
      setRightSidebarHidden,
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
  }, [commandCallbacks, onChange, setActiveSubTab, setMiniBrowserDocked, setMiniBrowserOpen, setMiniBrowserUrl, setRightSidebarHidden, setSidebarOpen, setActiveTab]);

  const handleSendOrCommand = useCallback(async () => {
    // With image attachments, compose text + image paths and send directly.
    if (readyAttachmentPaths.length > 0 && onSendContent) {
      if (hasUploadingAttachments) return; // wait for in-flight uploads
      const content = [safeValue.trim(), ...readyAttachmentPaths].filter(Boolean).join('\n');
      onSendContent(content);
      setAttachments((prev) => {
        prev.forEach((a) => URL.revokeObjectURL(a.previewUrl));
        return [];
      });
      onChange('');
      return;
    }
    if (!safeValue.trim()) return;
    const wasCommand = await executeCommand(safeValue);
    if (!wasCommand) {
      onSend();
    }
  }, [safeValue, executeCommand, onSend, onSendContent, onChange, readyAttachmentPaths, hasUploadingAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showContextRefSuggestions) {
        const item = contextRefSuggestions[contextRefIndex];
        if (item) insertContextRef(item.insert);
        return;
      }
      if (showCommandSuggestions) {
        handleCommandSelectAtIndex(selectedIndex);
      } else if (safeValue.trim() || readyAttachmentPaths.length > 0) {
        handleSendOrCommand();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (voiceIsRecordingRef.current) {
        voiceCancelRef.current();
        return;
      }
      if (showContextRefSuggestions) {
        setContextRefQuery(null);
        setContextRefSuggestions([]);
        return;
      }
      setShowCommandSuggestions(false);
      return;
    }
    if (showContextRefSuggestions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setContextRefIndex((i) => Math.min(i + 1, contextRefSuggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setContextRefIndex((i) => Math.max(i - 1, 0));
        return;
      }
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

    if (commandTakesArgs(cmd) || cmd.kind !== 'local') {
      // Needs args, or is a Hermes bridge/forwarded command — drop into the
      // composer so the user can review/add input before sending.
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
      <input
        ref={fileInputRef}
        type="file"
        accept={Array.from(PASTEABLE_IMAGE_TYPES).join(',')}
        multiple
        hidden
        onChange={(e) => {
          attachFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
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
            'relative overflow-visible rounded-[12px] bg-card/60 ring-1 ring-border/60',
            'focus-within:ring-border focus-within:bg-card transition-colors duration-150',
            hasQueuedMessages ? 'rounded-t-none' : '',
          )}
        >
          <StreamingStatusBar
            isStreaming={isStreaming}
            toolCallCount={toolCallCount}
            statusLabel={agentStatusLabel ?? 'Working'}
            currentTool={currentTool}
            startedAt={streamStartedAt}
            embedded
            onStop={onStop}
          />

          {/* Secondary stream-retry line (auto-cleared by the store on the
              next stream event): ⟳ Reconnecting… 2/5 */}
          {isStreaming && streamRetry && (
            <div className="flex items-center justify-center gap-1.5 border-b border-amber-500/15 bg-amber-500/[0.04] px-3 py-1 text-[11px] font-mono text-amber-400/90">
              <span>
                ⟳ Reconnecting… {streamRetry.attempt}/{streamRetry.maxAttempts}
              </span>
              {streamRetry.reason ? (
                <span className="truncate text-muted-foreground/60">· {streamRetry.reason}</span>
              ) : null}
            </div>
          )}

          {showContextRefSuggestions && contextRefQuery && (
            <div className="px-3 relative">
              <ContextRefSuggestions
                query={contextRefQuery}
                suggestions={contextRefSuggestions}
                visible={showContextRefSuggestions}
                selectedIndex={contextRefIndex}
                tokenEstimate={contextRefTokenEstimate}
                onSelect={insertContextRef}
                onSelectIndex={setContextRefIndex}
                onDismiss={() => {
                  setContextRefQuery(null);
                  setContextRefSuggestions([]);
                }}
              />
            </div>
          )}

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

          {/* Pasted image thumbnails */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-[8px] border border-[#3F3F3F] bg-muted"
                >
                  <img src={a.previewUrl} alt="Pasted image" className="h-full w-full object-cover" />
                  {a.status === 'uploading' && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity duration-100 hover:bg-black group-hover:opacity-100"
                    title="Remove image"
                    aria-label="Remove image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
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
                setShowCommandSuggestions(val.startsWith('/') && !val.includes('@file:') && !val.includes('@folder:'));
                updateContextRefState(val, e.target.selectionStart ?? val.length);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              rows={1}
              disabled={disabled}
              className={cn(
                "chat-composer-textarea flex-1 resize-none bg-transparent text-[13px] leading-relaxed placeholder:text-[hsl(var(--text-dim))] focus:outline-none min-h-[20px] max-h-[200px]",
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
              onClick={() => fileInputRef.current?.click()}
              className="h-6 w-6 shrink-0 rounded-full flex items-center justify-center text-[#666666] hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Attach"
              aria-label="Attach image"
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

            {/* Codex-style options menu — Plan / Loop / Goals collapsed into
                one overflow control. Active modes show a status dot on the
                trigger so state is visible without spending toolbar space. */}
            <div className="relative shrink-0" ref={optionsMenuRef}>
              <button
                type="button"
                onClick={() => setOptionsMenuOpen((v) => !v)}
                aria-expanded={optionsMenuOpen}
                aria-label="Composer options"
                title="Plan mode, Loop and Goals"
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors',
                  optionsMenuOpen || planMode || loop.enabled || goalsConfig.enabled
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                )}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {(planMode || loop.enabled || goalsConfig.enabled) && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      planMode ? 'bg-purple-400' : loop.enabled ? 'bg-emerald-400' : 'bg-amber-400',
                    )}
                  />
                )}
              </button>
              {optionsMenuOpen && (
                <div
                  className={cn(
                    'absolute bottom-full mb-2 z-50 w-64 rounded-lg border border-border bg-popover p-1.5 shadow-lg',
                    toolbarPopoverAlignment(optionsMenuRef.current),
                  )}
                  role="menu"
                >
                  {/* Plan mode */}
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={planMode}
                    onClick={() => setPlanMode(!planMode)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60',
                      planMode ? 'text-purple-400' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <ClipboardList className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">Plan mode</span>
                    {planMode && <span className="text-[10px] font-medium">On</span>}
                  </button>

                  {/* Loop mode */}
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={loop.enabled}
                    onClick={handleLoopToggle}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60',
                      loop.enabled ? 'text-emerald-400' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Repeat className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">Loop until goal met</span>
                    {loop.enabled && isStreaming && loop.iteration > 0 && (
                      <span className="tabular-nums text-[10px]">
                        {loop.phase === 'judge' ? `Judging ${loop.iteration}/${loop.config.maxIterations}` : `${loop.iteration}/${loop.config.maxIterations}`}
                      </span>
                    )}
                    {loop.enabled && !isStreaming && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowLoopConfig((v) => !v);
                        }}
                        className="p-0.5 rounded text-emerald-400/70 hover:text-emerald-400"
                        title="Loop settings"
                        aria-label="Loop settings"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </button>
                    )}
                  </button>
                  {showLoopConfig && loop.enabled && (
                    <div className="mx-1 mb-1 space-y-2 rounded-md bg-muted/40 p-2.5">
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

                  {/* Goals */}
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={goalsConfig.enabled}
                    disabled={goalsBusy}
                    onClick={() => void handleGoalsToggle()}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 disabled:opacity-50',
                      goalsConfig.enabled ? 'text-amber-400' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Flag className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1">Standing goals</span>
                    {goalsConfig.enabled && (
                      <span className="tabular-nums text-[10px]">max {goalsConfig.max_turns}</span>
                    )}
                  </button>
                  {showGoalsConfig && goalsConfig.enabled && (
                    <div className="mx-1 mb-1 space-y-2 rounded-md bg-muted/40 p-2.5">
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Set objectives with <span className="font-mono">/goal</span>. Max turns caps auto-continue.
                      </p>
                      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        Max turns
                        <input
                          type="number"
                          min={1}
                          max={200}
                          value={goalsConfig.max_turns}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isFinite(n)) void handleGoalsMaxTurns(n);
                          }}
                          disabled={goalsBusy}
                          className="w-16 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                        />
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>

            {/* Live context meter — renders nothing until the backend
                reports usage, so the toolbar never shifts. */}
            <ContextMeter />

            {contextRefsActive && hasContextRefs(safeValue) && (
              <span
                className="text-[10px] text-[#666666] tabular-nums shrink-0"
                title="Estimated tokens for message (refs expand on send)"
              >
                ~{contextRefTokenEstimate?.toLocaleString() ?? 0}
              </span>
            )}
            {contextRefLoading && contextRefsActive && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[#666666]" aria-label="Loading suggestions" />
            )}

            {/* Pasted-image upload error */}
            {pasteError && (
              <span className="text-[10px] text-amber-500 max-w-[120px] shrink truncate" title={pasteError}>
                {pasteError}
              </span>
            )}

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
                disabled={(!safeValue.trim() && readyAttachmentPaths.length === 0) || hasUploadingAttachments || disabled}
                className={cn(
                  "h-[30px] w-[30px] shrink-0 flex items-center justify-center rounded-[8px] transition-opacity duration-100",
                  (safeValue.trim() || readyAttachmentPaths.length > 0)
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
