import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from './ChatPanel';
import { usePanelStore } from '@/stores/panel-store';

interface ChatPanelContainerProps {
  onOpenPR?: (panelId: string, mode?: 'create' | 'review') => void;
}

// Grid shape by panel count: 1 → single, 2 → side-by-side, 3-4 → 2×2,
// 5-6 → 3×2, beyond → 3 columns with as many rows as needed.
function gridColumns(count: number): number {
  if (count <= 2) return count || 1;
  if (count <= 4) return 2;
  return 3;
}

/** Smallest fraction a track may shrink to, relative to an even split. */
const MIN_TRACK_FR = 0.35;

/** A draggable divider over a grid gap. Adjusts the fr pair around `index`. */
const TrackResizeHandle: React.FC<{
  orientation: 'col' | 'row';
  /** Handle sits between track `index` and `index + 1`. */
  index: number;
  /** Position along the axis, as a percentage of the container. */
  positionPct: number;
  containerRef: React.RefObject<HTMLDivElement>;
  fractions: number[];
  onResize: (next: number[]) => void;
}> = ({ orientation, index, positionPct, containerRef, fractions, onResize }) => {
  const dragRef = useRef<{ start: number; startFr: number[] } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      start: orientation === 'col' ? e.clientX : e.clientY,
      startFr: [...fractions],
    };
  }, [fractions, orientation]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const size = orientation === 'col' ? container.clientWidth : container.clientHeight;
    if (size <= 0) return;
    const delta = ((orientation === 'col' ? e.clientX : e.clientY) - drag.start) / size;
    const total = drag.startFr.reduce((a, b) => a + b, 0);
    const deltaFr = delta * total;
    const grown = drag.startFr[index] + deltaFr;
    const shrunk = drag.startFr[index + 1] - deltaFr;
    const min = MIN_TRACK_FR * (total / drag.startFr.length);
    if (grown < min || shrunk < min) return;
    const next = [...drag.startFr];
    next[index] = grown;
    next[index + 1] = shrunk;
    onResize(next);
  }, [containerRef, index, onResize, orientation]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const isCol = orientation === 'col';
  return (
    <div
      role="separator"
      aria-orientation={isCol ? 'vertical' : 'horizontal'}
      className={
        'group absolute z-20 ' +
        (isCol
          ? 'top-0 h-full w-[7px] -translate-x-1/2 cursor-col-resize'
          : 'left-0 h-[7px] w-full -translate-y-1/2 cursor-row-resize')
      }
      style={isCol ? { left: `${positionPct}%` } : { top: `${positionPct}%` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div
        className={
          'absolute bg-transparent transition-colors duration-100 group-hover:bg-primary/50 group-active:bg-primary/70 ' +
          (isCol
            ? 'left-1/2 top-0 h-full w-[2px] -translate-x-1/2'
            : 'left-0 top-1/2 h-[2px] w-full -translate-y-1/2')
        }
      />
    </div>
  );
};

/** Cumulative percentage offsets of the gaps between tracks. */
function handlePositions(fractions: number[]): number[] {
  const total = fractions.reduce((a, b) => a + b, 0);
  const positions: number[] = [];
  let acc = 0;
  for (let i = 0; i < fractions.length - 1; i++) {
    acc += fractions[i];
    positions.push((acc / total) * 100);
  }
  return positions;
}

export const ChatPanelContainer: React.FC<ChatPanelContainerProps> = ({ onOpenPR }) => {
  const { panels, focusedPanelId, focusPanel, closePanel } = usePanelStore();

  // One stable tree shape for every panel count. Switching layouts by count
  // (bare panel ↔ split ↔ grid) remounts ChatPanel when panels are added or
  // closed, which destroys the useChat instance — aborting an in-flight
  // stream and dropping its unpersisted messages/tool calls. A panel's mount
  // must never depend on how many siblings it has, so the layout is a single
  // flat CSS grid whose template changes via styles only. Resizing likewise
  // only adjusts the grid's fr fractions — never the tree.
  const closable = panels.length > 1;
  const cols = gridColumns(panels.length);
  const rows = Math.max(1, Math.ceil(panels.length / cols));
  const remainder = panels.length % cols;

  const containerRef = useRef<HTMLDivElement>(null);
  const [colFr, setColFr] = useState<number[]>(() => Array(cols).fill(1));
  const [rowFr, setRowFr] = useState<number[]>(() => Array(rows).fill(1));

  // Reset to an even split when the grid shape changes.
  useEffect(() => { setColFr(Array(cols).fill(1)); }, [cols]);
  useEffect(() => { setRowFr(Array(rows).fill(1)); }, [rows]);

  const safeColFr = colFr.length === cols ? colFr : Array(cols).fill(1);
  const safeRowFr = rowFr.length === rows ? rowFr : Array(rows).fill(1);

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full gap-px bg-border"
      style={{
        gridTemplateColumns: safeColFr.map((f) => `minmax(0, ${f}fr)`).join(' '),
        gridTemplateRows: safeRowFr.map((f) => `minmax(0, ${f}fr)`).join(' '),
      }}
    >
      {panels.map((panel, i) => {
        // Let a trailing odd panel span the leftover columns so the grid
        // stays filled (e.g. 3 panels → 2 on top, 1 full-width below).
        const isTrailingOdd = remainder !== 0 && i === panels.length - 1;
        return (
          <div
            key={panel.id}
            className="min-h-0 min-w-0 overflow-hidden bg-background"
            style={isTrailingOdd ? { gridColumn: `span ${cols - remainder + 1}` } : undefined}
          >
            <ChatPanel
              panelId={panel.id}
              conversationId={panel.conversationId}
              isFocused={panels.length === 1 || panel.id === focusedPanelId}
              onFocus={() => focusPanel(panel.id)}
              onClose={closable ? () => closePanel(panel.id) : undefined}
              onOpenPR={onOpenPR}
            />
          </div>
        );
      })}
      {safeColFr.length > 1 && handlePositions(safeColFr).map((pct, i) => (
        <TrackResizeHandle
          key={`col-${i}`}
          orientation="col"
          index={i}
          positionPct={pct}
          containerRef={containerRef}
          fractions={safeColFr}
          onResize={setColFr}
        />
      ))}
      {safeRowFr.length > 1 && handlePositions(safeRowFr).map((pct, i) => (
        <TrackResizeHandle
          key={`row-${i}`}
          orientation="row"
          index={i}
          positionPct={pct}
          containerRef={containerRef}
          fractions={safeRowFr}
          onResize={setRowFr}
        />
      ))}
    </div>
  );
};
