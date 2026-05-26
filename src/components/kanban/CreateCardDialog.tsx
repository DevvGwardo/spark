import { useState, useEffect } from 'react';
import { Plus, X, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useKanbanStore, type KanbanLane } from '@/stores/kanban-store';
import { cn } from '@/lib/utils';

const LANE_OPTIONS: KanbanLane[] = ['backlog', 'ready', 'running', 'review', 'blocked', 'done'];

interface CreateCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultLane?: KanbanLane;
}

export function CreateCardDialog({ open, onOpenChange, defaultLane = 'backlog' }: CreateCardDialogProps) {
  const { createCard } = useKanbanStore();
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [acceptanceInput, setAcceptanceInput] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>([]);
  const [assignedWorker, setAssignedWorker] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [status, setStatus] = useState<KanbanLane>(defaultLane);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setSpec('');
      setAcceptanceInput('');
      setAcceptanceCriteria([]);
      setAssignedWorker('');
      setReviewer('');
      setStatus(defaultLane);
      setError(null);
    }
  }, [open, defaultLane]);

  const addCriteria = () => {
    const val = acceptanceInput.trim();
    if (val && !acceptanceCriteria.includes(val)) {
      setAcceptanceCriteria([...acceptanceCriteria, val]);
      setAcceptanceInput('');
    }
  };

  const removeCriteria = (idx: number) => {
    setAcceptanceCriteria(acceptanceCriteria.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createCard({
        title: title.trim(),
        spec: spec.trim(),
        acceptanceCriteria,
        assignedWorker: assignedWorker.trim(),
        reviewer: reviewer.trim(),
        status,
        missionId: '',
        reportPath: '',
        createdBy: '',
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create card');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-border/60 bg-background/95 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold text-foreground">New Card</DialogTitle>
          <DialogDescription className="text-[11px] text-muted-foreground/70">
            Add a new task to the kanban board.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-2 text-[11px] text-red-300">
            {error}
          </div>
        )}

        <div className="grid gap-3 py-2">
          {/* Title */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-medium text-foreground/80">Title *</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Implement user auth"
              className="h-8 border-border/60 bg-background/60 text-[12px] placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          {/* Spec */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-medium text-foreground/80">Spec / Description</label>
            <textarea
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder="Describe the task..."
              rows={3}
              className="w-full resize-none rounded-md border border-border/60 bg-background/60 px-3 py-2 text-[12px] placeholder:text-muted-foreground/50 focus:border-primary/60 focus:outline-none"
            />
          </div>

          {/* Acceptance Criteria */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-medium text-foreground/80">Acceptance Criteria</label>
            <div className="flex gap-2">
              <Input
                value={acceptanceInput}
                onChange={(e) => setAcceptanceInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCriteria();
                  }
                }}
                placeholder="Add a criterion..."
                className="h-7 flex-1 border-border/60 bg-background/60 text-[12px] placeholder:text-muted-foreground/50"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={addCriteria}
                disabled={!acceptanceInput.trim()}
                className="h-7 px-2 text-[11px]"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            {acceptanceCriteria.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {acceptanceCriteria.map((c, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full border border-border/40 bg-background/40 px-2 py-0.5 text-[10px] text-foreground/80"
                  >
                    {c}
                    <button onClick={() => removeCriteria(i)} className="text-muted-foreground/50 hover:text-destructive">
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Two-column: Worker + Reviewer */}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-[11px] font-medium text-foreground/80">Assigned Worker</label>
              <Input
                value={assignedWorker}
                onChange={(e) => setAssignedWorker(e.target.value)}
                placeholder="Worker name"
                className="h-7 border-border/60 bg-background/60 text-[12px] placeholder:text-muted-foreground/50"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-[11px] font-medium text-foreground/80">Reviewer</label>
              <Input
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                placeholder="Reviewer name"
                className="h-7 border-border/60 bg-background/60 text-[12px] placeholder:text-muted-foreground/50"
              />
            </div>
          </div>

          {/* Lane selector */}
          <div className="grid gap-1.5">
            <label className="text-[11px] font-medium text-foreground/80">Status Lane</label>
            <div className="flex flex-wrap gap-1.5">
              {LANE_OPTIONS.map((lane) => (
                <button
                  key={lane}
                  type="button"
                  onClick={() => setStatus(lane)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
                    status === lane
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border/40 text-muted-foreground/70 hover:border-border/70 hover:text-foreground'
                  )}
                >
                  {lane}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="h-8 text-[11px] text-muted-foreground">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!title.trim() || submitting}
            className="h-8 text-[11px]"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Create Card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
