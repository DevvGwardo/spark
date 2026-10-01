// factory.ts — mounts factory routes directly (no dynamic import race)
// keeps logic in sync with ~/software-factory/src/adapters/cloud-chat-hub.ts
import type { Express, Request, Response } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isLoopbackAddress } from '../index';

// lightweight queue — mirrors ~/software-factory/src/engine/pipeline.ts FactoryQueue
type Job = { jobId:string; stage:string; task:string; workdir:string; createdAt:string; updatedAt:string };

// 1. Jobs persist to disk so a server restart doesn't lose queue state.
//    Override with FACTORY_JOBS_DIR (tests point this at a tmp dir).
//    Resolved lazily so env overrides apply without re-importing the module.
function jobsFile(): string {
  const dir = process.env.FACTORY_JOBS_DIR || join(homedir(), '.cache', 'factory-jobs');
  return join(dir, 'jobs.json');
}

function loadJobs(): Map<string, Job> {
  try {
    const raw = JSON.parse(readFileSync(jobsFile(), 'utf8')) as Job[];
    return new Map(raw.map(j => [j.jobId, j]));
  } catch {
    return new Map();
  }
}
function persistJobs() {
  try {
    mkdirSync(dirname(jobsFile()), { recursive: true });
    writeFileSync(jobsFile(), JSON.stringify([...jobs.values()], null, 2));
  } catch { /* ignore unwritable dir */ }
}
const jobs = loadJobs();

function nextJobId(){ return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`; }

// 2. "brain KV" — this is the documented file-fallback KV that
//    ~/software-factory/src/lib/queue-mcp.ts writes (BRAIN_DIR = ~/.cache/factory-brain)
//    when brain MCP is not connected. Mirroring writes here keeps the Spark-side
//    queue readable by the factory tooling; the real shared KV remains brain MCP.
function brainMirrorSet(key: string, value: unknown) {
  try {
    const bd = join(homedir(), '.cache/factory-brain');
    mkdirSync(bd, { recursive: true });
    writeFileSync(join(bd, `${key.replace(/\//g, '_')}.json`), JSON.stringify(value));
  } catch { /* ignore */ }
}

// 3. Dispatch actually launches: append a `create` event to ~/.agent-tasks/tasks.jsonl —
//    the append-only log the hermes-local task-worker polls. (It never reads loose
//    .json files, which is why earlier dispatches sat at `intake` forever.)
//    Event schema mirrors ~/.agent-tasks/bin/task cmd_add: {event:'create', id, desc, agent, tags}.
//    appendFileSync uses O_APPEND, so a single short line is atomic against the
//    concurrent task/task-worker writers.
const AGENT_TASKS_DIR = process.env.AGENT_TASKS_DIR || join(homedir(), '.agent-tasks');

function agentTasksLog(): string {
  return join(process.env.AGENT_TASKS_DIR || AGENT_TASKS_DIR, 'tasks.jsonl');
}
const DEFAULT_AGENT = process.env.FACTORY_TASK_AGENT || 'hermes-local';

function enqueueAgentTask(id: string, task: string, workdir: string): boolean {
  try {
    mkdirSync(process.env.AGENT_TASKS_DIR || AGENT_TASKS_DIR, { recursive: true });
    appendFileSync(agentTasksLog(), JSON.stringify({
      event: 'create', id, desc: task, agent: DEFAULT_AGENT, tags: ['factory'],
      workdir, ts: Date.now() / 1000,
    }) + '\n');
    return true;
  } catch {
    return false;
  }
}

export function resetFactoryJobsForTest() {
  jobs.clear();
  persistJobs();
}

export function registerFactoryRoutes(app: Express){
  // status: queue length + uptime + factory presence
  app.get('/api/factory/status', (_req: Request, res: Response)=>{
    const factoryOk = existsSync(join(homedir(),'software-factory/package.json'));
    const harnessOk = existsSync(join(homedir(),'spark-harness/index.js'));
    res.json({ ok:true, factory: factoryOk ? 'installed' : 'missing', harness: harnessOk ? 'present' : 'missing', queue: jobs.size, jobs: [...jobs.values()] });
  });
  app.get('/api/factory/queue', (_req: Request, res: Response)=>{
    res.json({ ok:true, jobs: [...jobs.values()] });
  });
  app.post('/api/factory/dispatch', (req: Request, res: Response)=>{
    // 4. dispatch writes caller-controlled text into $HOME — restrict to loopback
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'factory dispatch is localhost-only' });
    }
    const { task, workdir } = (req.body||{}) as {task?:string; workdir?:string};
    if(!task || !String(task).trim()) return res.status(400).json({ error:'task required' });
    const id=nextJobId(); const now=new Date().toISOString();
    const job: Job={ jobId:id, stage:'intake', task: String(task), workdir: workdir||process.cwd(), createdAt:now, updatedAt:now };
    jobs.set(id, job);
    persistJobs();
    // also enqueue to ~/.agent-tasks so the hermes-local task-worker picks it up
    const enqueued = enqueueAgentTask(id, String(task), job.workdir);
    if (enqueued) job.stage = 'queued';
    // brain KV mirror (file fallback — see brainMirrorSet above)
    brainMirrorSet(`factory/job/${id}`, job);
    res.json({ ok:true, job, enqueued });
  });
  // 5. kanban/sync is real now: read the shared Hermes kanban DB and report lane counts
  app.post('/api/factory/kanban/sync', (_req: Request, res: Response)=>{
    const kanbanDb=join(homedir(),'.hermes/kanban.db');
    if(!existsSync(kanbanDb)) return res.status(404).json({ ok:false, error:'kanban db not found', kanban: kanbanDb });
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(kanbanDb, { readOnly: true });
      const hasTasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
      if (!hasTasks) return res.json({ ok:true, kanban: kanbanDb, lanes: {}, total: 0, orchestrator:'/api/hermes/orchestrator/*' });
      const rows = db.prepare('SELECT status, COUNT(*) as n FROM tasks GROUP BY status').all() as { status: string; n: number }[];
      const lanes: Record<string, number> = {};
      let total = 0;
      for (const r of rows) { lanes[r.status] = r.n; total += r.n; }
      res.json({ ok:true, kanban: kanbanDb, lanes, total, orchestrator:'/api/hermes/orchestrator/*' });
    } catch (e) {
      res.status(500).json({ ok:false, error: e instanceof Error ? e.message : 'sync failed', kanban: kanbanDb });
    } finally {
      db?.close();
    }
  });
  // also expose vercel/railway health proxies
  app.get('/api/factory/health', (_req: Request, res: Response)=>{
    res.json({ ok:true, routes:['/api/factory/status','/api/factory/queue','/api/factory/dispatch','/api/factory/kanban/sync','/api/factory/health'], factory:'~/software-factory', harness:'~/spark-harness' });
  });
}
