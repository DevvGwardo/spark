"use client";

import * as React from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "cmdk";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  FilePlus,
  User,
  Sparkles,
  Clock,
  Image,
  Terminal,
  Moon,
} from "lucide-react";

const actions = [
  { id: "new-chat", label: "New chat", icon: FilePlus },
  { id: "switch-profile", label: "Switch profile", icon: User },
  { id: "open-skills-panel", label: "Open skills panel", icon: Sparkles },
  { id: "open-cron-jobs", label: "Open cron jobs", icon: Clock },
  { id: "open-images", label: "Open images", icon: Image },
  { id: "open-terminal", label: "Open terminal", icon: Terminal },
  { id: "toggle-dark-mode", label: "Toggle dark mode", icon: Moon },
];

export const CommandPalette: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const { setTheme, theme } = useTheme();

  const handleSelect = (actionId: string) => {
    if (actionId === "toggle-dark-mode") {
      setTheme(theme === "dark" ? "light" : "dark");
      onOpenChange(false);
      return;
    }

    const label = actions.find((a) => a.id === actionId)?.label || actionId;
    toast(`"${label}" coming soon`, { type: "info" });
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <Command shouldFilter={true}>
        <div className="flex items-center border-b px-3">
          <CommandInput
            placeholder="Type a command or search..."
            className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 border-none focus:ring-0"
          />
        </div>
        <CommandList className="max-h-[60vh] overflow-y-auto p-2">
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Actions" className="p-1">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <CommandItem
                  key={action.id}
                  value={action.label}
                  onSelect={() => handleSelect(action.id)}
                  className={cn(
                    "flex cursor-pointer select-none items-center rounded-sm px-3 py-2 text-sm outline-none",
                    "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                    "hover:bg-accent/50"
                  )}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{action.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
};
