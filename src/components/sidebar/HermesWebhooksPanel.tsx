import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Webhook, Plus, Trash2, KeyRound, X } from 'lucide-react';
import {
  fetchHermesWebhooks,
  createHermesWebhook,
  deleteHermesWebhook,
  type HermesWebhook,
} from '@/lib/hermes-api';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export function HermesWebhooksPanel() {
  const [webhooks, setWebhooks] = useState<HermesWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // The plaintext secret is only returned once, on creation.
  const [revealedSecret, setRevealedSecret] = useState<{ name: string; secret: string } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setWebhooks(await fetchHermesWebhooks());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleCreate = async () => {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createHermesWebhook({
        name: name.trim(),
        description: description.trim() || undefined,
        events: events.split(',').map((e) => e.trim()).filter(Boolean),
      });
      if (created.secret) {
        setRevealedSecret({ name: created.name, secret: created.secret });
      }
      setName('');
      setDescription('');
      setEvents('');
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (hookName: string) => {
    try {
      await deleteHermesWebhook(hookName);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete webhook');
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Webhook className="h-3.5 w-3.5" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Webhooks</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setCreating((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="New webhook"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { void load(); }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition-colors hover:bg-[hsl(var(--sidebar-active))] hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
          {error}
        </div>
      )}

      {revealedSecret && (
        <div className="mx-3 mb-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-2.5 text-[11px]">
          <div className="mb-1 flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium text-emerald-300">
              <KeyRound className="h-3 w-3" />
              Secret for {revealedSecret.name}
            </span>
            <button onClick={() => setRevealedSecret(null)} className="text-muted-foreground/60 hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </div>
          <code className="block break-all rounded bg-background/60 px-2 py-1 font-mono text-[10px] text-foreground/90">
            {revealedSecret.secret}
          </code>
          <p className="mt-1 text-[10px] text-muted-foreground/55">Copy it now — it won't be shown again.</p>
        </div>
      )}

      {creating && (
        <div className="mx-3 mb-2 space-y-2 rounded-xl border border-border/40 bg-background/40 p-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name (e.g. github-ci)"
            className="w-full rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[11px] text-foreground/90 outline-none placeholder:text-muted-foreground/40"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="description (optional)"
            className="w-full rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[11px] text-foreground/90 outline-none placeholder:text-muted-foreground/40"
          />
          <input
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            placeholder="events, comma-separated (optional)"
            className="w-full rounded-lg border border-border/40 bg-background/40 px-2 py-1.5 text-[11px] text-foreground/90 outline-none placeholder:text-muted-foreground/40"
          />
          <button
            onClick={() => { void handleCreate(); }}
            disabled={!name.trim() || submitting}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[hsl(var(--sidebar-active))] py-1.5 text-[11px] font-medium text-foreground transition-colors hover:brightness-110 disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Create subscription
          </button>
        </div>
      )}

      {loading && webhooks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-[12px] text-muted-foreground/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading webhooks...
        </div>
      ) : webhooks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted-foreground/50">
          No webhook subscriptions yet.
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {webhooks.map((hook) => (
            <div key={hook.name} className="rounded-xl border border-border/40 bg-background/40 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium text-foreground/90">{hook.name}</div>
                  {hook.description && (
                    <div className="mt-0.5 truncate text-[10.5px] text-muted-foreground/50">{hook.description}</div>
                  )}
                </div>
                <button
                  onClick={() => { void handleDelete(hook.name); }}
                  className="shrink-0 text-muted-foreground/40 transition-colors hover:text-red-400"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="rounded bg-background/70 px-1.5 py-0.5 text-muted-foreground/55">
                  → {hook.deliver}
                </span>
                {hook.events.map((evt) => (
                  <span key={evt} className="rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-300/80">
                    {evt}
                  </span>
                ))}
                {hook.has_secret && (
                  <span className="flex items-center gap-1 rounded bg-background/70 px-1.5 py-0.5 text-muted-foreground/45">
                    <KeyRound className="h-2.5 w-2.5" />
                    {hook.secret_preview}
                  </span>
                )}
              </div>
              {hook.created_at && (
                <div className="mt-1.5 text-[10px] text-muted-foreground/40">
                  created {relativeTime(hook.created_at)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
