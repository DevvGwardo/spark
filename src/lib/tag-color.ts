import { djb2Hash } from '@/lib/approval-policy';

export interface TagColor {
  bg: string;
  fg: string;
  ring: string;
}

// Dark-first palette. Translucent backgrounds and a bright foreground so chips
// stay legible against the sidebar's `bg-transparent` / hover surfaces. Rings
// are only used when the tag is selected in the filter bar.
const PALETTE: readonly TagColor[] = [
  { bg: 'bg-sky-500/15', fg: 'text-sky-300', ring: 'ring-sky-500/40' },
  { bg: 'bg-emerald-500/15', fg: 'text-emerald-300', ring: 'ring-emerald-500/40' },
  { bg: 'bg-amber-500/15', fg: 'text-amber-300', ring: 'ring-amber-500/40' },
  { bg: 'bg-rose-500/15', fg: 'text-rose-300', ring: 'ring-rose-500/40' },
  { bg: 'bg-violet-500/15', fg: 'text-violet-300', ring: 'ring-violet-500/40' },
  { bg: 'bg-cyan-500/15', fg: 'text-cyan-300', ring: 'ring-cyan-500/40' },
  { bg: 'bg-fuchsia-500/15', fg: 'text-fuchsia-300', ring: 'ring-fuchsia-500/40' },
  { bg: 'bg-lime-500/15', fg: 'text-lime-300', ring: 'ring-lime-500/40' },
] as const;

export function tagColor(tag: string): TagColor {
  const normalized = tag.trim().toLowerCase();
  const hash = parseInt(djb2Hash(normalized), 16) || 0;
  return PALETTE[hash % PALETTE.length];
}
