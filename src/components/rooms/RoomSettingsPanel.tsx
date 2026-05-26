import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { useRoomStore } from '@/stores/room-store';
import { useProfilesStore, type Profile } from '@/stores/profiles-store';
import { cn } from '@/lib/utils';

const PRESET_COLORS = ['#3b82f6', '#22c55e', '#f97316', '#ef4444', '#a855f7', '#ec4899', '#14b8a6'];

interface RoomSettingsPanelProps {
  roomId: string;
  onClose: () => void;
}

export const RoomSettingsPanel: React.FC<RoomSettingsPanelProps> = ({ roomId, onClose }) => {
  const { activeRoom, fetchRoom, addMember, removeMember } = useRoomStore();
  const profiles = useProfilesStore((s) => s.profiles);
  const getProfilesForRoomSelection = useProfilesStore((s) => s.getProfilesForRoomSelection);
  const [showAddMember, setShowAddMember] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [model, setModel] = useState('');

  useEffect(() => {
    void fetchRoom(roomId);
  }, [roomId, fetchRoom]);

  const members = activeRoom?.members ?? [];
  const availableProfiles = getProfilesForRoomSelection
    ? getProfilesForRoomSelection()
    : profiles.filter((p: Profile) => !p.name.startsWith('session-'));

  const handleAddMember = async () => {
    if (!selectedProfile) return;
    try {
      await addMember(roomId, {
        profileName: selectedProfile,
        displayName: displayName || selectedProfile,
        color,
        model,
      });
      setShowAddMember(false);
      setSelectedProfile(null);
      setDisplayName('');
      setColor(PRESET_COLORS[0]);
      setModel('');
    } catch (e) {
      console.error('Failed to add member:', e);
    }
  };

  const handleRemoveMember = async (profileName: string) => {
    try {
      await removeMember(roomId, profileName);
    } catch (e) {
      console.error('Failed to remove member:', e);
    }
  };

  const unselectedProfiles = availableProfiles.filter(
    (p: Profile) => !members.some((m) => m.profileName === p.name)
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#2F2F2F] px-3">
        <button
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
        <span className="text-[13px] font-medium text-[hsl(var(--text-primary))]">
          Room Settings
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        {/* Room info */}
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[1px] text-[#666666] mb-1.5">
            Room Name
          </label>
          <p className="text-[13px] text-[hsl(var(--text-primary))] font-medium">
            {activeRoom?.name ?? '—'}
          </p>
        </div>

        {/* Members list */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-[11px] font-semibold uppercase tracking-[1px] text-[#666666]">
              Members ({members.length})
            </label>
            <button
              onClick={() => setShowAddMember(!showAddMember)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-[hsl(var(--muted))] transition-colors"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          </div>

          <div className="space-y-1">
            {members.map((member) => (
              <div
                key={member.profileName}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-[hsl(var(--muted))]/40 transition-colors group"
              >
                <div
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: member.color }}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[13px] font-medium text-[hsl(var(--text-primary))] truncate">
                    {member.displayName}
                  </span>
                  <span className="text-[11px] text-muted-foreground/60 truncate">
                    {member.profileName} · {member.model || 'No model'}
                  </span>
                </div>
                <button
                  onClick={() => handleRemoveMember(member.profileName)}
                  className="rounded-md p-1 text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                  title="Remove member"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {members.length === 0 && (
              <p className="text-[12px] text-muted-foreground/50 py-2 text-center">No members</p>
            )}
          </div>
        </div>

        {/* Add member form */}
        {showAddMember && (
          <div className="rounded-lg border border-[#2F2F2F] p-3 space-y-3">
            <span className="text-[12px] font-medium text-[hsl(var(--text-primary))]">Add Member</span>

            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Profile</label>
              <select
                value={selectedProfile ?? ''}
                onChange={(e) => {
                  const name = e.target.value;
                  setSelectedProfile(name);
                  const p = availableProfiles.find((prof: Profile) => prof.name === name);
                  if (p) {
                    setDisplayName(p.name);
                    setModel(p.model ?? '');
                  }
                }}
                className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2.5 py-1.5 text-[12px] text-[hsl(var(--text-primary))] focus:border-[hsl(var(--ring))] focus:outline-none"
              >
                <option value="">Select a profile…</option>
                {unselectedProfiles.map((p: Profile) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Display Name</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2.5 py-1.5 text-[12px] text-[hsl(var(--text-primary))] focus:border-[hsl(var(--ring))] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Color</label>
              <div className="flex gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      'h-6 w-6 rounded-full transition-all',
                      color === c ? 'ring-2 ring-white ring-offset-1 ring-offset-[hsl(var(--card))]' : 'opacity-60 hover:opacity-100'
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Model</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-md border border-[#2F2F2F] bg-background/60 px-2.5 py-1.5 text-[12px] text-[hsl(var(--text-primary))] font-mono focus:border-[hsl(var(--ring))] focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowAddMember(false)}
                className="rounded-md px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleAddMember()}
                disabled={!selectedProfile}
                className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
