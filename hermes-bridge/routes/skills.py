"""Routes: /workspace/skills (list, detail, hub install, uninstall).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import bridge_workspace
from bridge_workspace import (
    HermesHubSkillInstallRequest,
    _install_hub_skill,
    _list_skills,
    _list_skills_hub,
    _ops_thread,
    _skill_detail,
    _skills_dir,
)

router = APIRouter()


@router.get("/workspace/skills")
async def workspace_skills(request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    return JSONResponse(content={"skills": _list_skills(hermes_home=hermes_home)})


@router.get("/workspace/skills/content")
async def workspace_skill_detail(request: Request):
    skill_id = request.query_params.get("id", "")
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    detail = _skill_detail(skill_id, hermes_home=hermes_home)
    if not detail:
        return JSONResponse(status_code=404, content={"error": "skill not found"})
    return JSONResponse(content={"skill": detail})


@router.get("/workspace/skills/hub")
async def workspace_skills_hub(request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    try:
        skills = await _ops_thread(_list_skills_hub, hermes_home=hermes_home)
        return JSONResponse(content={"skills": skills})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "skills hub request timed out"})
    except Exception as e:  # noqa: BLE001 - surfaced to the client as a 500
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.post("/workspace/skills/hub/install")
async def workspace_skill_install(payload: HermesHubSkillInstallRequest, request: Request):
    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    try:
        result = await _ops_thread(_install_hub_skill, payload.name, hermes_home=hermes_home)
        return JSONResponse(content=result)
    except ValueError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "skill install timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:  # noqa: BLE001 - surfaced to the client as a 500
        return JSONResponse(status_code=500, content={"error": str(e)})


@router.delete("/workspace/skills")
async def workspace_skill_uninstall(request: Request):
    body = await request.json()
    skill_id = body.get("id", "")
    if not skill_id:
        return JSONResponse(status_code=400, content={"error": "skill id is required"})

    hermes_home = bridge_workspace._resolve_hermes_home(bridge_workspace._resolve_profile_name(request))
    skills_dir = _skills_dir(hermes_home)
    try:
        skill_path = (skills_dir / skill_id).resolve()
        skill_path.relative_to(skills_dir.resolve())
    except (OSError, ValueError, RuntimeError):
        return JSONResponse(status_code=404, content={"error": "skill not found"})

    if skill_path.is_dir():
        skill_path = skill_path / "SKILL.md"

    if skill_path.name != "SKILL.md" or not skill_path.exists():
        return JSONResponse(status_code=404, content={"error": "skill not found"})

    # Use hermes skills uninstall command
    skill_name = skill_path.parent.name

    def _uninstall_skill() -> dict:
        command_env = os.environ.copy()
        command_env["HERMES_HOME"] = str(hermes_home)
        return subprocess.run(
            ["hermes", "skills", "uninstall", skill_name],
            capture_output=True,
            text=True,
            timeout=60,
            env=command_env,
        )

    try:
        result = await _ops_thread(_uninstall_skill)
        if result.returncode != 0:
            return JSONResponse(
                status_code=500,
                content={"error": f"uninstall failed: {result.stderr.strip()}"},
            )
        return JSONResponse(content={"success": True, "message": f"Skill '{skill_name}' uninstalled"})
    except subprocess.TimeoutExpired:
        return JSONResponse(status_code=504, content={"error": "uninstall timed out"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "hermes command not found"})
    except Exception as e:  # noqa: BLE001 - surfaced to the client as a 500
        return JSONResponse(status_code=500, content={"error": str(e)})
