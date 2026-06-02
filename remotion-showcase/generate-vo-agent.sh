#!/usr/bin/env bash
# Generate per-scene voiceover for the square Hermes-agent showcase
# via self-hosted Kokoro TTS (af_bella).
set -euo pipefail

TOK="52f875e519be9e85338a0b26f818c6fabb4b0e964ebb98829a02e91eca5c5ae6"
URL="https://tts.gwardo.dev/v1/audio/speech"
VOICE="af_bella"
OUT="$(cd "$(dirname "$0")" && pwd)/public/audio/agent"
mkdir -p "$OUT"

# Scene id  ->  line of script
declare -a IDS=(01_intro 02_task 03_loop 04_ship 05_approve 06_outro)
declare -a LINES=(
  "This is Spark. A Codex-style GUI for the Hermes agent."
  "Give Hermes a task in plain language, then step back."
  "Spark drives the Hermes agent loop. Real tools, streamed live."
  "It reads your code, runs your tests, and ships the fix."
  "Every tool call is visible. Approve once, per session, or always."
  "Spark. The GUI for Hermes agent."
)

for i in "${!IDS[@]}"; do
  id="${IDS[$i]}"; text="${LINES[$i]}"
  echo "→ $id : $text"
  body="$(printf '{"model":"kokoro","input":%s,"voice":"%s","response_format":"mp3","speed":1.0}' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$text")" "$VOICE")"
  for attempt in 1 2 3 4 5; do
    code=$(curl -s -m 60 -X POST "$URL" \
      -H "Authorization: Bearer $TOK" \
      -H "Content-Type: application/json" \
      -d "$body" \
      -o "$OUT/$id.mp3" -w "%{http_code}")
    bytes=$(stat -f%z "$OUT/$id.mp3" 2>/dev/null || echo 0)
    echo "   attempt=$attempt http=$code bytes=$bytes"
    if [ "$code" = "200" ] && [ "$bytes" -gt 1000 ]; then break; fi
    sleep 2
  done
done

echo "=== durations ==="
for id in "${IDS[@]}"; do
  dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUT/$id.mp3")
  printf "%-14s %ss\n" "$id" "$dur"
done
