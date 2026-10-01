"""Routes: /cron, the background scheduler, and the legacy-store migration.

hermes-agent's cron is the only cron implementation (spec 5.6). The routes
reach it through the ``_hermes_*`` names imported from cron_manager (in-process
or helper-subprocess backed); tests patch them on this module.

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import asyncio
import json as _json
import os as _os
import threading
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import cron_manager as _cron_mod
from bridge_workspace import _ops_thread
from cron_manager import (
    _cloudchat_origin_from_body,
    _cron_job_count,
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


def _cron_unavailable() -> JSONResponse:
    """503 for every /cron route when the hermes cron backend did not load.

    There is one cron implementation (spec 5.6, G15): hermes-agent's, reached
    in-process or through the helper interpreter. The bridge-local JSON store
    and its own agent runner are gone; jobs it held are migrated into hermes at
    startup (``_migrate_legacy_cron_jobs``).
    """
    detail = _HERMES_CRON_IMPORT_ERROR or "hermes-agent cron module not importable"
    return JSONResponse(
        status_code=503,
        content={
            "error": {
                "code": "BRIDGE_STARTING",
                "message": f"Hermes cron backend unavailable: {detail}",
                "retryable": True,
            }
        },
    )


# ------------------------------------------------------------------
# One-time migration of the retired bridge-local cron store
# ------------------------------------------------------------------

# routes/ sits one level below hermes-bridge/; the legacy data dir is hermes-bridge/data.
_CRON_DATA_DIR = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "data")
_CRON_JOBS_FILE = _os.path.join(_CRON_DATA_DIR, "cron_jobs.json")
_CRON_HISTORY_FILE = _os.path.join(_CRON_DATA_DIR, "cron_history.json")
_MIGRATED_SUFFIX = ".migrated"


def _legacy_job_key(name: Optional[str], prompt: Optional[str]) -> tuple[str, str]:
    return (str(name or "").strip(), str(prompt or "").strip())


def _migrate_legacy_cron_jobs(
    jobs_file: Optional[str] = None,
    history_file: Optional[str] = None,
) -> dict:
    """Move jobs from the retired ``data/cron_jobs.json`` into hermes cron, once.

    Idempotent and loss-free:

    * a legacy job whose (name, prompt) already exists in hermes is skipped, so
      a crash mid-migration and the retry on the next start never duplicate;
    * paused legacy jobs are created and then paused;
    * the file is renamed to ``cron_jobs.json.migrated`` only when every job
      made it across — on any failure it stays put and the next start retries;
    * a file that cannot be parsed is left untouched (never deleted).

    Returns ``{"migrated": n, "skipped": n, "failed": n, "marked": bool}``.
    Blocking (hermes cron may go through the helper subprocess): call it off
    the event loop.
    """
    jobs_file = jobs_file or _CRON_JOBS_FILE
    history_file = history_file or _CRON_HISTORY_FILE
    result = {"migrated": 0, "skipped": 0, "failed": 0, "marked": False}
    if not _os.path.exists(jobs_file):
        return result
    try:
        with open(jobs_file, "r", encoding="utf-8") as f:
            legacy = _json.load(f)
    except (OSError, ValueError) as e:
        print(f"[cron] legacy store {jobs_file} unreadable, not migrating: {e}", flush=True)
        result["failed"] = 1
        return result
    if not isinstance(legacy, dict):
        print(f"[cron] legacy store {jobs_file} is not a job map, not migrating", flush=True)
        result["failed"] = 1
        return result

    existing = {
        _legacy_job_key(job.get("name"), job.get("prompt"))
        for job in (_hermes_list_jobs(include_disabled=True) or [])
        if isinstance(job, dict)
    }
    for legacy_id, job in legacy.items():
        if not isinstance(job, dict) or not job.get("schedule") or not job.get("prompt"):
            print(f"[cron] legacy job {legacy_id!r} has no schedule/prompt, skipping", flush=True)
            result["skipped"] += 1
            continue
        name = str(job.get("name") or f"job-{legacy_id}").strip()
        key = _legacy_job_key(name, job.get("prompt"))
        if key in existing:
            result["skipped"] += 1
            continue
        try:
            created = _hermes_create_job(
                prompt=str(job["prompt"]),
                schedule=str(job["schedule"]),
                name=name,
                deliver="local",
                origin=None,
            )
            if job.get("status") == "paused" and isinstance(created, dict) and created.get("id"):
                _hermes_pause_job(created["id"])
            existing.add(key)
            result["migrated"] += 1
        except Exception as e:  # noqa: BLE001 - one bad job must not block the rest; retried next start
            result["failed"] += 1
            print(f"[cron] failed to migrate legacy job {legacy_id!r} ({name}): {e}", flush=True)

    if result["failed"] == 0:
        try:
            _os.replace(jobs_file, jobs_file + _MIGRATED_SUFFIX)
            if _os.path.exists(history_file):
                _os.replace(history_file, history_file + _MIGRATED_SUFFIX)
            result["marked"] = True
        except OSError as e:
            # Still safe: the dedupe above makes the next start's retry a no-op.
            print(f"[cron] migrated legacy jobs but could not mark {jobs_file}: {e}", flush=True)
    print(
        f"[cron] legacy cron store migration: migrated={result['migrated']} "
        f"skipped={result['skipped']} failed={result['failed']} marked={result['marked']}",
        flush=True,
    )
    return result


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

@router.get("/cron")
async def list_cron_jobs(request: Request):
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
    conversation_id = _cron_query_value(request, "conversation_id")
    hermes_jobs = await _ops_thread(_hermes_list_jobs, include_disabled=True)
    jobs = [_map_hermes_job(job) for job in hermes_jobs]
    if conversation_id:
        jobs = [job for job in jobs if job.get("conversation_id") == conversation_id]
    jobs.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return JSONResponse(content={"jobs": jobs})


@router.post("/cron")
async def create_cron_job(request: Request):
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    schedule = body.get("schedule")
    prompt = body.get("prompt")
    name = body.get("name", "")

    if not schedule or not prompt:
        return JSONResponse(status_code=400, content={"error": "schedule and prompt are required"})
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()

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


@router.delete("/cron/{job_id}")
async def delete_cron_job(job_id: str):
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
    if not await _ops_thread(_hermes_remove_job, job_id):
        return JSONResponse(status_code=404, content={"error": "not found"})
    return JSONResponse(content={"ok": True})


@router.post("/cron/{job_id}/pause")
async def pause_cron_job(job_id: str):
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
    updated = await _ops_thread(_hermes_pause_job, job_id)
    if not updated:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return JSONResponse(content={"job": _map_hermes_job(updated)})


@router.post("/cron/{job_id}/resume")
async def resume_cron_job(job_id: str):
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
    updated = await _ops_thread(_hermes_resume_job, job_id)
    if not updated:
        return JSONResponse(status_code=404, content={"error": "not found"})
    return JSONResponse(content={"job": _map_hermes_job(updated)})


@router.post("/cron/{job_id}/run")
async def run_cron_job(job_id: str):
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
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


@router.get("/cron/{job_id}/history")
async def get_cron_history(job_id: str):
    if not _JOB_ID_RE.match(job_id or ""):
        return JSONResponse(status_code=422, content={"error": "invalid job_id"})
    if not _HERMES_CRON_AVAILABLE:
        return _cron_unavailable()
    if not await _ops_thread(_hermes_get_job, job_id):
        return JSONResponse(status_code=404, content={"error": "not found"})
    runs = await _ops_thread(_build_hermes_run_history, job_id)
    return JSONResponse(content={"job_id": job_id, "runs": runs})


# ------------------------------------------------------------------
# Background cron scheduler
# ------------------------------------------------------------------

CRON_TICK_SECONDS = 30


def _cron_startup() -> None:
    """Blocking startup work: migrate the legacy store, then report the job count."""
    try:
        _migrate_legacy_cron_jobs()
    except Exception as e:  # noqa: BLE001 - migration retries next start; scheduling must still run
        print(f"[cron] legacy cron migration failed: {e}", flush=True)
    try:
        job_count = len(_hermes_list_jobs(include_disabled=True) or [])
    except Exception as e:  # noqa: BLE001 - informational count only
        print(f"[cron] Failed to inspect Hermes jobs on startup: {e}", flush=True)
        return
    print(f"[cron] Hermes-backed scheduler running with {job_count} jobs", flush=True)


async def _cron_scheduler_loop():
    """Background task: run the hermes cron tick every 30s, off the event loop.

    ``tick`` runs due jobs synchronously (in-process, or via the helper
    subprocess), so calling it directly on the loop — as this used to — froze
    every request for the length of a cron run.
    """
    await _ops_thread(_cron_startup)
    while True:
        try:
            await _ops_thread(_run_hermes_tick_now)
        except Exception as e:  # noqa: BLE001 - one bad tick must not kill the scheduler
            print(f"[cron-scheduler] Scheduler loop error: {e}", flush=True)
        await asyncio.sleep(CRON_TICK_SECONDS)


def _start_cron_scheduler() -> Optional[asyncio.Task]:
    """Start the cron scheduler loop and return its task handle (None when unavailable).

    Returns the task so the lifespan can cancel and await it on shutdown — the
    old fire-and-forget create_task() left the loop running past app teardown, and
    gave tests no way to assert the scheduler was actually alive.
    """
    if not _HERMES_CRON_AVAILABLE:
        print(
            "[cron] Hermes cron backend unavailable; scheduler not started "
            f"({_HERMES_CRON_IMPORT_ERROR or 'cron module not importable'})",
            flush=True,
        )
        return None
    print("[cron] Hermes-backed scheduler starting", flush=True)
    return asyncio.create_task(_cron_scheduler_loop())
