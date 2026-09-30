from typing import Optional
from pathlib import Path

MOA_PROVIDER_ID = "moa"
MOA_PROVIDER_NAME = "Mixture of Agents"
MOA_NATIVE_REQUIRED_CODE = "MOA_NATIVE_REQUIRED"
MOA_NATIVE_REQUIRED_MESSAGE = (
    "MoA presets require the native Hermes agent adapter (HermesAgentAdapter). "
    "The bridge fell back to legacy run_agent, which cannot run MoA. "
    "Install or update Hermes Agent and restart the bridge."
)


def _read_config_yaml(hermes_home: Optional[Path] = None) -> dict:
    """Best-effort YAML config reader used for rich config sections."""
    config_path = (hermes_home or Path.home() / ".hermes") / "config.yaml"
    if not config_path.is_file():
        return {}
    try:
        import yaml
        with open(config_path) as f:
            data = yaml.safe_load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _coerce_moa_model_ref(raw) -> Optional[dict]:
    if isinstance(raw, str) and raw.strip():
        return {"provider": "", "model": raw.strip()}
    if not isinstance(raw, dict):
        return None
    model = raw.get("model")
    if not isinstance(model, str) or not model.strip():
        return None
    provider = raw.get("provider")
    return {
        "provider": provider.strip() if isinstance(provider, str) else "",
        "model": model.strip(),
    }


def _coerce_optional_float(raw):
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def _coerce_optional_int(raw):
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _coerce_moa_fanout(raw) -> str:
    mode = str(raw or "").strip().lower()
    return mode if mode in {"per_iteration", "user_turn"} else "per_iteration"


def _normalize_moa_preset(name: str, raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None

    aggregator = _coerce_moa_model_ref(raw.get("aggregator"))
    references_raw = raw.get("reference_models") or raw.get("references") or []
    references = []
    if isinstance(references_raw, list):
        for item in references_raw:
            ref = _coerce_moa_model_ref(item)
            if ref:
                references.append(ref)

    if not aggregator or not references:
        return None

    # Block recursive MoA slots (aggregator/reference must not be provider=moa)
    if str(aggregator.get("provider") or "").strip().lower() == MOA_PROVIDER_ID:
        return None
    references = [
        ref for ref in references
        if str(ref.get("provider") or "").strip().lower() != MOA_PROVIDER_ID
    ]
    if not references:
        return None

    return {
        "name": name,
        "enabled": raw.get("enabled") is not False,
        "reference_models": references,
        "aggregator": aggregator,
        "reference_temperature": _coerce_optional_float(raw.get("reference_temperature")),
        "aggregator_temperature": _coerce_optional_float(raw.get("aggregator_temperature")),
        "max_tokens": _coerce_optional_int(raw.get("max_tokens")),
        "reference_max_tokens": _coerce_optional_int(raw.get("reference_max_tokens")),
        "fanout": _coerce_moa_fanout(raw.get("fanout")),
    }


def _normalize_moa_config(raw) -> dict:
    """Normalize Hermes `moa:` config into the shape CloudChat needs."""
    result = {"default_preset": "default", "presets": {}}
    if not isinstance(raw, dict):
        return result

    moa_cfg = raw.get("moa") if "moa" in raw else raw
    if not isinstance(moa_cfg, dict):
        return result

    default_preset = moa_cfg.get("default_preset")
    if isinstance(default_preset, str) and default_preset.strip():
        result["default_preset"] = default_preset.strip()

    raw_presets = moa_cfg.get("presets")
    if not isinstance(raw_presets, dict):
        return result

    presets = {}
    for raw_name, raw_preset in raw_presets.items():
        name = str(raw_name).strip()
        if not name:
            continue
        preset = _normalize_moa_preset(name, raw_preset)
        if preset:
            presets[name] = preset

    result["presets"] = presets
    if result["default_preset"] not in presets and presets:
        result["default_preset"] = next(iter(presets.keys()))
    return result


def _load_moa_config(hermes_home: Optional[Path] = None) -> dict:
    return _normalize_moa_config(_read_config_yaml(hermes_home))


def _enabled_moa_preset_names(moa_config: dict) -> list[str]:
    presets = moa_config.get("presets")
    if not isinstance(presets, dict):
        return []
    return [
        name for name, preset in presets.items()
        if isinstance(preset, dict) and preset.get("enabled") is not False
    ]


def _preset_to_yaml(preset: dict) -> dict:
    """Serialize a normalized preset into the Hermes config.yaml shape."""
    out: dict = {
        "enabled": preset.get("enabled") is not False,
        "reference_models": [
            {"provider": r.get("provider") or "", "model": r.get("model") or ""}
            for r in (preset.get("reference_models") or [])
            if isinstance(r, dict) and r.get("model")
        ],
        "aggregator": {
            "provider": (preset.get("aggregator") or {}).get("provider") or "",
            "model": (preset.get("aggregator") or {}).get("model") or "",
        },
        "fanout": _coerce_moa_fanout(preset.get("fanout")),
    }
    for key in ("reference_temperature", "aggregator_temperature", "max_tokens", "reference_max_tokens"):
        value = preset.get(key)
        if value is not None:
            out[key] = value
    return out


def _save_moa_config(body: dict, hermes_home: Optional[Path] = None) -> dict:
    """Merge a MoA config payload into config.yaml and return the normalized result.

    Accepts either a full `{ default_preset, presets }` object or a single
    `{ preset: {name, ...} }` upsert. Never writes recursive moa slots.
    """
    from main import _load_hermes_config_editable
    home = hermes_home or (Path.home() / ".hermes")
    dump, data = _load_hermes_config_editable(Path(home))
    if not isinstance(data, dict):
        data = {}

    current = _normalize_moa_config({"moa": data.get("moa")} if isinstance(data.get("moa"), dict) else data.get("moa") or {})
    presets = dict(current.get("presets") or {})
    default_preset = current.get("default_preset") or "default"

    if isinstance(body.get("presets"), dict):
        # Full replace of named presets (only valid ones kept)
        incoming = body["presets"]
        rebuilt = {}
        for raw_name, raw_preset in incoming.items():
            name = str(raw_name).strip()
            if not name or not isinstance(raw_preset, dict):
                continue
            # Accept both normalized and raw hermes shapes
            candidate = dict(raw_preset)
            if "name" not in candidate:
                candidate["name"] = name
            normalized = _normalize_moa_preset(name, candidate)
            if normalized:
                rebuilt[name] = normalized
        if not rebuilt:
            raise ValueError("At least one valid MoA preset with reference_models and aggregator is required")
        presets = rebuilt
    elif isinstance(body.get("preset"), dict):
        raw_preset = body["preset"]
        name = str(raw_preset.get("name") or body.get("name") or "").strip()
        if not name:
            raise ValueError("preset.name is required")
        if body.get("delete") is True or raw_preset.get("delete") is True:
            presets.pop(name, None)
            if not presets:
                raise ValueError("Cannot delete the last MoA preset")
        else:
            normalized = _normalize_moa_preset(name, raw_preset)
            if not normalized:
                raise ValueError(
                    f"Invalid preset '{name}': needs at least one non-moa reference model and a non-moa aggregator"
                )
            presets[name] = normalized

    if isinstance(body.get("default_preset"), str) and body["default_preset"].strip():
        default_preset = body["default_preset"].strip()
    if default_preset not in presets and presets:
        default_preset = next(iter(presets.keys()))

    yaml_presets = {name: _preset_to_yaml(p) for name, p in presets.items()}
    active = presets.get(default_preset) or next(iter(presets.values()))
    data["moa"] = {
        "default_preset": default_preset,
        "active_preset": "",
        "presets": yaml_presets,
        # Flattened compat view for older Hermes readers / dashboard
        "reference_models": list(active.get("reference_models") or []),
        "aggregator": dict(active.get("aggregator") or {}),
        "reference_temperature": active.get("reference_temperature"),
        "aggregator_temperature": active.get("aggregator_temperature"),
        "max_tokens": active.get("max_tokens") or 4096,
        "reference_max_tokens": active.get("reference_max_tokens"),
        "fanout": active.get("fanout") or "per_iteration",
        "enabled": active.get("enabled") is not False,
    }
    dump()
    return _normalize_moa_config({"moa": data["moa"]})
