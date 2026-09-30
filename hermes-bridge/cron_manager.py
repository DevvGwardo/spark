import json
import os
import re
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Request

_cron_jobs: dict[str, dict] = {}

# --- Hermes cron backend integration ---
_HERMES_AGENT_DIR = os.environ.get(
    "HERMES_AGENT_DIR",
    os.path.expanduser("~/.hermes/hermes-agent"),
)
_HERMES_CRON_HELPER_PYTHON = os.environ.get(
    "HERMES_CRON_PYTHON",
    os.path.join(os.path.dirname(__file__), ".venv", "bin", "python"),
)
_HERMES_CRON_RESULT_PREFIX = "__HERMES_CRON_RESULT__="
_HERMES_CRON_OUTPUT_DIR = (
    Path(os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes")))
    / "cron"
    / "output"
)
_HERMES_SKILLS_HUB_RESULT_PREFIX = "__HERMES_SKILLS_HUB_RESULT__="

if _HERMES_AGENT_DIR not in sys.path:
    sys.path.insert(0, _HERMES_AGENT_DIR)

_HERMES_CRON_AVAILABLE = False
_HERMES_CRON_IMPORT_ERROR: Optional[str] = None

_HERMES_CRON_HELPER_CODE = f"""
import json
import sys

agent_dir = sys.argv[1]
action = sys.argv[2]
payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {{}}
if agent_dir not in sys.path:
    sys.path.insert(0, agent_dir)

from cron.jobs import create_job, get_job, list_jobs, pause_job, remove_job, resume_job, trigger_job
from cron.scheduler import tick

if action == "list_jobs":
    result = list_jobs(**payload)
elif action == "create_job":
    result = create_job(**payload)
elif action == "get_job":
    result = get_job(**payload)
elif action == "pause_job":
    result = pause_job(**payload)
elif action == "remove_job":
    result = remove_job(**payload)
elif action == "resume_job":
    result = resume_job(**payload)
elif action == "trigger_job":
    result = trigger_job(**payload)
elif action == "tick":
    tick(**payload)
    result = True
else:
    raise ValueError(f"unsupported Hermes cron action: {{action}}")

print("{_HERMES_CRON_RESULT_PREFIX}" + json.dumps({{"result": result}}, default=str))
"""

_HERMES_SKILLS_HUB_HELPER_CODE = f"""
import json
import os
import sys
from pathlib import Path

agent_dir = sys.argv[1]
payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {{}}
hermes_home = payload.get("hermes_home") or os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
if agent_dir not in sys.path:
    sys.path.insert(0, agent_dir)
os.environ["HERMES_HOME"] = hermes_home

from tools.skills_hub import GitHubAuth, create_source_router, parallel_search_sources

_TRUST_RANK = {{"builtin": 3, "trusted": 2, "community": 1}}
_PER_SOURCE_LIMIT = {{
    "official": 200,
    "skills-sh": 200,
    "well-known": 50,
    "github": 200,
    "clawhub": 500,
    "claude-marketplace": 100,
    "lobehub": 500,
}}

def _parse_frontmatter_name(skill_md: Path) -> str:
    try:
        content = skill_md.read_text(encoding="utf-8")
    except Exception:
        return skill_md.parent.name

    if not content.startswith("---"):
        return skill_md.parent.name

    end_marker = content.find("\\n---\\n", 4)
    if end_marker == -1:
        return skill_md.parent.name

    try:
        import yaml
        parsed = yaml.safe_load(content[4:end_marker])
    except Exception:
        return skill_md.parent.name

    if isinstance(parsed, dict):
        name = parsed.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()

    return skill_md.parent.name

def _installed_skill_names(home: str) -> set[str]:
    names: set[str] = set()
    skills_dir = Path(home) / "skills"
    if not skills_dir.exists():
        return names

    for skill_md in skills_dir.rglob("SKILL.md"):
        if ".hub" in skill_md.parts or "__pycache__" in skill_md.parts:
            continue
        names.add(skill_md.parent.name.strip().lower())
        parsed_name = _parse_frontmatter_name(skill_md)
        if parsed_name:
            names.add(parsed_name.lower())

    return names

def _skill_category(meta) -> str:
    extra = getattr(meta, "extra", {{}}) or {{}}
    category = extra.get("category")
    if isinstance(category, str) and category.strip():
        return category.strip()

    path = getattr(meta, "path", None)
    if isinstance(path, str) and path.strip():
        parts = [part for part in path.replace("\\\\", "/").split("/") if part]
        if len(parts) >= 2:
            return parts[-2]
        if len(parts) == 1:
            return parts[0]

    identifier = str(getattr(meta, "identifier", "") or "")
    parts = [part for part in identifier.split("/") if part]
    if len(parts) >= 2:
        return parts[-2]

    return "general"

def _skill_source(meta) -> str:
    source = str(getattr(meta, "source", "") or "").strip().lower()
    if source == "official":
        return "optional"
    if source == "claude-marketplace":
        return "anthropic"
    if source == "lobehub":
        return "lobehub"
    if source == "builtin":
        return "built-in"
    return "community"

auth = GitHubAuth()
sources = create_source_router(auth)
all_results, _, _ = parallel_search_sources(
    sources,
    query="",
    per_source_limits=_PER_SOURCE_LIMIT,
    source_filter="all",
    overall_timeout=15,
)

seen = {{}}
for result in all_results:
    name = str(getattr(result, "name", "") or "").strip()
    if not name:
        continue
    rank = _TRUST_RANK.get(str(getattr(result, "trust_level", "") or "").strip().lower(), 0)
    current = seen.get(name.lower())
    current_rank = -1
    if current is not None:
        current_rank = _TRUST_RANK.get(
            str(getattr(current, "trust_level", "") or "").strip().lower(),
            0,
        )
    if current is None or rank > current_rank:
        seen[name.lower()] = result

installed_names = _installed_skill_names(hermes_home)
skills = []
for result in sorted(
    seen.values(),
    key=lambda item: (
        -_TRUST_RANK.get(str(getattr(item, "trust_level", "") or "").strip().lower(), 0),
        str(getattr(item, "source", "") or "").strip().lower() != "official",
        str(getattr(item, "name", "") or "").strip().lower(),
    ),
):
    name = str(getattr(result, "name", "") or "").strip()
    if not name:
        continue
    skills.append(
        {{
            "name": name,
            "description": str(getattr(result, "description", "") or "").strip(),
            "category": _skill_category(result),
            "source": _skill_source(result),
            "installed": name.lower() in installed_names,
        }}
    )

print("{_HERMES_SKILLS_HUB_RESULT_PREFIX}" + json.dumps({{"skills": skills}}, ensure_ascii=False))
"""


def _run_hermes_cron_helper(action: str, payload: Optional[dict] = None):
    try:
        completed = subprocess.run(
            [
                _HERMES_CRON_HELPER_PYTHON,
                "-c",
                _HERMES_CRON_HELPER_CODE,
                _HERMES_AGENT_DIR,
                action,
                json.dumps(payload or {}),
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Hermes cron helper timed out after 30s for {action}"
        )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(
            stderr or stdout or f"Hermes cron helper failed for {action}"
        )

    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith(_HERMES_CRON_RESULT_PREFIX):
            payload_text = line[len(_HERMES_CRON_RESULT_PREFIX):]
            return json.loads(payload_text).get("result")

    raise RuntimeError(f"Hermes cron helper returned no result for {action}")


def _run_hermes_skills_hub_helper(hermes_home: Path) -> dict:
    completed = subprocess.run(
        [
            _HERMES_CRON_HELPER_PYTHON,
            "-c",
            _HERMES_SKILLS_HUB_HELPER_CODE,
            _HERMES_AGENT_DIR,
            json.dumps({"hermes_home": str(hermes_home)}),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise RuntimeError(
            stderr or stdout or "Hermes skills hub helper failed"
        )

    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith(_HERMES_SKILLS_HUB_RESULT_PREFIX):
            payload_text = line[len(_HERMES_SKILLS_HUB_RESULT_PREFIX):]
            result = json.loads(payload_text)
            return result if isinstance(result, dict) else {}

    raise RuntimeError("Hermes skills hub helper returned no result")

try:
    from cron.jobs import (
        create_job as _hermes_create_job,
        get_job as _hermes_get_job,
        list_jobs as _hermes_list_jobs,
        pause_job as _hermes_pause_job,
        remove_job as _hermes_remove_job,
        resume_job as _hermes_resume_job,
        trigger_job as _hermes_trigger_job,
        OUTPUT_DIR as _HERMES_CRON_OUTPUT_DIR,
    )
    from cron.scheduler import tick as _hermes_cron_tick
    _HERMES_CRON_AVAILABLE = True
except Exception as e:
    _HERMES_CRON_IMPORT_ERROR = str(e)
    helper_error = None
    if os.path.exists(_HERMES_CRON_HELPER_PYTHON):
        try:
            _run_hermes_cron_helper("list_jobs", {"include_disabled": True})
            _hermes_create_job = lambda **kwargs: _run_hermes_cron_helper("create_job", kwargs)
            _hermes_get_job = lambda job_id: _run_hermes_cron_helper("get_job", {"job_id": job_id})
            _hermes_list_jobs = lambda include_disabled=False: _run_hermes_cron_helper(
                "list_jobs",
                {"include_disabled": include_disabled},
            )
            _hermes_pause_job = lambda job_id: _run_hermes_cron_helper("pause_job", {"job_id": job_id})
            _hermes_remove_job = lambda job_id: _run_hermes_cron_helper("remove_job", {"job_id": job_id})
            _hermes_resume_job = lambda job_id: _run_hermes_cron_helper("resume_job", {"job_id": job_id})
            _hermes_trigger_job = lambda job_id: _run_hermes_cron_helper("trigger_job", {"job_id": job_id})
            _hermes_cron_tick = lambda verbose=False: _run_hermes_cron_helper("tick", {"verbose": verbose})
            _HERMES_CRON_AVAILABLE = True
            print(
                f"[cron] Hermes cron backend enabled via helper interpreter {_HERMES_CRON_HELPER_PYTHON}",
                flush=True,
            )
        except Exception as helper_exc:
            helper_error = str(helper_exc)

    if not _HERMES_CRON_AVAILABLE:
        detail = (
            f"{e}; helper {_HERMES_CRON_HELPER_PYTHON} failed: {helper_error}"
            if helper_error
            else str(e)
        )
        print(
            f"[cron] Hermes cron backend unavailable, falling back to bridge-local store: {detail}",
            flush=True,
        )


def _cron_query_value(request: Request, key: str) -> Optional[str]:
    query_params = getattr(request, "query_params", None)
    if query_params is None:
        return None
    value = query_params.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _cloudchat_origin_from_body(body: dict) -> Optional[dict]:
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return None

    title = str(body.get("conversation_title") or "").strip() or None
    origin = {
        "platform": "cloud-chat-hub",
        "chat_id": conversation_id,
    }
    if title:
        origin["chat_name"] = title
    return origin


def _hermes_schedule_input(job: dict) -> str:
    schedule = job.get("schedule")
    if not isinstance(schedule, dict):
        return str(job.get("schedule_display") or "")

    kind = schedule.get("kind")
    if kind == "cron":
        return str(schedule.get("expr") or job.get("schedule_display") or "")
    if kind == "interval":
        minutes = schedule.get("minutes")
        return f"every {minutes}m" if minutes else str(job.get("schedule_display") or "")
    if kind == "once":
        return str(schedule.get("run_at") or job.get("schedule_display") or "")

    return str(job.get("schedule_display") or "")


def _map_hermes_job(job: dict) -> dict:
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}
    origin_platform = str(origin.get("platform") or "").strip() or None
    conversation_id = None
    conversation_title = None
    if origin_platform == "cloud-chat-hub":
        conversation_id = str(origin.get("chat_id") or "").strip() or None
        conversation_title = str(origin.get("chat_name") or "").strip() or None

    state = str(job.get("state") or "").strip() or (
        "scheduled" if job.get("enabled", True) else "paused"
    )
    if state == "paused":
        status = "paused"
    elif state == "completed":
        status = "completed"
    elif job.get("enabled", True):
        status = "active"
    else:
        status = "paused"

    schedule = _hermes_schedule_input(job)

    return {
        "id": job["id"],
        "name": job.get("name") or job["id"],
        "schedule": schedule,
        "schedule_display": job.get("schedule_display") or schedule,
        "prompt": job.get("prompt") or "",
        "status": status,
        "state": state,
        "created_at": job.get("created_at"),
        "last_run": job.get("last_run_at"),
        "next_run": job.get("next_run_at"),
        "last_status": job.get("last_status"),
        "last_error": job.get("last_error"),
        "conversation_id": conversation_id,
        "conversation_title": conversation_title,
        "origin_platform": origin_platform,
    }


def _local_tz():
    return datetime.now().astimezone().tzinfo or timezone.utc


def _history_timestamp_from_output(path: Path) -> str:
    try:
        dt = datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S").replace(tzinfo=_local_tz())
        return dt.isoformat()
    except ValueError:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _history_sort_key(path: Path) -> float:
    try:
        return datetime.strptime(path.stem, "%Y-%m-%d_%H-%M-%S").replace(
            tzinfo=_local_tz()
        ).timestamp()
    except ValueError:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0


def _iso_timestamp(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except Exception:
        return None


def _run_matches_last(run_started_at: Optional[str], last_run_at: Optional[str]) -> bool:
    run_ts = _iso_timestamp(run_started_at)
    last_ts = _iso_timestamp(last_run_at)
    if run_ts is None or last_ts is None:
        return False
    return abs(run_ts - last_ts) < 120


def _extract_history_error(output: str) -> Optional[str]:
    if "## Error" not in output:
        return None
    error_block = output.split("## Error", 1)[1].strip()
    if error_block.startswith("```"):
        error_block = error_block.strip("`\n")
    error_block = error_block.strip()
    return error_block[:500] or None


def _excerpt_history_output(output: str, limit: int = 500) -> Optional[str]:
    # If the output has a "## Response" section, extract from there to skip
    # system hints and metadata (e.g. from cron job output files).
    if "## Response" in output:
        response_section = output.split("## Response", 1)[1]
    else:
        response_section = output
    lines = [line.rstrip() for line in response_section.splitlines()]
    cleaned = "\n".join(line for line in lines if line).strip()
    if not cleaned:
        return None
    return cleaned[:limit]


MAX_RUN_HISTORY = 20

# Client-controlled cron job ids must be validated before they are used to
# build filesystem paths (output_dir = OUTPUT_DIR / job_id) — otherwise a
# crafted id could traverse directories. Mirror of acp_transport._SAFE_ID_RE.
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _build_hermes_run_history(job_id: str) -> list[dict]:
    if not _HERMES_CRON_AVAILABLE or not _JOB_ID_RE.match(job_id or ""):
        return []

    runs: list[dict] = []
    output_dir = Path(_HERMES_CRON_OUTPUT_DIR) / job_id
    output_files = []
    if output_dir.exists():
        output_files = sorted(
            output_dir.glob("*.md"),
            key=_history_sort_key,
            reverse=True,
        )[:MAX_RUN_HISTORY]

    for path in output_files:
        try:
            output = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        started_at = _history_timestamp_from_output(path)
        completed_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
        error = _extract_history_error(output)
        status = "error" if error or "(FAILED)" in output else "success"
        runs.append({
            "run_id": path.stem,
            "job_id": job_id,
            "started_at": started_at,
            "completed_at": completed_at,
            "status": status,
            "output": _excerpt_history_output(output),
            "error": error,
            "tool_log": [],
            "duration_ms": None,
        })

    job = _hermes_get_job(job_id)
    if job and job.get("last_run_at") and not any(
        _run_matches_last(run.get("started_at"), job.get("last_run_at"))
        for run in runs
    ):
        status = "error" if job.get("last_status") == "error" else "success"
        runs.insert(0, {
            "run_id": f"{job_id}:{job.get('last_run_at')}",
            "job_id": job_id,
            "started_at": job.get("last_run_at"),
            "completed_at": job.get("last_run_at"),
            "status": status,
            "output": None,
            "error": job.get("last_error"),
            "tool_log": [],
            "duration_ms": None,
        })

    return runs[:MAX_RUN_HISTORY]


def _run_hermes_tick_now():
    if not _HERMES_CRON_AVAILABLE:
        return
    try:
        _hermes_cron_tick(verbose=False)
    except Exception as e:
        print(f"[cron] Hermes tick failed: {e}", flush=True)


def _cron_job_count() -> int:
    if _HERMES_CRON_AVAILABLE:
        try:
            return len(_hermes_list_jobs(include_disabled=True) or [])
        except Exception:
            pass

    return len(_cron_jobs)



