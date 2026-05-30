#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$ROOT_DIR/.tmp/spark-brand"
ICONSET_DIR="$TMP_DIR/Spark.iconset"
SOURCE_MARK_SVG="$ROOT_DIR/src/assets/spark-mark.svg"
SOURCE_LOGO_SVG="$ROOT_DIR/docs/spark-logo.svg"
SOURCE_BANNER_SVG="$ROOT_DIR/docs/spark-repo-banner.svg"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR" "$ICONSET_DIR" "$ROOT_DIR/build" "$ROOT_DIR/public" "$ROOT_DIR/docs" "$ROOT_DIR/src/assets"

rsvg-convert -w 512 -h 512 "$SOURCE_MARK_SVG" > "$ROOT_DIR/src/assets/spark-mark.png"
rsvg-convert -w 1120 -h 280 "$SOURCE_LOGO_SVG" > "$ROOT_DIR/docs/spark-logo.png"
rsvg-convert -w 2560 -h 840 "$SOURCE_BANNER_SVG" > "$ROOT_DIR/docs/spark-repo-banner.png"

swift "$ROOT_DIR/scripts/render-macos-icon.swift" "$ROOT_DIR/src/assets/spark-mark.png" "$TMP_DIR/spark-app-icon.png"
swift "$ROOT_DIR/scripts/render-tray-template.swift" "$ROOT_DIR/src/assets/spark-mark.png" "$ROOT_DIR/build/spark-tray-iconTemplate.png"

sips -z 1024 1024 "$TMP_DIR/spark-app-icon.png" --out "$ROOT_DIR/build/spark-icon.png" >/dev/null
sips -z 32 32 "$ROOT_DIR/src/assets/spark-mark.png" --out "$ROOT_DIR/public/spark-favicon.png" >/dev/null
magick "$ROOT_DIR/public/spark-favicon.png" "$ROOT_DIR/public/spark-favicon.ico"

sips -z 16 16 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$TMP_DIR/spark-app-icon.png" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$TMP_DIR/spark-app-icon.png" "$ICONSET_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICONSET_DIR" -o "$ROOT_DIR/build/spark-icon.icns"

rm -rf "$TMP_DIR"
printf 'Generated Spark brand assets in docs/, src/assets/, build/, and public/.\n'
