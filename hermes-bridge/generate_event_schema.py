#!/usr/bin/env python3
"""Generate the custom SSE event contract as JSON Schema (spec Phase 1.2).

Reads the Pydantic models declared in bridge_events.py and writes
`shared/hermes-events.schema.json`, which is the single cross-runtime artifact
both runtimes agree on. A Node script then turns that schema into the zod
validators the Node boundary validates incoming events against, so the bridge and
the UI cannot drift without CI noticing.

MUST run with real pydantic. The bridge test suite installs a minimal pydantic
stub globally (test_acp_repo_grounding imports test_main first), under which
`model_json_schema` does not exist. This script therefore runs as a standalone
process via `npm run gen:hermes-contract` and never inside pytest.

Usage:
    hermes-bridge/.venv/bin/python hermes-bridge/generate_event_schema.py [--check]

`--check` regenerates in memory and exits non-zero if the checked-in file differs,
which is what CI uses to fail on a stale contract.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

REPO_ROOT = os.path.dirname(HERE)
OUTPUT_PATH = os.path.join(REPO_ROOT, "shared", "hermes-events.schema.json")

# Pydantic is only imported for real by this script. Guard loudly rather than
# producing a silently empty schema if someone runs it under the test stub.
try:
    from pydantic import BaseModel, __version__ as PYDANTIC_VERSION
except ImportError:  # pragma: no cover
    print("pydantic is required to generate the event schema", file=sys.stderr)
    raise SystemExit(2)

import bridge_events as be

if not hasattr(BaseModel, "model_json_schema"):  # pragma: no cover
    print(
        "pydantic looks stubbed (no model_json_schema). Run this with real "
        "pydantic, e.g. hermes-bridge/.venv/bin/python.",
        file=sys.stderr,
    )
    raise SystemExit(2)


# The legacy six already had constructors in bridge_events.py before the custom
# contract existed. They are part of the same wire contract, so they belong in
# the schema even though they are not re-declared as models here — see
# _LEGACY_SHAPES below, which states their required keys.
LEGACY_REQUIRED_KEYS: dict[str, list[str]] = {
    "tool_call_begin": ["call_id", "name"],
    "tool_call_delta": ["call_id", "output"],
    "tool_call_end": ["call_id", "name", "success"],
    "stream_retry": ["attempt"],
    "plan_update": [],
    "approval_request": [],
}


def _build_wrapper():
    """A model holding one optional field per custom event key.

    Declaring the wrapper (rather than assembling a dict by hand) is what makes
    pydantic emit proper `$defs` and `$ref`s instead of nine inlined copies.

    __annotations__ has to be part of the namespace passed to type(), not assigned
    afterwards: real pydantic inspects annotations during class construction and
    rejects a bare `= None` attribute. The test suite's pydantic stub would have
    accepted either form, so this is only caught because the generator runs
    against real pydantic.
    """
    annotations = {
        f"event_{key}": Optional[model]
        for key, model in sorted(be.CUSTOM_EVENT_MODELS.items())
    }
    namespace: dict = {"__annotations__": annotations}
    for field_name in annotations:
        namespace[field_name] = None
    return type("HermesCustomDelta", (BaseModel,), namespace)


def build_schema() -> dict:
    wrapper = _build_wrapper()
    generated = wrapper.model_json_schema(
        ref_template="#/$defs/{model}",
    )

    properties: dict = {}
    for key in sorted(be.CUSTOM_EVENT_MODELS):
        properties[key] = {"$ref": f"#/$defs/{be.CUSTOM_EVENT_MODELS[key].__name__}"}

    for key, required in sorted(LEGACY_REQUIRED_KEYS.items()):
        legacy: dict = {
            "type": "object",
            "description": f"Legacy structured event '{key}' (constructor predates the custom contract).",
            "additionalProperties": True,
        }
        if required:
            legacy["required"] = required
            legacy["properties"] = {
                name: {"title": name} for name in required
            }
        properties[key] = legacy

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://spark.local/schemas/hermes-events.schema.json",
        "title": "Hermes bridge custom SSE delta",
        "description": (
            "Custom event keys the hermes-bridge may place inside a "
            "chat.completion.chunk delta. Generated from the Pydantic models in "
            "hermes-bridge/bridge_events.py by "
            "hermes-bridge/generate_event_schema.py. Do not edit by hand; run "
            "`npm run gen:hermes-contract`."
        ),
        "type": "object",
        "additionalProperties": True,
        "properties": properties,
        "$defs": generated.get("$defs", {}),
        "x-generated-by": "hermes-bridge/generate_event_schema.py",
        # Deliberately NOT recording the pydantic version. The output was verified
        # byte-identical under pydantic 2.12 and 2.13, so embedding the version
        # would only make the checked-in artifact churn — and make `npm run
        # check:hermes-contract` fail spuriously in CI, which installs a
        # different pydantic than any given developer machine. If a future
        # pydantic release does change the emitted schema, that will show up as a
        # real, explainable diff rather than a version bump.
    }


def render(schema: dict) -> str:
    """Deterministic serialization, so --check produces no spurious diffs."""
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit non-zero if the checked-in schema is stale",
    )
    args = parser.parse_args()

    rendered = render(build_schema())

    if args.check:
        if not os.path.exists(OUTPUT_PATH):
            print(f"missing {OUTPUT_PATH}", file=sys.stderr)
            return 1
        with open(OUTPUT_PATH, encoding="utf-8") as handle:
            existing = handle.read()
        if existing != rendered:
            print(
                f"{os.path.relpath(OUTPUT_PATH, REPO_ROOT)} is stale. "
                "Run `npm run gen:hermes-contract` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print("hermes event schema is up to date")
        return 0

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as handle:
        handle.write(rendered)
    print(f"wrote {os.path.relpath(OUTPUT_PATH, REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
