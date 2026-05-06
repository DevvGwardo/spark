import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Trash2, MoreHorizontal, ChevronDown, ChevronUp, Loader2, GripVertical } from 'lucide-react';
import { useKanbanStore, type KanbanCard, type KanbanLane } from '@/stores/kanban-store';
import { CreateCardDialog } from '@/components/kanban/CreateCardDialog';
import { cn } from '@/lib/utils';

const LANES: { key: KanbanLane; label: string; color: string }[] = [
  { key: 'backlog', label: 'Backlog', color: 'bg-zinc-500' },
  { key: 'ready', label: 'Ready', color: 'bg-blue-500' },
  { key: 'running', label: 'Running', color: 'bg-amber-500' },
  { key: 'review', label: 'Review', color: 'bg-purple-500' },
  { key: 'blocked', label: 'Blocked', color: 'bg-red-500' },
  { key: 'done', label: 'Done', color: 'bg-emerald-500' },
];

const LANE_ORDER: KanbanLane[] = LANES.map((l) => l.key);

export function KanbanBoard() {
  const { cards, loading, error, fetchCards, deleteCard, moveCard } = useKanbanStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [createLane, setCreateLane] = useState<KanbanLane>('backlog');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [dragOverLane, setDragOverLane] = useState<KanbanLane | null>(null);
  const dragCardRef = useRef<{ id: string; fromLane: KanbanLane } | null>(null);

  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  // Close menus on outside click
  useEffect(() => {
    if (!menuId) return;
    const handler = () => setMenuId(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [menuId]);

  const handleDragStart = useCallback((card: KanbanCard) => {
    dragCardRef.current = { id: card.id, fromLane: card.status };
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, lane: KanbanLane) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverLane(lane);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverLane(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetLane: KanbanLane) => {
      e.preventDefault();
      setDragOverLane(null);
      const drag = dragCardRef.current;
      if (!drag) return;
      dragCardRef.current = null;
      if (drag.fromLane === targetLane) return;
      try {
        await moveCard(drag.id, targetLane);
      } catch {
        // error handled in store
      }
    },
    [moveCard]
  );

  const handleDelete = async (id: string) => {
    setMenuId(null);
    try {
      await deleteCard(id);
    } catch {
      // error handled in store
    }
  };

  const grouped = LANE_ORDER.reduce(
    (acc, lane) => {
      acc[lane] = cards.filter((c) => c.status === lane);
      return acc;
    },
    {} as Record<KanbanLane, KanbanCard[]>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">Kanban Board</span>
          <span className="text-[11px] font-mono text-muted-foreground/50">{cards.length}</span>
        </div>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
      </div>

      {error && (
        <div className="mx-4 mt-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {/* Board columns */}
      <div className="flex flex-1 gap-3 overflow-x-auto px-4 py-3">
        {LANES.map(({ key, label, color }) => {
          const laneCards = grouped[key];
          return (
            <div
              key={key}
              className={cn(
                'flex w-72 shrink-0 flex-col rounded-xl border transition-colors',
                dragOverLane === key
                  ? 'border-primary/40 bg-primary/[0.03]'
                  : 'border-border/30 bg-background/50'
              )}
              onDragOver={(e) => handleDragOver(e, key)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, key)}
            >
              {/* Column header */}
              <div className="flex items-center justify-between border-b border-border/20 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', color)} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/80">
                    {label}
                  </span>
                  <span className="text-[10px] font-mono text-muted-foreground/40">
                    {laneCards.length}
                  </span>
                </div>
                <button
                  onClick={() => {
                    setCreateLane(key);
                    setCreateOpen(true);
                  }}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:bg-background/80 hover:text-foreground"
                  title={`Add card to ${label}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Cards */}
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {laneCards.length === 0 && (
                  <div className="flex items-center justify-center py-6 text-[10px] text-muted-foreground/30">
                    Drop cards here
                  </div>
                )}
                {laneCards.map((card) => (
                  <div
                    key={card.id}
                    draggable
                    onDragStart={() => handleDragStart(card)}
                    className={cn(
                      'group cursor-grab rounded-lg border bg-card/60 px-3 py-2.5 transition-all active:cursor-grabbing',
                      'hover:border-border/60 hover:shadow-sm',
                      expandedId === card.id ? 'border-primary/30' : 'border-border/30'
                    )}
                  >
                    {/* Card header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground/20 opacity-0 transition-opacity group-hover:opacity-100" />
                        <span className="truncate text-[12px] font-medium text-foreground/90">
                          {card.title}
                        </span>
                      </div>
                      <div className="relative shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuId(menuId === card.id ? null : card.id);
                          }}
                          className="rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                          title="More actions"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                        {menuId === card.id && (
                          <div
                            className="absolute right-0 top-full z-50 mt-1 min-w-[100px] rounded-lg border border-border/50 bg-card py-1 shadow-lg"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={() => handleDelete(card.id)}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-red-400 transition-colors hover:bg-red-500/10"
                            >
                              <Trash2 className="h-3 w-3" />
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Worker + expand toggle */}
                    <div className="mt-1.5 flex items-center justify-between pl-5">
                      <div className="flex items-center gap-2">
                        {card.assignedWorker && (
                          <span className="truncate text-[10px] text-muted-foreground/60">
                            @{card.assignedWorker}
                          </span>
                        )}
                      </div>
                      {(card.spec || card.acceptanceCriteria.length > 0) && (
                        <button
                          onClick={() => setExpandedId(expandedId === card.id ? null : card.id)}
                          className="rounded p-0.5 text-muted-foreground/30 hover:text-foreground"
                        >
                          {expandedId === card.id ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Expanded detail */}
                    {expandedId === card.id && (
                      <div className="mt-2 space-y-2 border-t border-border/20 pt-2 pl-5">
                        {card.spec && (
                          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                            {card.spec}
                          </p>
                        )}
                        {card.acceptanceCriteria.length > 0 && (
                          <div>
                            <span className="text-[10px] font-medium text-foreground/60">
                              Acceptance Criteria:
                            </span>
                            <ul className="mt-0.5 list-inside list-disc space-y-0.5">
                              {card.acceptanceCriteria.map((c, i) => (
                                <li key={i} className="text-[10px] text-muted-foreground/70">
                                  {c}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {card.reviewer && (
                          <div className="text-[10px] text-muted-foreground/50">
                            Reviewer: @{card.reviewer}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <CreateCardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultLane={createLane}
      />
    </div>
  );
}
