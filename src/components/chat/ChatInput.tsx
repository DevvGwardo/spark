import React, { useRef, useEffect, useCallback, useState } from 'react';
import { ArrowUp, Square, Plus, ChevronDown, Mic, CornerDownLeft, Bot, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

// Commands that switch to a sidebar sub-tab — after running, open the sidebar
const SUBTAB_NAV_COMMANDS = new Set([
  'overview', 'cron', 'memories', 'skills', 'usage', 'chats', 'threads',
]);

// Commands that switch to a main app tab
const MAINTAB_NAV_COMMANDS = new Set([
  'github', 'analyzer', 'knowledge',
]);
import { useSettingsStore } from '@/stores/settings-store';
import { PROVIDERS, REASONING_EFFORTS, getVisibleModelOptions, supportsReasoningEffort } from '@/lib/providers';
import type { QueuedMessage } from '@/lib/chat-queue';
import { StreamingStatusBar } from './StreamingStatusBar';
import { useChatStore } from '@/stores/chat-store';
import { ContextUsageBar } from './ContextUsageBar';
import { QueuedMessageTray } from './QueuedMessageTray';
import { CommandSuggestions, commandTakesArgs } from './CommandSuggestions';
import { parseCommand, findCommand, filterCommands, type CommandContext } from '@/lib/hermes-commands';
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
  toolCallCount?: number;
  disabled?: boolean;
  disabledPlaceholder?: string;
  messages?: { role: string; content: string }[];
  activeProvider?: string;
  activeModel?: string;
  agentStatusLabel?: string;
  queuedMessages?: QueuedMessage[];
  onRemoveQueuedMessage?: (messageId: string) => void;
  onSteerQueuedMessage?: (messageId: string) => void;
}

const REASONING_EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const;

export const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming,
  toolCallCount = 0,
  disabled,
  disabledPlaceholder,
  messages = [],
  activeModel,
  agentStatusLabel,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onSteerQueuedMessage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { activeProvider: selectedProvider, providers, availableModels, updateProviderConfig } = useSettingsStore();
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

  const safeValue = value ?? '';

  const executeCommand = useCallback(async (input: string): Promise<boolean> => {
    const parsed = parseCommand(input);
    if (!parsed) return false;

    const cmd = findCommand(parsed.command);
    if (!cmd) return false;

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

    if (commandTakesArgs(cmd)) {
      // Fill command into input so user can type the args
      onChange('/' + cmd.name + ' ');
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      // Execute immediately — clear input and run the command
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

    if (commandTakesArgs(cmd)) {
      onChange('/' + cmd.name + ' ');
      setTimeout(() => textareaRef.current?.focus(), 0);
    } else {
      onChange('');
      await executeCommand('/' + cmd.name);
    }
  }, [onChange, executeCommand]);

  const hasContent = messages.length > 0;
  const hasQueuedMessages = queuedMessages.length > 0;
  const canQueueDraft = isStreaming && !!safeValue.trim() && !disabled;
  const placeholder = disabled
    ? (disabledPlaceholder || 'Input is temporarily unavailable')
    : (hasContent ? 'Ask for follow-up changes' : 'What do you want to build?');

  return (
    <div className="w-full max-w-[720px] mx-auto px-20 pb-3 pt-2">
      <div className="flex flex-col">
        <QueuedMessageTray
          messages={queuedMessages}
          onRemove={onRemoveQueuedMessage}
          onSteer={onSteerQueuedMessage}
          disabled={disabled}
          connected={hasQueuedMessages}
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

          {/* Bottom toolbar */}
          <div className="flex items-center gap-1 h-9 px-3 pb-1.5">
            {/* Plus button */}
            <button
              className="h-6 w-6 rounded-full flex items-center justify-center text-[#666666] hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Attach"
            >
              <Plus className="h-4 w-4" />
            </button>

            {/* Model selector — hidden for hermes (model comes from active profile) */}
            {selectedProvider !== 'hermes' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 px-2 py-1 rounded-[6px] text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100">
                  <Bot className="h-3 w-3" />
                  {displayModel}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
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
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-100"
                  >
                    {`Reasoning: ${reasoningLabel}`}
                    <ChevronDown className="h-3 w-3" />
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
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                planMode
                  ? 'bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              title={planMode ? 'Exit Plan Mode' : 'Enter Plan Mode (read-only exploration)'}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              <span>Plan</span>
            </button>


            <div className="flex-1" />

            {/* Context usage ring */}
            {hasContent && (
              <ContextUsageBar messages={messages} model={config.model} />
            )}

            {/* Mic button */}
            <button
              className="p-1.5 rounded-lg text-[#555555] hover:text-foreground hover:bg-muted transition-colors duration-100"
              title="Voice input"
            >
              <Mic className="h-4 w-4" />
            </button>

            {/* Send / Stop */}
            {isStreaming ? (
              <>
                {canQueueDraft && (
                  <button
                    onClick={onSend}
                    className="flex items-center gap-1.5 rounded-full border border-border/80 bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-100 hover:bg-muted"
                    title="Queue this message"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                    Queue
                  </button>
                )}
                <button
                  onClick={onStop}
                  className="h-[30px] w-[30px] flex items-center justify-center rounded-[8px] bg-primary text-primary-foreground hover:opacity-80 transition-opacity duration-100"
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
                  "h-[30px] w-[30px] flex items-center justify-center rounded-[8px] transition-opacity duration-100",
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
};
