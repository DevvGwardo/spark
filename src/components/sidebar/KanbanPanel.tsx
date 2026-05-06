import React, { useEffect, useState, useMemo } from 'react';
import { Plus, Trash2, Loader2, Columns3, ChevronDown, ChevronRight, LayoutPanelTop } from 'lucide-react';
import { useKanbanStore, type KanbanCard, type KanbanLane } from '@/stores/kanban-store';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';

const LANE_CONFIG: Record<KanbanLane, { label: string; color: string }> = {
  backlog: { label: 'Backlog', color: 'bg-zinc-500' },
  ready: { label: 'Ready', color: 'bg-blue-500' },
  running: { label: 'Running', color: 'bg-amber-500' },
  review: { label: 'Review', color: 'bg-purple-500' },
  blocked: { label: 'Blocked', color: 'bg-red-500' },
  done: { label: 'Done', color: 'bg-emerald-500' },
};

const LANE_ORDER: KanbanLane[] = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'];

export function KanbanPanel() {
  const { cards, loading, fetchCards, createCard, deleteCard } = useKanbanStore();
  const [quickInput, setQuickInput] = useState('');
  const [filterLane, setFilterLane] = useState<KanbanLane | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  const filteredCards = useMemo(() => {
    if (!filterLane) return cards;
    return cards.filter((c) => c.status === filterLane);
  }, [cards, filterLane]);

  const laneCounts = useMemo(() => {
    const counts: Partial<Record<KanbanLane, number>> = {};
    for (const lane of LANE_ORDER) {
      counts[lane] = cards.filter((c) => c.status === lane).length;
    }
    return counts;
  }, [cards]);

  const handleQuickAdd = async () => {
    const title = quickInput.trim();
    if (!title) return;
    try {
      await createCard({
        title,
        spec: '',
        acceptanceCriteria: [],
        assignedWorker: '',
        reviewer: '',
        status: filterLane || 'backlog',
        missionId: '',
        reportPath: '',
        createdBy: '',
      });
      setQuickInput('');
    } catch {
      // error handled in store
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCard(id);
      setDeleteConfirm(null);
    } catch {
      // error handled in store
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Kanban
          </span>
          <span className="text-[11px] font-mono text-muted-foreground/50">{cards.length}</span>
        </div>
      </div>

      {/* Quick-add input */}
      <div className="px-3 pb-2">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleQuickAdd();
            }}
            placeholder="Quick add card..."
            className="h-7 flex-1 rounded-md border border-border/60 bg-background/60 px-2 text-[11px] placeholder:text-muted-foreground/40 focus:border-primary/60 focus:outline-none"
          />
          <button
            onClick={handleQuickAdd}
            disabled={!quickInput.trim()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground disabled:opacity-40"
            title="Add card"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Lane filter chips */}
      <div className="flex flex-wrap gap-1 px-3 pb-2">
        <button
          onClick={() => setFilterLane(null)}
          className={cn(
            'rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors',
            !filterLane
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border/40 text-muted-foreground/60 hover:border-border/70 hover:text-foreground'
          )}
        >
          All
        </button>
        {LANE_ORDER.map((lane) => {
          const cfg = LANE_CONFIG[lane];
          return (
            <button
              key={lane}
              onClick={() => setFilterLane(filterLane === lane ? null : lane)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors',
                filterLane === lane
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border/40 text-muted-foreground/60 hover:border-border/70 hover:text-foreground'
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', cfg.color)} />
              {cfg.label}
              <span className="font-mono text-[9px] opacity-60">{laneCounts[lane] || 0}</span>
            </button>
          );
        })}
      </div>

      {/* Card list */}
      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {loading && cards.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground/60">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Loading cards...</span>
          </div>
        )}

        {filteredCards.map((card) => {
          const laneCfg = LANE_CONFIG[card.status];
          return (
            <div
              key={card.id}
              className={cn(
                'group relative rounded-lg border px-2.5 py-2 transition-colors',
                expandedId === card.id
                  ? 'border-primary/30 bg-primary/[0.03]'
                  : 'border-border/30 bg-background/30 hover:border-border/60 hover:bg-background/50'
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', laneCfg.color)} />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-[12px] font-medium cursor-pointer',
                    'text-foreground/90'
                  )}
                  onClick={() => setExpandedId(expandedId === card.id ? null : card.id)}
                >
                  {card.title}
                </span>
                <span className="shrink-0 rounded-md border border-border/30 bg-background/50 px-1.5 py-px text-[9px] font-medium text-muted-foreground/70">
                  {laneCfg.label}
                </span>
              </div>

              {/* Worker */}
              {card.assignedWorker && (
                <div className="mt-1 pl-3.5 text-[10px] text-muted-foreground/50">
                  @{card.assignedWorker}
                </div>
              )}

              {/* Expanded spec preview */}
              {expandedId === card.id && (
                <div className="mt-2 space-y-1.5 border-t border-border/20 pt-2 pl-3.5">
                  {card.spec && (
                    <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                      {card.spec}
                    </p>
                  )}
                  {card.acceptanceCriteria.length > 0 && (
                    <ul className="list-inside list-disc space-y-0.5">
                      {card.acceptanceCriteria.map((c, i) => (
                        <li key={i} className="text-[10px] text-muted-foreground/60">{c}</li>
                      ))}
                    </ul>
                  )}
                  {card.reviewer && (
                    <div className="text-[10px] text-muted-foreground/50">
                      Reviewer: @{card.reviewer}
                    </div>
                  )}
                </div>
              )}

              {/* Delete button */}
              <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {deleteConfirm === card.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(card.id)}
                      className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/30"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(null)}
                      className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-background/50"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setDeleteConfirm(card.id)}
                    className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
                    title="Delete card"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {filteredCards.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/50">
            <Columns3 className="mb-2 h-7 w-7 opacity-40" />
            <span className="text-[11px]">No cards yet</span>
            <span className="mt-1 text-[10px] opacity-60">Add one with the input above</span>
          </div>
        )}
      </div>
    </div>
  );
}
