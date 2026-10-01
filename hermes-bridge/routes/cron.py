"""Routes: /cron, plus the legacy local cron store and the background scheduler.

The store and scheduler live beside the routes because ``_load_cron_data``
rebinds ``_cron_jobs`` / ``_cron_run_history`` with ``global``; keeping every
reader in this one module keeps those rebinds visible to all of them.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import json as _json
import os
import os as _os
import tempfile as _tempfile
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import cron_manager as _cron_mod
from bridge_workspace import _ops_thread
from cron_manager import (
    _cloudchat_origin_from_body,
    _cron_job_count,
    _cron_jobs,
    _cron_query_value,
    _excerpt_history_output,
    _extract_history_error,
    _HERMES_AGENT_DIR,
    _hermes_create_job,
    _HERMES_CRON_AVAILABLE,
    _HERMES_CRON_HELPER_CODE,
    _HERMES_CRON_HELPER_PYTHON,
    _HERMES_CRON_IMPORT_ERROR,
    _HERMES_CRON_OUTPUT_DIR,
    _HERMES_CRON_RESULT_PREFIX,
    _hermes_cron_tick,
    _hermes_get_job,
    _hermes_list_jobs,
    _hermes_pause_job,
    _hermes_remove_job,
    _hermes_resume_job,
    _hermes_schedule_input,
    _HERMES_SKILLS_HUB_HELPER_CODE,
    _HERMES_SKILLS_HUB_RESULT_PREFIX,
    _hermes_trigger_job,
    _history_sort_key,
    _history_timestamp_from_output,
    _iso_timestamp,
    _JOB_ID_RE,
    _local_tz,
    _map_hermes_job,
    _run_hermes_cron_helper,
    _run_hermes_skills_hub_helper,
    _run_hermes_tick_now,
    _run_matches_last,
)

router = APIRouter()


def _build_hermes_run_history(job_id: str) -> list[dict]:
    """Wrapper: sync patchable state from main into cron_manager before calling."""
    _cron_mod._HERMES_CRON_AVAILABLE = _HERMES_CRON_AVAILABLE
    _cron_mod._HERMES_CRON_OUTPUT_DIR = _HERMES_CRON_OUTPUT_DIR
    _cron_mod._hermes_get_job = _hermes_get_job
    return _cron_mod._build_hermes_run_history(job_id)


# ------------------------------------------------------------------
# Cron job storage (persistent JSON file + in-memory cache)
# ------------------------------------------------------------------
_cron_run_history: dict[str, list[dict]] = {}  # job_id -> list of run records
MAX_RUN_HISTORY = 20

# routes/ sits one level below hermes-bridge/; the data dir stays hermes-bridge/data.
_CRON_DATA_DIR = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "data")
_CRON_JOBS_FILE = _os.path.join(_CRON_DATA_DIR, "cron_jobs.json")
_CRON_HISTORY_FILE = _os.path.join(_CRON_DATA_DIR, "cron_history.json")
_cron_lock = threading.Lock()


def _ensure_data_dir():
    """Create the data directory if it doesn't exist."""
    try:
        _os.makedirs(_CRON_DATA_DIR, exist_ok=True)
    except OSError as e:
        print(f"[cron-persist] Error creating data dir: {e}", flush=True)


def _atomic_write_json(filepath: str, data):
    """Write JSON to a file atomically (write to temp, then rename)."""
    dir_name = _os.path.dirname(filepath)
    fd = None
    tmp_path = None
    try:
        fd, tmp_path = _tempfile.mkstemp(dir=dir_name, suffix=".tmp")
        with _os.fdopen(fd, "w") as f:
            fd = None  # fdopen took ownership
            _json.dump(data, f, ensure_ascii=False, indent=2)
        _os.replace(tmp_path, filepath)
        tmp_path = None  # successfully renamed
    except Exception as e:
        print(f"[cron-persist] Error writing {filepath}: {e}", flush=True)
        if tmp_path and _os.path.exists(tmp_path):
            try:
                _os.unlink(tmp_path)
            except OSError:
                pass
        raise


def _load_cron_data():
    """Load cron jobs and history from disk into memory."""
    global _cron_jobs, _cron_run_history
    _ensure_data_dir()
    # Load jobs
    try:
        if _os.path.exists(_CRON_JOBS_FILE):
            with open(_CRON_JOBS_FILE, "r") as f:
                data = _json.load(f)
            if isinstance(data, dict):
                _cron_jobs = data
                print(f"[cron-persist] Loaded {len(_cron_jobs)} cron jobs from disk", flush=True)
    except Exception as e:
        print(f"[cron-persist] Error loading cron jobs: {e}", flush=True)
        _cron_jobs = {}
    # Load history
    try:
        if _os.path.exists(_CRON_HISTORY_FILE):
            with open(_CRON_HISTORY_FILE, "r") as f:
                data = _json.load(f)
            if isinstance(data, dict):
                _cron_run_history = data
                print(f"[cron-persist] Loaded run history for {len(_cron_run_history)} jobs", flush=True)
    except Exception as e:
        print(f"[cron-persist] Error loading cron history: {e}", flush=True)
        _cron_run_history = {}


def _save_cron_jobs():
    """Persist current cron jobs to disk (thread-safe, atomic)."""
    with _cron_lock:
        try:
            _ensure_data_dir()
            _atomic_write_json(_CRON_JOBS_FILE, _cron_jobs)
        except Exception as e:
            print(f"[cron-persist] Error saving cron jobs: {e}", flush=True)


def _save_cron_history():
    """Persist current cron run history to disk (thread-safe, atomic)."""
    with _cron_lock:
        try:
            _ensure_data_dir()
            _atomic_write_json(_CRON_HISTORY_FILE, _cron_run_history)
        except Exception as e:
            print(f"[cron-persist] Error saving cron history: {e}", flush=True)

try:
    from croniter import croniter as _croniter_cls
except ImportError:
    _croniter_cls = None


def _compute_next_run(schedule: str) -> Optional[str]:
    """Compute next run time from a cron expression. Returns ISO string or None."""
    if not _croniter_cls:
        return None
    try:
        now = datetime.now(timezone.utc)
        cron = _croniter_cls(schedule, now)
        return cron.get_next(datetime).isoformat()
    except Exception:
        return None


@router.get("/cron")
async def list_cron_jobs(request: Request):
    if _HERMES_CRON_AVAILABLE:
        conversation_id = _cron_query_value(request, "conversation_id")
        hermes_jobs = await _ops_thread(_hermes_list_jobs, include_disabled=True)
        jobs = [_map_hermes_job(job) for job in hermes_jobs]
        if conversation_id:
            jobs = [job for job in jobs if job.get("conversation_id") == conversation_id]
        jobs.sort(key=lambda item: item.get("created_at") or "", reverse=True)
        return JSONResponse(content={"jobs": jobs})

    return JSONResponse(content={"jobs": list(_cron_jobs.values())})


@router.post("/cron")
async def create_cron_job(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    schedule = body.get("schedule")
    prompt = body.get("prompt")
    name = body.get("name", "")

    if not schedule or not prompt:
        return JSONResponse(status_code=400, content={"error": "schedule and prompt are required"})

    if _HERMES_CRON_AVAILABLE:
        origin = _cloudchat_origin_from_body(body)
        job = await _ops_thread(
            _hermes_create_job,
            prompt=str(prompt),
            schedule=str(schedule),
            name=str(name).strip() or None,
            deliver="local",
            origin=origin,
        )
        return JSONResponse(status_code=201, content={"job": _map_hermes_job(job)})

    job_id = str(uuid.uuid4())[:8]
    now = datetime.now(timezone.utc).isoformat()
    next_run = _compute_next_run(schedule)
    job = {
        "id": job_id,
        "name": name or f"job-{job_id}",
        "schedule": schedule,
        "prompt": prompt,
        "status": "active",
        "created_at": now,
        "last_run": None,
        "next_run": next_run,
    }
    _cron_jobs[job_id] = job
    _save_cron_jobs()
    return JSONResponse(status_code=201, content={"job": job})


@router.delete("/cron/{job_id}")
async def delete_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        if not await _ops_thread(_hermes_remove_job, job_id):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"ok": True})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs.pop(job_id)
    _cron_run_history.pop(job_id, None)
    _save_cron_jobs()
    _save_cron_history()
    return JSONResponse(content={"ok": True})


@router.post("/cron/{job_id}/pause")
async def pause_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        updated = await _ops_thread(_hermes_pause_job, job_id)
        if not updated:
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job": _map_hermes_job(updated)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs[job_id]["status"] = "paused"
    _save_cron_jobs()
    return JSONResponse(content={"job": _cron_jobs[job_id]})


@router.post("/cron/{job_id}/resume")
async def resume_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        updated = await _ops_thread(_hermes_resume_job, job_id)
        if not updated:
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job": _map_hermes_job(updated)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    _cron_jobs[job_id]["status"] = "active"
    _save_cron_jobs()
    return JSONResponse(content={"job": _cron_jobs[job_id]})


def _run_cron_agent(job: dict, run_record: dict):
    """Background thread: run the agent for a cron job and collect output."""
    try:
        # Import AIAgent here to avoid circular issues
        from hermes_adapter import HermesAgentAdapter as AIAgent

        output_chunks: list[str] = []
        tool_log: list[dict] = []

        def on_text(text: str):
            output_chunks.append(text)

        def on_tool_start(name: str, inp: str):
            tool_log.append({"type": "tool_start", "name": name, "input": inp[:500]})

        def on_tool_end(name: str, out: str):
            tool_log.append({"type": "tool_end", "name": name, "output": out[:500]})

        def on_thinking(iteration: int):
            tool_log.append({"type": "thinking", "iteration": iteration})

        def on_reasoning(text: str):
            pass  # skip reasoning in cron output

        def on_server_tool_event(event: dict):
            pass  # skip server tool events in cron

        agent = AIAgent(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.environ.get("HERMES_OPENROUTER_KEY", ""),
            model=job.get("model") or os.environ.get("HERMES_DEFAULT_MODEL", "meta-llama/llama-4-maverick"),
            max_iterations=int(os.environ.get("HERMES_MAX_ITERATIONS", "30")),
            enabled_toolsets=job.get("toolsets") or os.environ.get("HERMES_TOOLSETS", "web,browser,terminal"),
            on_tool_start=on_tool_start,
            on_tool_end=on_tool_end,
            on_text=on_text,
            on_server_tool_event=on_server_tool_event,
        )
        agent.on_thinking = on_thinking
        agent.on_reasoning = on_reasoning

        # Build a minimal system context from the job prompt
        conversation_history = [{"role": "system", "content": f"You are executing a scheduled cron job named '{job.get('name', job['id'])}'. Follow the instructions below."}]

        agent.run_conversation(
            user_message=job["prompt"],
            conversation_history=conversation_history,
        )

        run_record["status"] = "completed"
        run_record["output"] = "".join(output_chunks)
        run_record["tool_log"] = tool_log
    except Exception as e:
        run_record["status"] = "failed"
        run_record["error"] = str(e)
        run_record["output"] = "".join(output_chunks) if 'output_chunks' in dir() else ""
    finally:
        run_record["completed_at"] = datetime.now(timezone.utc).isoformat()
        _save_cron_history()


@router.post("/cron/{job_id}/run")
async def run_cron_job(job_id: str):
    if _HERMES_CRON_AVAILABLE:
        job = await _ops_thread(_hermes_get_job, job_id)
        if not job:
            return JSONResponse(status_code=404, content={"error": "not found"})
        updated = await _ops_thread(_hermes_trigger_job, job_id)
        threading.Thread(target=_run_hermes_tick_now, daemon=True).start()
        return JSONResponse(content={
            "ok": True,
            "status": "queued",
            "job": _map_hermes_job(updated or job),
        })

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    job = _cron_jobs[job_id]
    run_time = datetime.now(timezone.utc).isoformat()
    job["last_run"] = run_time
    # Compute next_run from schedule
    job["next_run"] = _compute_next_run(job.get("schedule", ""))

    run_id = str(uuid.uuid4())[:8]
    run_record = {
        "run_id": run_id,
        "job_id": job_id,
        "started_at": run_time,
        "completed_at": None,
        "status": "running",
        "output": "",
        "error": None,
        "tool_log": [],
    }

    # Store in history
    history = _cron_run_history.setdefault(job_id, [])
    history.insert(0, run_record)
    if len(history) > MAX_RUN_HISTORY:
        _cron_run_history[job_id] = history[:MAX_RUN_HISTORY]
    _save_cron_jobs()
    _save_cron_history()

    # Spawn background thread
    t = threading.Thread(target=_run_cron_agent, args=(job, run_record), daemon=True)
    t.start()

    return JSONResponse(content={
        "ok": True,
        "run_id": run_id,
        "status": "running",
    })


@router.get("/cron/{job_id}/history")
async def get_cron_history(job_id: str):
    if not _JOB_ID_RE.match(job_id or ""):
        return JSONResponse(status_code=422, content={"error": "invalid job_id"})
    if _HERMES_CRON_AVAILABLE:
        if not await _ops_thread(_hermes_get_job, job_id):
            return JSONResponse(status_code=404, content={"error": "not found"})
        return JSONResponse(content={"job_id": job_id, "runs": _build_hermes_run_history(job_id)})

    if job_id not in _cron_jobs:
        return JSONResponse(status_code=404, content={"error": "not found"})
    history = _cron_run_history.get(job_id, [])
    return JSONResponse(content={"job_id": job_id, "runs": history})


# ------------------------------------------------------------------
# Background cron scheduler
# ------------------------------------------------------------------

async def _cron_scheduler_loop():
    """Background task: check active cron jobs every 30s and trigger them."""
    while True:
        try:
            if _HERMES_CRON_AVAILABLE:
                _run_hermes_tick_now()
                await asyncio.sleep(30)
                continue

            now = datetime.now(timezone.utc)
            for job_id, job in list(_cron_jobs.items()):
                if job.get("status") != "active":
                    continue
                next_run_str = job.get("next_run")
                if not next_run_str:
                    continue
                try:
                    next_run_dt = datetime.fromisoformat(next_run_str)
                    if next_run_dt.tzinfo is None:
                        next_run_dt = next_run_dt.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue
                if now >= next_run_dt:
                    print(f"[cron-scheduler] Triggering job {job_id} ({job.get('name', '')})", flush=True)
                    try:
                        run_time = now.isoformat()
                        job["last_run"] = run_time
                        job["next_run"] = _compute_next_run(job.get("schedule", ""))

                        run_id = str(uuid.uuid4())[:8]
                        run_record = {
                            "run_id": run_id,
                            "job_id": job_id,
                            "started_at": run_time,
                            "completed_at": None,
                            "status": "running",
                            "output": "",
                            "error": None,
                            "tool_log": [],
                        }
                        history = _cron_run_history.setdefault(job_id, [])
                        history.insert(0, run_record)
                        if len(history) > MAX_RUN_HISTORY:
                            _cron_run_history[job_id] = history[:MAX_RUN_HISTORY]
                        _save_cron_jobs()
                        _save_cron_history()

                        t = threading.Thread(target=_run_cron_agent, args=(job, run_record), daemon=True)
                        t.start()
                    except Exception as e:
                        print(f"[cron-scheduler] Error triggering job {job_id}: {e}", flush=True)
        except Exception as e:
            print(f"[cron-scheduler] Scheduler loop error: {e}", flush=True)
        await asyncio.sleep(30)


def _start_cron_scheduler() -> asyncio.Task:
    """Start the cron scheduler loop and return its task handle.

    Returns the task so the lifespan can cancel and await it on shutdown — the
    old fire-and-forget create_task() left the loop running past app teardown, and
    gave tests no way to assert the scheduler was actually alive.
    """
    if _HERMES_CRON_AVAILABLE:
        try:
            job_count = len(_hermes_list_jobs(include_disabled=True))
        except Exception as e:
            job_count = 0
            print(f"[cron] Failed to inspect Hermes jobs on startup: {e}", flush=True)
        print(f"[cron] Hermes-backed scheduler starting with {job_count} jobs", flush=True)
        return asyncio.create_task(_cron_scheduler_loop())

    # Load persisted cron data from disk
    _load_cron_data()
    # Recompute next_run for active jobs (they may have been offline)
    for job_id, job in _cron_jobs.items():
        if job.get("status") == "active" and job.get("schedule"):
            job["next_run"] = _compute_next_run(job["schedule"])
    if _cron_jobs:
        _save_cron_jobs()
    print(f"[cron] Scheduler starting with {len(_cron_jobs)} jobs", flush=True)
    return asyncio.create_task(_cron_scheduler_loop())
