#!/usr/bin/env bash
# Generate per-scene voiceover via self-hosted Kokoro TTS (af_bella).
set -euo pipefail

TOK="52f875e519be9e85338a0b26f818c6fabb4b0e964ebb98829a02e91eca5c5ae6"
URL="https://tts.gwardo.dev/v1/audio/speech"
VOICE="af_bella"
OUT="$(cd "$(dirname "$0")" && pwd)/public/audio"
mkdir -p "$OUT"

# Scene id  ->  line of script
declare -a IDS=(01_intro 02_overview 03_usage 04_charts 05_chats 06_outro)
declare -a LINES=(
  "Meet Spark. Your command center for the Hermes agent."
  "Every session your agent runs, tracked in one place. Live sessions, cron jobs, and skills, all at a glance."
  "Usage? Crystal clear. Tokens in, tokens out, and cost per model, in real time."
  "Watch your activity trend across the week, model by model."
  "And every chat is right there. Replay any conversation, any session, instantly."
  "Spark. Keep track of Hermes, effortlessly."
)

for i in "${!IDS[@]}"; do
  id="${IDS[$i]}"; text="${LINES[$i]}"
  echo "→ $id : $text"
  curl -s -m 60 -X POST "$URL" \
    -H "Authorization: Bearer $TOK" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"model":"kokoro","input":%s,"voice":"%s","response_format":"mp3","speed":1.0}' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$text")" "$VOICE")" \
    -o "$OUT/$id.mp3" -w "   http=%{http_code} bytes=%{size_download}\n"
done

echo "=== durations ==="
for id in "${IDS[@]}"; do
  dur=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$OUT/$id.mp3")
  printf "%-14s %ss\n" "$id" "$dur"
done
