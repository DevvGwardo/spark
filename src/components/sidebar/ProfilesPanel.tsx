import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Braces, ArrowLeft, Eye, EyeOff, FileEdit, FileCode, ExternalLink, CheckCircle, XCircle } from 'lucide-react';
import { useProfilesStore, type Profile, type ProfileDetail } from '@/stores/profiles-store';
import { cn } from '@/lib/utils';

export function ProfilesPanel() {
  const {
    profiles,
    activeProfile,
    loading,
    selectedProfile,
    profileDetail,
    detailLoading,
    fetchProfiles,
    activateProfile,
    createProfile,
    deleteProfile,
    fetchProfileDetail,
  } = useProfilesStore();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [cloneFrom, setCloneFrom] = useState('default');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [activating, setActivating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewingDetail, setViewingDetail] = useState<string | null>(null);
  const [showEnvKeys, setShowEnvKeys] = useState(false);
  const [editConfigOpen, setEditConfigOpen] = useState(false);
  const [configText, setConfigText] = useState('');
  const [viewEnvOpen, setViewEnvOpen] = useState(false);

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

  const openDetail = async (name: string) => {
    setViewingDetail(name);
    await fetchProfileDetail(name);
  };

  const closeDetail = () => {
    setViewingDetail(null);
  };

  // Detail view
  if (viewingDetail && profileDetail && selectedProfile === viewingDetail) {
    return (
      <ProfileDetailView
        detail={profileDetail}
        detailLoading={detailLoading}
        onBack={closeDetail}
        showEnvKeys={showEnvKeys}
        setShowEnvKeys={setShowEnvKeys}
      />
    );
  }

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
            onViewDetail={() => openDetail(profile.name)}
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

// ─── Profile Row ──────────────────────────────────────────────────

function ProfileRow({
  profile,
  isActive,
  isActivating,
  isDeleting,
  onActivate,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  onViewDetail,
}: {
  profile: Profile;
  isActive: boolean;
  isActivating: boolean;
  isDeleting: boolean;
  onActivate: () => void;
  onDelete: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  onViewDetail: () => void;
}) {
  const metadata: string[] = [];
  if (profile.model) metadata.push(profile.model);
  metadata.push(`${profile.skillCount} skills`);
  metadata.push(`${profile.sessionCount} sessions`);

  return (
    <div
      className={cn(
        'group relative rounded-lg border px-2.5 py-2 transition-colors cursor-pointer',
        isActive
          ? 'border-primary/40 bg-primary/5'
          : 'border-border/40 bg-background/40 hover:border-border/70 hover:bg-background/60',
      )}
      onClick={onViewDetail}
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
        {profile.hasEnv && (
          <span className="shrink-0" title="Has .env file" aria-label="Has .env file">
            <CheckCircle className="h-3 w-3 text-emerald-500/70" />
          </span>
        )}
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

      <div className="absolute right-2 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
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

// ─── Profile Detail View ──────────────────────────────────────────

function ProfileDetailView({
  detail,
  detailLoading,
  onBack,
  showEnvKeys,
  setShowEnvKeys,
}: {
  detail: ProfileDetail;
  detailLoading: boolean;
  onBack: () => void;
  showEnvKeys: boolean;
  setShowEnvKeys: (v: boolean) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editYaml, setEditYaml] = useState(detail.configYaml);
  const [envOpen, setEnvOpen] = useState(false);

  useEffect(() => {
    setEditYaml(detail.configYaml);
  }, [detail.configYaml]);

  if (detailLoading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-8 text-muted-foreground/60">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-[11px]">Loading detail...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Back button + header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
          title="Back to list"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-[12px] font-semibold text-foreground">{detail.name}</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {/* Provider / Model info */}
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Provider</span>
              <p className="mt-0.5 text-[12px] font-medium text-foreground/90">{detail.provider || '—'}</p>
            </div>
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Model</span>
              <p className="mt-0.5 text-[12px] font-mono text-foreground/90">{detail.model || '—'}</p>
            </div>
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Skills</span>
              <p className="mt-0.5 text-[12px] text-foreground/90">{detail.skillCount}</p>
            </div>
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Sessions</span>
              <p className="mt-0.5 text-[12px] text-foreground/90">{detail.sessionCount}</p>
            </div>
          </div>
        </div>

        {/* .env status */}
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">.env file</span>
              {detail.hasEnv ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-px text-[9px] font-medium text-emerald-400">
                  <CheckCircle className="h-2.5 w-2.5" />
                  Present
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-px text-[9px] font-medium text-red-400">
                  <XCircle className="h-2.5 w-2.5" />
                  Missing
                </span>
              )}
            </div>
            <button
              onClick={() => setShowEnvKeys(!showEnvKeys)}
              className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
              title={showEnvKeys ? 'Hide env keys' : 'Show env keys'}
            >
              {showEnvKeys ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
          </div>
          {showEnvKeys && detail.envKeys && detail.envKeys.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {detail.envKeys.map((key, i) => (
                <div key={i} className="rounded-md bg-background/60 px-2 py-1 text-[10px] font-mono text-muted-foreground/70">
                  {key}
                </div>
              ))}
            </div>
          )}
          {showEnvKeys && (!detail.envKeys || detail.envKeys.length === 0) && (
            <p className="mt-2 text-[10px] text-muted-foreground/50">No env keys configured</p>
          )}
        </div>

        {/* Skills list */}
        {detail.skills && detail.skills.length > 0 && (
          <div className="rounded-lg border border-border/30 bg-background/40 p-3">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Skills ({detail.skillCount})</span>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {detail.skills.map((skill, i) => (
                <span
                  key={i}
                  className="rounded-md border border-border/30 bg-background/50 px-1.5 py-0.5 text-[10px] font-medium text-foreground/70"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Config YAML */}
        <div className="rounded-lg border border-border/30 bg-background/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">Config</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEnvOpen(true)}
                className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
                title="View .env"
              >
                <FileCode className="h-3 w-3" />
              </button>
              <button
                onClick={() => setEditOpen(true)}
                className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-foreground"
                title="Edit config"
              >
                <FileEdit className="h-3 w-3" />
              </button>
            </div>
          </div>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background/80 p-2 text-[10px] leading-relaxed text-muted-foreground/80 font-mono whitespace-pre-wrap">
            {detail.configYaml || '# No config YAML available'}
          </pre>
        </div>
      </div>

      {/* Edit Config Dialog */}
      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setEditOpen(false)}>
          <div className="mx-4 w-full max-w-lg rounded-xl border border-border/50 bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-foreground">Edit Config</span>
              <button onClick={() => setEditOpen(false)} className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground">
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={editYaml}
              onChange={(e) => setEditYaml(e.target.value)}
              rows={12}
              className="w-full resize-none rounded-md border border-border/60 bg-background/80 px-3 py-2 text-[11px] font-mono leading-relaxed text-foreground/90 focus:border-primary/60 focus:outline-none"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setEditOpen(false)}
                className="rounded-md px-3 py-1.5 text-[11px] text-muted-foreground/70 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => setEditOpen(false)}
                className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View .env Dialog */}
      {envOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setEnvOpen(false)}>
          <div className="mx-4 w-full max-w-lg rounded-xl border border-border/50 bg-background p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-foreground">.env — {detail.name}</span>
              <button onClick={() => setEnvOpen(false)} className="rounded-md p-1 text-muted-foreground/50 hover:text-foreground">
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            {detail.hasEnv ? (
              <div className="rounded-md bg-background/80 p-3">
                {detail.envKeys && detail.envKeys.length > 0 ? (
                  detail.envKeys.map((key, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5 text-[11px] font-mono text-foreground/80">
                      <span className="text-muted-foreground/40">{i + 1}.</span>
                      <span>{key}=***</span>
                    </div>
                  ))
                ) : (
                  <p className="text-[11px] text-muted-foreground/60">File exists but appears empty or unreadable</p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground/60">No .env file found for this profile</p>
            )}
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => setEnvOpen(false)}
                className="rounded-md px-3 py-1.5 text-[11px] text-muted-foreground/70 hover:text-foreground"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
