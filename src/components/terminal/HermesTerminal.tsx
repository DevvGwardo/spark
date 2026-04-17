'use client';

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useUIStore } from '@/stores/ui-store';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { parseCommand, findCommand, filterCommands, type CommandContext } from '@/lib/hermes-commands';
import { cn } from '@/lib/utils';
import { useShallow } from 'zustand/shallow';

interface OutputEntry {
  id: string;
  type: 'command' | 'result' | 'error' | 'info';
  content: string;
  timestamp: Date;
}

const TERMINAL_BG = '#0a0a0a';
const TERMINAL_FG = '#e4e4e7';
const PROMPT = '> ';
const MAX_HISTORY = 100;

export const HermesTerminal: React.FC = () => {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<OutputEntry[]>([]);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<ReturnType<typeof filterCommands>>([]);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const setActiveSubTab = useUIStore((s) => s.setActiveSubTab);
  const setMiniBrowserOpen = useUIStore((s) => s.setMiniBrowserOpen);
  const setMiniBrowserUrl = useUIStore((s) => s.setMiniBrowserUrl);

  const createConversation = useChatStore((s) => s.createConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const conversations = useChatStore((s) => s.conversations);

  const setConversationForPanel = usePanelStore((s) => s.setConversationForPanel);
  const openPanel = usePanelStore((s) => s.openPanel);
  const focusedPanelId = usePanelStore((s) => s.focusedPanelId);
  const panels = usePanelStore((s) => s.panels);

  const focusedPanel = panels.find((p) => p.id === focusedPanelId);

  // Build the command context from available store methods
  const commandContext = useMemo<CommandContext>(() => ({
    setActiveTab,
    setActiveSubTab,
    setMiniBrowserOpen,
    setMiniBrowserUrl,
    renameConversation: (title: string) => {
      const convId = focusedPanel?.conversationId;
      if (convId) renameConversation(convId, title);
    },
    newConversation: async () => {
      const panel = focusedPanel;
      const provider = 'minimax';
      const model = 'MiniMax-Text-01';
      const id = await createConversation(provider, model, '');
      setConversationForPanel(panel?.id ?? panels[0]?.id ?? '', id);
    },
    setConversationForPanel: (panelId: string, conversationId: string | null) => {
      setConversationForPanel(panelId, conversationId);
    },
    openPanel: (conversationId: string | null) => {
      openPanel(conversationId);
    },
  }), [createConversation, focusedPanel, openPanel, panels, renameConversation, setActiveSubTab, setActiveTab, setConversationForPanel, setMiniBrowserOpen, setMiniBrowserUrl]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pushOutput = useCallback(
    (type: OutputEntry['type'], content: string) => {
      setHistory((prev) => {
        const next = [
          ...prev,
          {
            id: crypto.randomUUID(),
            type,
            content,
            timestamp: new Date(),
          },
        ];
        return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
      });
    },
    []
  );

  const executeCommand = useCallback(
    async (rawInput: string) => {
      const trimmed = rawInput.trim();
      if (!trimmed) return;

      // Add to command history
      setCommandHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
      setHistoryIndex(-1);

      // Show the command in output
      pushOutput('command', trimmed);

      const parsed = parseCommand(trimmed);
      if (!parsed) {
        pushOutput('error', `Unknown input. Type /help for available commands.`);
        return;
      }

      const cmd = findCommand(parsed.command);
      if (!cmd) {
        pushOutput('error', `Unknown command: /${parsed.command}. Type /help for available commands.`);
        return;
      }

      try {
        const result = await cmd.handler(parsed.args, commandContext);
        pushOutput('result', result);
      } catch (err) {
        pushOutput('error', `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [pushOutput, commandContext]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setSuggestions([]);
        executeCommand(input);
        setInput('');
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestions([]);
        setHistoryIndex((prev) => {
          const next = Math.min(prev + 1, commandHistory.length - 1);
          if (commandHistory[next] !== undefined) {
            setInput(commandHistory[next]);
          }
          return next;
        });
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestions([]);
        setHistoryIndex((prev) => {
          const next = Math.max(prev - 1, -1);
          setInput(next === -1 ? '' : commandHistory[next] ?? '');
          return next;
        });
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        if (suggestions.length === 1) {
          setInput(suggestions[0].usage.split(' ')[0] + ' ');
          setSuggestions([]);
        } else if (suggestions.length > 1) {
          // Complete to longest common prefix
          const prefix = suggestions.reduce((acc, cmd) => {
            const name = cmd.name;
            let i = 0;
            while (i < acc.length && i < name.length && acc[i] === name[i]) i++;
            return acc.slice(0, i);
          }, suggestions[0].name);
          if (prefix) {
            setInput('/' + prefix);
            setSuggestions(filterCommands('/' + prefix));
          }
        }
        return;
      }

      if (e.key === 'Escape') {
        setSuggestions([]);
        return;
      }

      // Update autocomplete suggestions
      if (input.startsWith('/')) {
        setSuggestions(filterCommands(input));
      } else {
        setSuggestions([]);
      }
    },
    [input, commandHistory, suggestions, executeCommand]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInput(val);
      if (val.startsWith('/')) {
        setSuggestions(filterCommands(val));
      } else {
        setSuggestions([]);
      }
    },
    []
  );

  const handleSuggestionClick = useCallback(
    (usage: string) => {
      const cmdPart = usage.split(' ')[0] + ' ';
      setInput(cmdPart);
      setSuggestions([]);
      inputRef.current?.focus();
    },
    []
  );

  return (
    <div
      className="flex flex-col h-full bg-[#0a0a0a] font-mono"
      style={{ fontFamily: '"Geist Mono", "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Menlo, monospace' }}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Output area */}
      <div
        ref={outputRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1"
      >
        {/* Welcome message */}
        {history.length === 0 && (
          <div className="text-[11px] text-[#6b7280] leading-relaxed">
            <div className="mb-2">Hermes Terminal — type <span className="text-[#a855f7]">/help</span> for available commands.</div>
          </div>
        )}

        {history.map((entry) => (
          <div key={entry.id} className="text-[12px] leading-[18px] whitespace-pre-wrap break-all">
            {entry.type === 'command' ? (
              <div className="text-[#22c55e]">
                <span className="select-none opacity-60">{PROMPT}</span>
                {entry.content}
              </div>
            ) : entry.type === 'error' ? (
              <div className="text-[#f87171]">{entry.content}</div>
            ) : entry.type === 'info' ? (
              <div className="text-[#60a5fa]">{entry.content}</div>
            ) : (
              <div className="text-[#e4e4e7] whitespace-pre-wrap">{entry.content}</div>
            )}
          </div>
        ))}

        {/* Autocomplete suggestions dropdown */}
        {suggestions.length > 0 && (
          <div className="mt-1 mb-1 border border-[#2a2a2a] rounded-md bg-[#111] overflow-hidden">
            {suggestions.map((cmd) => (
              <button
                key={cmd.name}
                onClick={() => handleSuggestionClick(cmd.usage)}
                className="w-full flex items-start gap-3 px-2.5 py-1.5 hover:bg-[#1a1a1a] transition-colors text-left"
              >
                <span className="text-[11px] text-[#a855f7] shrink-0 mt-px">
                  {cmd.usage.split('|')[0].trim()}
                </span>
                <span className="text-[11px] text-[#6b7280] truncate">
                  {cmd.description}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 border-t border-[#1e1e1e] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[#22c55e] text-[12px] select-none flex-shrink-0">{PROMPT}</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-[12px] text-[#e4e4e7] placeholder:text-[#4b4b4b] outline-none"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
};
