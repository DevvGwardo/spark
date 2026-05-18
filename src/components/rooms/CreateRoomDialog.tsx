import React, { useState } from 'react';
import { X, Check, Loader2 } from 'lucide-react';
import { useRoomStore, type Room } from '@/stores/room-store';
import { useProfilesStore, type Profile } from '@/stores/profiles-store';
import { cn } from '@/lib/utils';

const PRESET_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];

interface CreateRoomDialogProps {
  open: boolean;
  profiles: Profile[];
  profilesLoading?: boolean;
  onClose: () => void;
  onCreated: (room: Room) => void;
}

interface SelectedProfile {
  name: string;
  displayName: string;
  color: string;
  model: string;
}

export const CreateRoomDialog: React.FC<CreateRoomDialogProps> = ({ open, profiles, profilesLoading, onClose, onCreated }) => {
  const [roomName, setRoomName] = useState('');
  const [selected, setSelected] = useState<Record<string, SelectedProfile>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { createRoom, addMember } = useRoomStore();

  if (!open) return null;

  const toggleProfile = (profile: Profile) => {
    if (selected[profile.name]) {
      const next = { ...selected };
      delete next[profile.name];
      setSelected(next);
    } else {
      setSelected({
        ...selected,
        [profile.name]: {
          name: profile.name,
          displayName: profile.name,
          color: PRESET_COLORS[Object.keys(selected).length % PRESET_COLORS.length],
          model: profile.model ?? '',
        },
      });
    }
  };

  const updateSelected = (name: string, field: keyof SelectedProfile, value: string) => {
    setSelected((prev) => ({
      ...prev,
      [name]: { ...prev[name], [field]: value },
    }));
  };

  const handleCreate = async () => {
    const name = roomName.trim();
    if (!name) {
      setError('Room name is required');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const room = await createRoom(name);
      // Add each selected member sequentially
      for (const member of Object.values(selected)) {
        await addMember(room.id, {
          profileName: member.name,
          displayName: member.displayName,
          color: member.color,
          model: member.model,
        });
      }
      onCreated(room);
      // Reset form
      setRoomName('');
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create room');
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setRoomName('');
    setSelected({});
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="mx-4 w-full max-w-lg rounded-xl border border-[#2F2F2F] bg-[hsl(var(--card))] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2F2F2F] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-[hsl(var(--text-primary))]">Create Swarm Room</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-5 max-h-[60vh] overflow-y-auto">
          {/* Room name */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[1px] text-[#666666] mb-1.5">
              Room Name
            </label>
            <input
              autoFocus
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
              placeholder="e.g. Feature Planning"
              className="w-full rounded-lg border border-[#2F2F2F] bg-background/60 px-3 py-2 text-[13px] text-[hsl(var(--text-primary))] placeholder:text-muted-foreground/40 focus:border-[hsl(var(--ring))] focus:outline-none"
            />
          </div>

          {/* Member selection */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-[1px] text-[#666666] mb-2">
              Members ({Object.keys(selected).length} selected)
            </label>
            <div className="space-y-2">
              {profilesLoading ? (
                <div className="flex items-center gap-2 py-3 text-[12px] text-muted-foreground/60">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading profiles…</span>
                </div>
              ) : profiles.length === 0 ? (
                <p className="text-[12px] text-muted-foreground/60 py-2">No Hermes profiles found. Create one in Profiles tab first.</p>
              ) : (
                profiles.map((profile) => {
                  const isSelected = !!selected[profile.name];
                  const sel = selected[profile.name];
                  return (
                    <div
                      key={profile.name}
                      className={cn(
                        'rounded-lg border transition-colors',
                        isSelected
                          ? 'border-[hsl(var(--ring))]/40 bg-[hsl(var(--muted))]/50'
                          : 'border-[#2F2F2F] hover:border-[#3F3F3F]'
                      )}
                    >
                      {/* Profile checkbox row */}
                      <button
                        onClick={() => toggleProfile(profile)}
                        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                      >
                        <div
                          className={cn(
                            'flex h-4 w-4 items-center justify-center rounded border transition-colors',
                            isSelected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-[#2F2F2F]'
                          )}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                        </div>
                        <span className="flex-1 text-[13px] font-medium text-[hsl(var(--text-primary))]">
                          {profile.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground/60">
                          {profile.model || 'No model'}
                        </span>
                      </button>

                      {/* Expanded fields when selected */}
                      {isSelected && sel && (
                        <div className="border-t border-[#2F2F2F] px-3 py-2.5 space-y-2.5">
                          <div>
                            <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                              Display Name
                            </label>
                            <input
                              value={sel.displayName}
                              onChange={(e) => updateSelected(profile.name, 'displayName', e.target.value)}
                              className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2.5 py-1.5 text-[12px] text-[hsl(var(--text-primary))] focus:border-[hsl(var(--ring))] focus:outline-none"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                              Color
                            </label>
                            <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                              {PRESET_COLORS.map((c) => (
                                <button
                                  key={c}
                                  onClick={() => updateSelected(profile.name, 'color', c)}
                                  className={cn(
                                    'h-6 w-6 rounded-full transition-all',
                                    sel.color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-[hsl(var(--card))]' : 'opacity-60 hover:opacity-100'
                                  )}
                                  style={{ backgroundColor: c }}
                                />
                              ))}
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                              Model
                            </label>
                            <input
                              value={sel.model}
                              onChange={(e) => updateSelected(profile.name, 'model', e.target.value)}
                              className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2.5 py-1.5 text-[12px] text-[hsl(var(--text-primary))] font-mono focus:border-[hsl(var(--ring))] focus:outline-none"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {error && (
            <p className="text-[12px] text-destructive">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-[#2F2F2F] px-5 py-3">
          <button
            onClick={handleClose}
            className="rounded-lg px-4 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !roomName.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-[12px] font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
};
