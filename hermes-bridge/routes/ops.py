"""Routes: Hermes ops (fallback, delegation, checkpoints, memory, curator, bundles,
goals, pets, auth pool, portal, gateway runs, kanban, projects, security).

Moved verbatim from main.py (spec 4.1). Names that tests patch are owned by one
module and other modules reach them as ``<module>.<name>`` so a single
``patch.object(<module>, name)`` reaches every caller, as patching main did.
"""
import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import delegation_live
from bridge_workspace import _ops_home, _ops_thread
from routes.mcp import _load_hermes_config_editable, _read_hermes_config

router = APIRouter()


@router.get("/fallback")
async def get_fallback(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {
        "object": "fallback.chain",
        "providers": hermes_ops.get_fallback_providers(cfg),
    }


@router.put("/fallback")
async def put_fallback(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    chain = body.get("providers") if isinstance(body, dict) else None
    if not isinstance(chain, list):
        return JSONResponse(status_code=400, content={"error": "providers must be a list"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_fallback_providers(data, chain)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    await _ops_thread(dump)
    return {"object": "fallback.chain", "providers": saved}


@router.get("/delegation/live/latest")
async def get_delegation_live_latest(request: Request):
    """Return the most recently started Hermes live-transcript manifest."""
    home = _ops_home(request)
    try:
        limit = int(request.query_params.get("limit", "1"))
    except (TypeError, ValueError):
        limit = 1
    if limit <= 1:
        manifest = await _ops_thread(delegation_live.latest_manifest, home)
        if not manifest:
            return JSONResponse(status_code=404, content={"error": "no live delegations"})
        return {"object": "delegation.live.manifest", **manifest}
    manifests = await _ops_thread(delegation_live.list_recent_manifests, home, limit=limit)
    return {"object": "list", "data": manifests}


@router.get("/delegation/live/{delegation_id}")
async def get_delegation_live_manifest(delegation_id: str, request: Request):
    """Read Hermes cache/delegation/live/<id>/manifest.json."""
    home = _ops_home(request)
    try:
        manifest = await _ops_thread(delegation_live.read_manifest, home, delegation_id)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except FileNotFoundError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"manifest read failed: {exc}"})
    return {"object": "delegation.live.manifest", **manifest}


@router.get("/delegation/live/{delegation_id}/task/{task_index}")
async def get_delegation_live_task_log(delegation_id: str, task_index: int, request: Request):
    """Tail an append-only subagent live transcript log by byte offset."""
    home = _ops_home(request)
    try:
        offset = int(request.query_params.get("offset", "0"))
    except (TypeError, ValueError):
        offset = 0
    try:
        payload = await _ops_thread(
            delegation_live.tail_task_log,
            home,
            delegation_id,
            task_index,
            offset=offset,
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except FileNotFoundError as exc:
        return JSONResponse(status_code=404, content={"error": str(exc)})
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": f"log read failed: {exc}"})
    return {"object": "delegation.live.tail", **payload}


@router.get("/checkpoints")
async def get_checkpoints(request: Request):
    import hermes_ops
    workdir = request.query_params.get("workdir")
    return await _ops_thread(
        hermes_ops.get_checkpoints_status, _ops_home(request), workdir=workdir
    )


@router.post("/checkpoints/prune")
async def post_checkpoints_prune(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.prune_checkpoints, _ops_home(request))


@router.post("/checkpoints/restore")
async def post_checkpoints_restore(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    index = body.get("index")
    if index is None:
        return JSONResponse(status_code=400, content={"error": "index is required"})
    workdir = body.get("workdir")
    try:
        result = await _ops_thread(
            hermes_ops.restore_checkpoint,
            index,
            workdir=str(workdir).strip() if workdir else None,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@router.get("/memory/status")
async def get_memory_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_memory_status, _ops_home(request))


@router.get("/curator/status")
async def get_curator_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_curator_status, _ops_home(request))


@router.post("/curator/run")
async def post_curator_run(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.run_curator, _ops_home(request))


@router.get("/computer-use/status")
async def get_computer_use_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_computer_use_status, _ops_home(request))


@router.get("/bundles")
async def get_bundles(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.list_skill_bundles, _ops_home(request))


@router.get("/bundles/{name}")
async def get_bundle_detail(request: Request, name: str):
    import hermes_ops
    try:
        result = await _ops_thread(hermes_ops.show_skill_bundle, name, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    if not result.get("ok"):
        return JSONResponse(status_code=404, content=result)
    return result


@router.post("/bundles/create")
async def post_bundles_create(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    name = str(body.get("name") or "").strip()
    skills_raw = body.get("skills") or body.get("skill_ids") or []
    skills = skills_raw if isinstance(skills_raw, list) else [skills_raw]
    try:
        return await _ops_thread(hermes_ops.create_skill_bundle,
            name,
            [str(s) for s in skills],
            description=body.get("description"),
            instruction=body.get("instruction"),
            force=bool(body.get("force")),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/bundles/delete")
async def post_bundles_delete(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    name = str((body or {}).get("name") or "").strip()
    try:
        return await _ops_thread(hermes_ops.delete_skill_bundle, name, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/bundles/reload")
async def post_bundles_reload(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.reload_skill_bundles, _ops_home(request))


@router.get("/dashboard/url")
async def get_dashboard_url():
    import hermes_ops
    return hermes_ops.get_dashboard_url()


@router.get("/goals")
async def get_goals(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {"object": "goals.config", **hermes_ops.get_goals_config(cfg)}


@router.put("/goals")
async def put_goals(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_goals_config(data, body)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    await _ops_thread(dump)
    return {"object": "goals.config", **saved}


@router.get("/tool-search")
async def get_tool_search(request: Request):
    import hermes_ops
    home = _ops_home(request)
    cfg = _read_hermes_config(home)
    return {"object": "tool_search.config", **hermes_ops.get_tool_search_config(cfg)}


@router.put("/tool-search")
async def put_tool_search(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    home = _ops_home(request)
    dump, data = _load_hermes_config_editable(home)
    try:
        saved = hermes_ops.set_tool_search_config(data, body)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    await _ops_thread(dump)
    return {"object": "tool_search.config", **saved}


@router.get("/insights")
async def get_insights(request: Request):
    import hermes_ops
    days_raw = request.query_params.get("days", "7")
    try:
        days = int(days_raw)
    except (TypeError, ValueError):
        days = 7
    return await _ops_thread(
        hermes_ops.get_insights, days=days, hermes_home=_ops_home(request)
    )


@router.get("/journey")
async def get_journey(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_journey_graph, _ops_home(request))


@router.post("/computer-use/install")
async def post_computer_use_install(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.install_computer_use, _ops_home(request))


@router.get("/computer-use/doctor")
async def get_computer_use_doctor(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.doctor_computer_use, _ops_home(request))


@router.get("/pets")
async def get_pets(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_pets_status, _ops_home(request))


@router.get("/pets/gallery")
async def get_pets_gallery(request: Request):
    import hermes_ops
    limit_raw = request.query_params.get("limit", "40")
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError):
        limit = 40
    return await _ops_thread(
        hermes_ops.list_pets_gallery, limit=limit, hermes_home=_ops_home(request)
    )


@router.post("/pets/select")
async def post_pets_select(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    pet_id = (body or {}).get("pet_id") or (body or {}).get("id") or ""
    try:
        return await _ops_thread(hermes_ops.select_pet, str(pet_id), hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/claw/migrate")
async def post_claw_migrate(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    dry_run = True if not isinstance(body, dict) else body.get("dry_run", True) is not False
    migrate_secrets = bool(body.get("migrate_secrets")) if isinstance(body, dict) else False
    yes = bool(body.get("yes")) if isinstance(body, dict) else False
    # Force dry_run unless explicitly applying with yes=true
    if not dry_run and not yes:
        return JSONResponse(
            status_code=400,
            content={"error": "Applying migration requires dry_run=false and yes=true"},
        )
    return await _ops_thread(hermes_ops.claw_migrate,
        dry_run=dry_run,
        migrate_secrets=migrate_secrets,
        yes=yes,
        hermes_home=_ops_home(request),
    )


@router.get("/auth/pool")
async def get_auth_pool(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.list_auth_pool, _ops_home(request))


@router.get("/auth/pool/{provider}/status")
async def get_auth_pool_provider_status(request: Request, provider: str):
    import hermes_ops
    try:
        return await _ops_thread(hermes_ops.get_auth_provider_status, provider, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/auth/pool/reset")
async def post_auth_pool_reset(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict) or not body.get("provider"):
        return JSONResponse(status_code=400, content={"error": "provider is required"})
    try:
        return await _ops_thread(hermes_ops.reset_auth_pool_provider,
            str(body["provider"]),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/auth/pool/remove")
async def post_auth_pool_remove(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    provider = body.get("provider")
    target = body.get("target") or body.get("index") or body.get("id")
    if not provider or target is None:
        return JSONResponse(
            status_code=400,
            content={"error": "provider and target (index, id, or label) are required"},
        )
    try:
        result = await _ops_thread(hermes_ops.remove_auth_pool_credential,
            str(provider),
            str(target),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@router.post("/auth/pool/add")
async def post_auth_pool_add(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "body must be an object"})
    provider = body.get("provider")
    api_key = body.get("api_key")
    if not provider or not api_key:
        return JSONResponse(
            status_code=400,
            content={"error": "provider and api_key are required"},
        )
    try:
        result = await _ops_thread(hermes_ops.add_auth_api_key,
            str(provider),
            str(api_key),
            label=body.get("label"),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@router.get("/portal/info")
async def get_portal_info_route(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_portal_info, _ops_home(request))


@router.get("/portal/status")
async def get_portal_status_route(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_portal_status, _ops_home(request))


@router.get("/portal/tools")
async def get_portal_tools_route(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.list_portal_tools, _ops_home(request))


@router.get("/portal/open-url")
async def get_portal_open_url_route(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_portal_open_url, _ops_home(request))


@router.get("/portal/open")
async def get_portal_open_route(request: Request):
    """Non-interactive browser launch via `hermes portal open` (subscription page)."""
    import hermes_ops
    return await _ops_thread(hermes_ops.open_portal_subscription, _ops_home(request))


@router.post("/portal/oauth/start")
async def portal_oauth_start_route(request: Request):
    """Start Nous Portal device-code OAuth (returns user_code + verification URL only)."""
    import hermes_ops
    result = await _ops_thread(hermes_ops.portal_oauth_start, _ops_home(request))
    status = 200 if result.get("ok") else 503
    return JSONResponse(status_code=status, content=result)


@router.get("/portal/oauth/poll/{session_id}")
async def portal_oauth_poll_route(session_id: str, request: Request):
    """Poll Nous Portal device-code OAuth session (masked status only)."""
    import hermes_ops
    try:
        result = await _ops_thread(hermes_ops.portal_oauth_poll, session_id, _ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    if result.get("status") == "not_found":
        return JSONResponse(status_code=404, content=result)
    return result


@router.get("/gateway/capabilities")
async def get_gateway_capabilities(request: Request):
    import hermes_ops
    base = (
        request.query_params.get("base_url")
        or os.environ.get("HERMES_API_BASE")
        or "http://127.0.0.1:8642"
    )
    try:
        hermes_ops.assert_safe_gateway_base_url(base)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return await _ops_thread(hermes_ops.probe_gateway_capabilities, base_url=base)


@router.post("/v1/runs/cancel")
async def cancel_gateway_run(request: Request):
    """Stop the active gateway /v1/runs job for a conversation (Spark Stop button)."""
    import hermes_runs as _hermes_runs

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return JSONResponse(status_code=400, content={"error": "conversation_id is required"})
    cancelled = await _hermes_runs.cancel_active_run_async(conversation_id)
    return JSONResponse(status_code=200, content={"cancelled": cancelled})


@router.post("/v1/runs/approve")
async def approve_gateway_run(request: Request):
    """Resolve a pending gateway run approval (/approve command on runs path)."""
    import hermes_runs as _hermes_runs

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    conversation_id = str(body.get("conversation_id") or "").strip()
    if not conversation_id:
        return JSONResponse(status_code=400, content={"error": "conversation_id is required"})
    choice = str(body.get("choice") or "approve").strip().lower() or "approve"
    resolve_all = bool(body.get("all") or body.get("resolve_all"))
    approved, status_code = await _hermes_runs.approve_active_run_async(
        conversation_id,
        choice=choice,
        resolve_all=resolve_all,
    )
    if not approved:
        return JSONResponse(status_code=404, content={"approved": False, "error": "No active gateway run"})
    return JSONResponse(status_code=200, content={"approved": True, "status": status_code})


@router.post("/kanban/swarm")
async def post_kanban_swarm(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    goal = str(body.get("goal") or "").strip()
    workers = body.get("workers")
    if workers is not None and not isinstance(workers, list):
        workers = None
    try:
        return await _ops_thread(hermes_ops.kanban_swarm_create,
            goal,
            workers=workers,
            verifier=str(body.get("verifier") or "reviewer"),
            synthesizer=str(body.get("synthesizer") or "writer"),
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.get("/projects")
async def get_projects(request: Request):
    import hermes_ops
    include_archived = request.query_params.get("all", "").lower() in ("1", "true", "yes")
    return await _ops_thread(hermes_ops.list_projects,
        hermes_home=_ops_home(request),
        include_archived=include_archived,
    )


@router.post("/projects")
async def post_projects_create(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    name = str(body.get("name") or "").strip()
    primary = body.get("primary_folder") or body.get("primary") or body.get("path")
    use = body.get("use", True) is not False
    try:
        return await _ops_thread(hermes_ops.create_project,
            name,
            primary_folder=str(primary).strip() if primary else None,
            use=use,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/projects/use")
async def post_projects_use(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        body = {}
    project = None
    if isinstance(body, dict):
        raw = body.get("project") or body.get("slug") or body.get("id")
        if raw is not None and str(raw).strip():
            project = str(raw).strip()
    try:
        return await _ops_thread(hermes_ops.use_project, project, hermes_home=_ops_home(request))
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.post("/projects/bind-board")
async def post_projects_bind_board(request: Request):
    import hermes_ops
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": "Body must be a JSON object"})
    project = str(body.get("project") or body.get("slug") or "").strip()
    board = body.get("board") or body.get("board_slug")
    try:
        return await _ops_thread(hermes_ops.bind_board,
            project,
            str(board).strip() if board is not None else None,
            hermes_home=_ops_home(request),
        )
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@router.get("/security/audit")
async def get_security_audit(request: Request):
    import hermes_ops
    skip_venv = request.query_params.get("skip_venv", "").lower() in ("1", "true", "yes")
    return await _ops_thread(
        hermes_ops.run_security_audit, _ops_home(request), skip_venv=skip_venv
    )


@router.get("/secrets/status")
async def get_secrets_status(request: Request):
    import hermes_ops
    return await _ops_thread(hermes_ops.get_secrets_status, _ops_home(request))
