import type React from 'react';
import {
  MessageSquare, House, CornerDownLeft, Kanban, Repeat, Zap, BookOpen, Sparkles, Clock,
  User, MessagesSquare, Users, ListChecks, BarChart3, Plug, Image, Server,
} from 'lucide-react';
import type { SubTab } from '@/stores/ui-store';

// Ordered by how often each surface gets opened, not alphabetically. The first
// `PRIMARY_TAB_COUNT` entries sit in the always-visible grid row; the rest are
// behind the "More" toggle, which auto-expands when one of them is active.
//
// `logs`, `webhooks` and `pairing` used to live here, but every one of their
// bridge endpoints returns 404, so each was a permanent error banner.
export const HERMES_SUB_TABS: Array<{ key: SubTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'threads', label: 'Threads', icon: MessageSquare },
  { key: 'overview', label: 'Overview', icon: House },
  { key: 'queue', label: 'Queue', icon: CornerDownLeft },
  { key: 'kanban', label: 'Board', icon: Kanban },
  { key: 'ralph', label: 'Ralph', icon: Repeat },
  { key: 'chats', label: 'Sessions', icon: Zap },
  { key: 'memories', label: 'Memories', icon: BookOpen },
  { key: 'skills', label: 'Skills', icon: Sparkles },
  { key: 'cron', label: 'Cron', icon: Clock },
  { key: 'profiles', label: 'Profiles', icon: User },
  { key: 'rooms', label: 'Rooms', icon: MessagesSquare },
  { key: 'teams', label: 'Teams', icon: Users },
  { key: 'tasks', label: 'Tasks', icon: ListChecks },
  { key: 'usage', label: 'Usage', icon: BarChart3 },
  { key: 'mcp', label: 'MCP', icon: Plug },
  { key: 'images', label: 'Images', icon: Image },
  { key: 'system', label: 'System', icon: Server },
];

/**
 * Tabs shown before the "More" toggle. Three plus the toggle fills one row of
 * the 4-column grid exactly; four would strand the toggle alone on a second row.
 */
export const PRIMARY_TAB_COUNT = 3;
