import { useState, useEffect, useRef } from "react";
import { useHermesStatus } from "./useHermesStatus";
import { cn } from "@/lib/utils";

type HermesState = "online" | "recent-loss" | "offline";

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function useRelativeTick(iso: string | null): string {
  const [label, setLabel] = useState(() => relativeTime(iso));
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setLabel(relativeTime(iso));
    intervalRef.current = setInterval(() => {
      setLabel(relativeTime(iso));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [iso]);

  return label;
}

function getState(online: boolean, lastSeen: string | null): HermesState {
  if (online) return "online";
  if (!lastSeen) return "offline";
  const diff = Date.now() - new Date(lastSeen).getTime();
  return diff < 60_000 ? "recent-loss" : "offline";
}

const DOT_CLASSES: Record<HermesState, string> = {
  online: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]",
  "recent-loss": "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.5)]",
  offline: "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]",
};

const DOT_LABEL: Record<HermesState, string> = {
  online: "Online",
  "recent-loss": "Recently lost",
  offline: "Offline",
};

export default function StatusCard() {
  const { online, lastSeen, host, profile, loading } = useHermesStatus();
  const state = getState(online, lastSeen);
  const relativeLabel = useRelativeTick(lastSeen);

  if (loading) {
    return (
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 space-y-2 animate-pulse">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-4 w-48 bg-muted rounded" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 space-y-2">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            "inline-block w-2.5 h-2.5 rounded-full flex-shrink-0",
            DOT_CLASSES[state],
          )}
          aria-hidden
        />
        <span className="text-sm font-medium leading-none">{DOT_LABEL[state]}</span>
        <span className="text-xs text-muted-foreground leading-none ml-auto">
          {host && profile ? `${host} · ${profile}` : host || profile || "—"}
        </span>
      </div>

      <p className="text-xs text-muted-foreground leading-none">
        Last seen: {relativeLabel}
      </p>

      {!online && (
        <p className="text-xs text-muted-foreground/60 leading-none italic">
          Revival actions below
        </p>
      )}
    </div>
  );
}
