import * as React from 'react';
import { Command } from 'cmdk';
import { useShallow } from 'zustand/shallow';
import {
  Github,
  LayoutGrid,
  MessageSquare,
  Moon,
  PanelLeft,
  Pin,
  Plus,
  Settings,
  Smartphone,
  Sparkles,
  Sun,
  TerminalSquare,
} from 'lucide-react';
import { useChatStore } from '@/stores/chat-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore, type SettingsSection } from '@/stores/ui-store';
import { HERMES_SUB_TABS } from '@/components/sidebar/sidebar-sections';
import { paletteFilter } from '@/lib/palette-filter';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

/** How many recent threads the palette lists before the user types. */
const RECENT_THREAD_LIMIT = 8;

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'providers', label: 'Providers' },
  { id: 'github', label: 'GitHub' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'general', label: 'General' },
];

const ITEM_CLASS = cn(
  'flex h-8 cursor-pointer select-none items-center gap-2.5 rounded-md px-2 text-[13px] text-foreground/90',
  'data-[selected=true]:bg-foreground/[0.08] data-[selected=true]:text-foreground',
);
const GROUP_CLASS = cn(
  'px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2',
  '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase',
  '[&_[cmdk-group-heading]]:tracking-[1px] [&_[cmdk-group-heading]]:text-muted-foreground',
);

const Shortcut: React.FC<{ keys: string }> = ({ keys }) => (
  <kbd className="ml-auto font-mono text-[10px] text-muted-foreground">{keys}</kbd>
);

type ItemProps = {
  value: string;
  keywords?: string[];
  icon: React.ComponentType<{ className?: string }>;
  onSelect: () => void;
  children: React.ReactNode;
};

const Item: React.FC<ItemProps> = ({ value, keywords, icon: Icon, onSelect, children }) => (
  <Command.Item value={value} keywords={keywords} onSelect={onSelect} className={ITEM_CLASS}>
    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    {children}
  </Command.Item>
);

export const CommandPalette: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenRemoteAccess: () => void;
}> = ({ open, onOpenChange, onOpenRemoteAccess }) => {
  const conversations = useChatStore((s) => s.conversations);
  const openConversation = usePanelStore((s) => s.openConversation);
  const { theme, setTheme, isHermes } = useSettingsStore(
    useShallow((s) => ({ theme: s.theme, setTheme: s.setTheme, isHermes: s.activeProvider === 'hermes' })),
  );
  const ui = useUIStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveSubTab: s.setActiveSubTab,
      setSidebarOpen: s.setSidebarOpen,
      toggleSidebar: s.toggleSidebar,
      setSettingsOpen: s.setSettingsOpen,
      setRepoBrowserOpen: s.setRepoBrowserOpen,
      toggleTerminal: s.toggleTerminal,
      toggleHermesTerminal: s.toggleHermesTerminal,
    })),
  );
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const threads = React.useMemo(() => {
    const sorted = [...conversations].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    // Before typing, show only the most recent; once searching, match all.
    return search ? sorted : sorted.slice(0, RECENT_THREAD_LIMIT);
  }, [conversations, search]);

  /** Close first so the palette never sits on top of what the action opens. */
  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  const isDark =
    theme === 'dark' ||
    (theme === 'system' && typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      loop
      filter={paletteFilter}
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      contentClassName={cn(
        'fixed left-1/2 top-[14vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden',
        'rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-[0.98] motion-safe:duration-100',
      )}
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder="Search commands and threads…"
        className="h-11 w-full border-b border-border bg-transparent px-4 text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto overscroll-contain py-1">
        <Command.Empty className="px-4 py-6 text-center text-[13px] text-muted-foreground">
          No matches for “{search}”
        </Command.Empty>

        <Command.Group heading="Actions" className={GROUP_CLASS}>
          <Item value="New thread" keywords={['chat', 'conversation', 'create']} icon={Plus} onSelect={run(() => { ui.setActiveTab('chat'); openConversation(null); })}>
            New thread
          </Item>
          <Item value="Browse repo issues" keywords={['github', 'pr', 'pull request']} icon={Github} onSelect={run(() => ui.setRepoBrowserOpen(true))}>
            Browse repo issues
          </Item>
          <Item value="Toggle terminal" keywords={['shell', 'console']} icon={TerminalSquare} onSelect={run(ui.toggleTerminal)}>
            Toggle terminal
            <Shortcut keys="⌃`" />
          </Item>
          {isHermes && (
            <Item value="Toggle Hermes terminal" keywords={['agent', 'pty']} icon={Sparkles} onSelect={run(ui.toggleHermesTerminal)}>
              Toggle Hermes terminal
            </Item>
          )}
          <Item value="Toggle sidebar" keywords={['hide', 'show', 'panel']} icon={PanelLeft} onSelect={run(ui.toggleSidebar)}>
            Toggle sidebar
          </Item>
          <Item
            value={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            keywords={['theme', 'appearance', 'mode']}
            icon={isDark ? Sun : Moon}
            onSelect={run(() => setTheme(isDark ? 'light' : 'dark'))}
          >
            {isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          </Item>
          <Item value="Remote access" keywords={['qr', 'phone', 'mobile']} icon={Smartphone} onSelect={run(onOpenRemoteAccess)}>
            Remote access
          </Item>
        </Command.Group>

        {threads.length > 0 && (
          <Command.Group heading={search ? 'Threads' : 'Recent threads'} className={GROUP_CLASS}>
            {threads.map((c) => (
              <Item
                key={c.id}
                // cmdk dedupes by value, so the id keeps same-titled threads distinct.
                value={`${c.title || 'Untitled'} ${c.id}`}
                keywords={['thread']}
                icon={c.pinned ? Pin : MessageSquare}
                onSelect={run(() => { ui.setActiveTab('chat'); openConversation(c.id); })}
              >
                <span className="min-w-0 flex-1 truncate">{c.title || 'Untitled'}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{relativeTime(c.updatedAt)}</span>
              </Item>
            ))}
          </Command.Group>
        )}

        {isHermes && (
          <Command.Group heading="Go to" className={GROUP_CLASS}>
            {HERMES_SUB_TABS.map(({ key, label, icon }) => (
              <Item
                key={key}
                value={`Go to ${label}`}
                keywords={['section', 'sidebar', key]}
                icon={icon}
                onSelect={run(() => { ui.setSidebarOpen(true); ui.setActiveSubTab(key); })}
              >
                {label}
              </Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Settings" className={GROUP_CLASS}>
          {SETTINGS_SECTIONS.map(({ id, label }) => (
            <Item
              key={id}
              value={`Settings ${label}`}
              keywords={['preferences', 'config']}
              icon={id === 'github' ? Github : id === 'providers' ? LayoutGrid : Settings}
              onSelect={run(() => ui.setSettingsOpen(true, id))}
            >
              Settings: {label}
            </Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex h-8 items-center gap-3 border-t border-border px-3 font-mono text-[10px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
        <span className="ml-auto">⌘K</span>
      </div>
    </Command.Dialog>
  );
};
