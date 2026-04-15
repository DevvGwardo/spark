import React, { useEffect, useState } from 'react';
import { User, Plus, Trash2, Check, Loader2, Braces } from 'lucide-react';
import { useProfilesStore, type Profile } from '@/stores/profiles-store';
import { cn } from '@/lib/utils';

export function ProfilesPanel() {
  const { profiles, activeProfile, loading, fetchProfiles, activateProfile, createProfile, deleteProfile } = useProfilesStore();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [cloneFrom, setCloneFrom] = useState('default');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const handleActivate = async (name: string) => {
    setActivating(name);
    setError(null);
    try {
      await activateProfile(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to activate');
    } finally {
      setActivating(null);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setError(null);
    try {
      await createProfile(newName.trim(), cloneFrom);
      setNewName('');
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create');
    }
  };

  const handleDelete = async (name: string) => {
    setError(null);
    try {
      await deleteProfile(name);
      setDeleteConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Profiles</span>
        </div>
        <button
          onClick={() => setCreating(!creating)}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="New profile"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-destructive bg-destructive/10">{error}</div>
      )}

      {creating && (
        <div className="px-4 py-3 border-b border-border/40 space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Profile name"
            className="w-full text-sm px-2 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-accent-100"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <select
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-border bg-background flex-1"
            >
              <option value="default">Clone from: default</option>
              {profiles.filter((p) => p.name !== 'default').map((p) => (
                <option key={p.name} value={p.name}>Clone from: {p.name}</option>
              ))}
            </select>
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="text-xs px-2 py-1 rounded bg-accent-100 text-white hover:bg-accent-200 disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && profiles.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-xs">Loading profiles...</span>
          </div>
        )}

        {profiles.map((profile) => (
          <ProfileRow
            key={profile.name}
            profile={profile}
            isActive={profile.name === activeProfile}
            isActivating={activating === profile.name}
            isDeleting={deleteConfirm === profile.name}
            onActivate={() => handleActivate(profile.name)}
            onDelete={() => setDeleteConfirm(profile.name)}
            onDeleteConfirm={() => handleDelete(profile.name)}
            onDeleteCancel={() => setDeleteConfirm(null)}
          />
        ))}

        {profiles.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Braces className="h-8 w-8 mb-2 opacity-40" />
            <span className="text-xs">No Hermes profiles found</span>
            <span className="text-[10px] mt-1 opacity-60">~/.hermes/profiles/</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  isActive,
  isActivating,
  isDeleting,
  onActivate,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  profile: Profile;
  isActive: boolean;
  isActivating: boolean;
  isDeleting: boolean;
  onActivate: () => void;
  onDelete: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 border-b border-border/20 hover:bg-muted/40 transition-colors group',
        isActive && 'bg-accent-100/5',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('text-sm font-medium truncate', isActive && 'text-accent-100')}>
            {profile.name}
          </span>
          {isActive && (
            <Check className="h-3 w-3 text-accent-100 shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground/60">
          {profile.model && <span>{profile.model}</span>}
          <span>{profile.skillCount} skills</span>
          <span>{profile.sessionCount} sessions</span>
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {isDeleting ? (
          <>
            <button
              onClick={onDeleteConfirm}
              className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/20 text-destructive hover:bg-destructive/30"
            >
              Delete
            </button>
            <button
              onClick={onDeleteCancel}
              className="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {!isActive && (
              <button
                onClick={onActivate}
                disabled={isActivating}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent-100/10 text-accent-100 hover:bg-accent-100/20 disabled:opacity-50"
              >
                {isActivating ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Activate'}
              </button>
            )}
            {profile.name !== 'default' && (
              <button
                onClick={onDelete}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
