import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Braces } from 'lucide-react';
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
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Profiles</span>
        <button
          onClick={() => setCreating(!creating)}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="New profile"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {creating && (
        <div className="mx-3 mb-2 space-y-2 rounded-xl border border-border/40 bg-background/40 p-3">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Profile name"
            className="w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-[12px] focus:border-primary/60 focus:outline-none"
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <select
              value={cloneFrom}
              onChange={(e) => setCloneFrom(e.target.value)}
              className="flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px]"
            >
              <option value="default">Clone from: default</option>
              {profiles.filter((p) => p.name !== 'default').map((p) => (
                <option key={p.name} value={p.name}>Clone from: {p.name}</option>
              ))}
            </select>
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Create
            </button>
            <button
              onClick={() => { setCreating(false); setNewName(''); }}
              className="text-[11px] text-muted-foreground/60 hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {loading && profiles.length === 0 && (
          <div className="flex items-center justify-center py-8 text-muted-foreground/60">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Loading profiles...</span>
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
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground/50">
            <Braces className="mb-2 h-7 w-7 opacity-40" />
            <span className="text-[11px]">No Hermes profiles found</span>
            <span className="mt-1 text-[10px] opacity-60">~/.hermes/profiles/</span>
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
  const metadata: string[] = [];
  if (profile.model) metadata.push(profile.model);
  metadata.push(`${profile.skillCount} skills`);
  metadata.push(`${profile.sessionCount} sessions`);

  return (
    <div
      className={cn(
        'group relative rounded-lg border px-2.5 py-2 transition-colors',
        isActive
          ? 'border-primary/40 bg-primary/5'
          : 'border-border/40 bg-background/40 hover:border-border/70 hover:bg-background/60',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-1.5 w-1.5 flex-shrink-0 rounded-full',
            isActive ? 'bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.6)]' : 'bg-muted-foreground/20',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[12px] font-medium',
            isActive ? 'text-foreground' : 'text-foreground/90',
          )}
        >
          {profile.name}
        </span>
        {isActive && (
          <span className="rounded-sm bg-primary/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.1em] text-primary">
            Active
          </span>
        )}
      </div>

      <div className="mt-1 flex items-center gap-1.5 pl-3.5 text-[10px] text-muted-foreground/50">
        {metadata.map((item, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-muted-foreground/30">·</span>}
            <span className="truncate">{item}</span>
          </React.Fragment>
        ))}
      </div>

      <div className="absolute right-2 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {isDeleting ? (
          <>
            <button
              onClick={onDeleteConfirm}
              className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/30"
            >
              Delete
            </button>
            <button
              onClick={onDeleteCancel}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-background/50"
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
                className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/25 disabled:opacity-50"
              >
                {isActivating ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Activate'}
              </button>
            )}
            {profile.name !== 'default' && (
              <button
                onClick={onDelete}
                className="rounded p-1 text-muted-foreground/60 hover:bg-red-500/10 hover:text-red-400"
                title="Delete profile"
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
