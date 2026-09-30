#!/usr/bin/env python3
import json, os, sys

workspace = os.environ["RALPH_WORKSPACE_DIR"]
prompt = os.environ["RALPH_ROUND_PROMPT"]

# read previous handoff from the prompt (the only cross-round channel)
prev = "none"
if "Previous structured handoff: " in prompt:
    seg = prompt.split("Previous structured handoff: ", 1)[1].split("\n", 1)[0]
    prev = seg

counter_path = os.path.join(workspace, "counter.txt")
count = 0
if os.path.exists(counter_path):
    with open(counter_path) as f:
        count = int(f.read().strip() or 0)
count += 1
with open(counter_path, "w") as f:
    f.write(str(count))

# complete on round 3, else continue with next steps
if count >= 3:
    report = {"status": "complete", "summary": f"done after {count} rounds (prev: {prev[:40]})",
              "evidence": [f"counter.txt == {count}"], "nextSteps": [], "blocker": ""}
else:
    report = {"status": "continue", "summary": f"round {count} done (prev: {prev[:40]})",
              "evidence": [f"counter.txt == {count}"], "nextSteps": ["keep going"], "blocker": ""}

print(f"RALPH_REPORT:{json.dumps(report)}")
sys.exit(0)
