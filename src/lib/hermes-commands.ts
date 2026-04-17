export interface CommandContext {
  setActiveSubTab: (tab: 'overview' | 'threads' | 'chats' | 'cron' | 'memories' | 'skills' | 'usage') => void;
  setActiveTab: (tab: 'chat' | 'github' | 'analyzer' | 'knowledge') => void;
  setMiniBrowserOpen: (open: boolean) => void;
  setMiniBrowserUrl: (url: string) => void;
  newConversation?: () => void;
  setConversationForPanel?: (panelId: string, conversationId: string | null) => void;
  openPanel?: (conversationId: string | null) => void;
  resetSession?: () => void;
  stopAgent?: () => void;
  renameConversation?: (title: string) => void;
  retryMessage?: () => void;
  undoMessage?: () => void;
  approveCommand?: () => void;
  denyCommand?: () => void;
  compressContext?: () => void;
}

function callbackUnavailable(): string {
  return 'This command is not available in the current context.';
}

export interface HermesCommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string, context: CommandContext) => Promise<string>;
}

const COMMANDS: HermesCommand[] = [
  // ── Navigation ───────────────────────────────────────────────
  {
    name: 'overview',
    description: 'Open the Hermes overview tab',
    usage: '/overview',
    handler: async (_args, context) => {
      context.setActiveSubTab('overview');
      return 'Switched to Overview tab.';
    },
  },
  {
    name: 'cron',
    description: 'Manage cron jobs',
    usage: '/cron list | /cron create <schedule> <prompt> | /cron pause <id> | /cron resume <id> | /cron delete <id>',
    handler: async (args, context) => {
      context.setActiveSubTab('cron');
      const parts = args.trim().split(/\s+/);
      const action = parts[0]?.toLowerCase();

      if (!action) {
        return 'Switched to Cron tab. Use /cron list to see jobs.';
      }

      switch (action) {
        case 'list':
          return 'Switched to Cron tab. Listing cron jobs...';
        case 'create':
          return 'Switched to Cron tab. Use the Cron tab UI to create a new job.';
        case 'pause':
          return `Switched to Cron tab. Pausing cron job ${parts[1] || ''}...`;
        case 'resume':
          return `Switched to Cron tab. Resuming cron job ${parts[1] || ''}...`;
        case 'delete':
          return `Switched to Cron tab. Deleting cron job ${parts[1] || ''}...`;
        default:
          return `Unknown cron action: ${action}. Available: list, create, pause, resume, delete`;
      }
    },
  },
  {
    name: 'memories',
    description: 'Open the Hermes memories editor',
    usage: '/memories',
    handler: async (_args, context) => {
      context.setActiveSubTab('memories');
      return 'Switched to Memories tab.';
    },
  },
  {
    name: 'skills',
    description: 'Open the Hermes skills browser',
    usage: '/skills',
    handler: async (_args, context) => {
      context.setActiveSubTab('skills');
      return 'Switched to Skills tab.';
    },
  },
  {
    name: 'usage',
    description: 'Open the Hermes usage dashboard',
    usage: '/usage',
    handler: async (_args, context) => {
      context.setActiveSubTab('usage');
      return 'Switched to Usage tab.';
    },
  },
  {
    name: 'sessions',
    description: 'Switch to Sessions tab',
    usage: '/sessions',
    handler: async (_args, context) => {
      context.setActiveSubTab('chats');
      return 'Switched to Sessions tab.';
    },
  },
  {
    name: 'chats',
    description: 'Switch to Sessions tab',
    usage: '/chats',
    handler: async (_args, context) => {
      context.setActiveSubTab('chats');
      return 'Switched to Sessions tab.';
    },
  },
  {
    name: 'threads',
    description: 'Switch to Threads tab',
    usage: '/threads',
    handler: async (_args, context) => {
      context.setActiveSubTab('threads');
      return 'Switched to Threads tab.';
    },
  },
  {
    name: 'github',
    description: 'Switch to GitHub tab',
    usage: '/github',
    handler: async (_args, context) => {
      context.setActiveTab('github');
      return 'Switched to GitHub tab.';
    },
  },
  {
    name: 'analyzer',
    description: 'Switch to Analyzer tab',
    usage: '/analyzer',
    handler: async (_args, context) => {
      context.setActiveTab('analyzer');
      return 'Switched to Analyzer tab.';
    },
  },
  {
    name: 'knowledge',
    description: 'Switch to Knowledge tab',
    usage: '/knowledge',
    handler: async (_args, context) => {
      context.setActiveTab('knowledge');
      return 'Switched to Knowledge tab.';
    },
  },
  {
    name: 'browse',
    description: 'Open the mini-browser with a URL',
    usage: '/browse <url>',
    handler: async (args, context) => {
      const url = args.trim();
      if (!url) {
        return 'Usage: /browse <url>';
      }

      let resolvedUrl = url;
      if (!/^https?:\/\//i.test(resolvedUrl)) {
        resolvedUrl = `https://${resolvedUrl}`;
      }

      context.setMiniBrowserUrl(resolvedUrl);
      context.setMiniBrowserOpen(true);
      return `Opening ${resolvedUrl} in mini-browser.`;
    },
  },

  // ── Conversation ─────────────────────────────────────────────
  {
    name: 'new',
    description: 'Start a new conversation',
    usage: '/new',
    handler: async (_args, context) => {
      if (!context.newConversation) return callbackUnavailable();
      context.newConversation();
      return 'Starting new conversation.';
    },
  },
  {
    name: 'reset',
    description: 'Reset the current conversation session',
    usage: '/reset',
    handler: async (_args, context) => {
      if (!context.resetSession) return callbackUnavailable();
      context.resetSession();
      return 'Conversation session reset.';
    },
  },
  {
    name: 'stop',
    description: 'Stop the running agent',
    usage: '/stop',
    handler: async (_args, context) => {
      if (!context.stopAgent) return callbackUnavailable();
      context.stopAgent();
      return 'Agent stopped.';
    },
  },
  {
    name: 'title',
    description: 'Set the conversation title',
    usage: '/title <name>',
    handler: async (args, context) => {
      const title = args.trim();
      if (!title) return 'Usage: /title <name>';
      if (!context.renameConversation) return callbackUnavailable();
      context.renameConversation(title);
      return `Conversation renamed to "${title}".`;
    },
  },
  {
    name: 'retry',
    description: 'Retry the last message',
    usage: '/retry',
    handler: async (_args, context) => {
      if (!context.retryMessage) return callbackUnavailable();
      context.retryMessage();
      return 'Retrying last message.';
    },
  },
  {
    name: 'undo',
    description: 'Remove the last exchange',
    usage: '/undo',
    handler: async (_args, context) => {
      if (!context.undoMessage) return callbackUnavailable();
      context.undoMessage();
      return 'Last exchange removed.';
    },
  },

  // ── Moderation ────────────────────────────────────────────────
  {
    name: 'approve',
    description: 'Approve the pending dangerous command',
    usage: '/approve',
    handler: async (_args, context) => {
      if (!context.approveCommand) return callbackUnavailable();
      context.approveCommand();
      return 'Approved.';
    },
  },
  {
    name: 'deny',
    description: 'Deny the pending dangerous command',
    usage: '/deny',
    handler: async (_args, context) => {
      if (!context.denyCommand) return callbackUnavailable();
      context.denyCommand();
      return 'Denied.';
    },
  },

  // ── Context ───────────────────────────────────────────────────
  {
    name: 'compress',
    description: 'Manually trigger context compression',
    usage: '/compress',
    handler: async (_args, _context) => {
      return 'Context compression requested.';
    },
  },

  // ── Filesystem ───────────────────────────────────────────────
  {
    name: 'rollback',
    description: 'List or restore filesystem checkpoints',
    usage: '/rollback [number]',
    handler: async (_args, _context) => {
      return 'Rollback listing not yet available from UI.';
    },
  },
  {
    name: 'resume',
    description: 'Resume a named session',
    usage: '/resume <name>',
    handler: async (args, _context) => {
      const name = args.trim();
      if (!name) return 'Usage: /resume <name>';
      return 'Session resume not yet available from UI.';
    },
  },

  // ── Meta ──────────────────────────────────────────────────────
  {
    name: 'help',
    description: 'List available hermes commands',
    usage: '/help',
    handler: async () => {
      const lines = COMMANDS.map(
        (cmd) => `  ${cmd.usage.split('|')[0].trim()}  — ${cmd.description}`
      );
      return 'Hermes Commands:\n' + lines.join('\n');
    },
  },
];

export { COMMANDS };

export function parseCommand(
  input: string
): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: '' };
  }

  return {
    command: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1),
  };
}

export function findCommand(name: string): HermesCommand | undefined {
  return COMMANDS.find((cmd) => cmd.name === name);
}

export function filterCommands(partial: string): HermesCommand[] {
  const query = partial.toLowerCase().replace(/^\//, '');
  if (!query) return COMMANDS;
  return COMMANDS.filter(
    (cmd) =>
      cmd.name.startsWith(query) ||
      cmd.description.toLowerCase().includes(query)
  );
}
