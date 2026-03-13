#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PNG="$ROOT_DIR/src/assets/android-chrome-512x512.png"
BUILD_DIR="$ROOT_DIR/build"
PUBLIC_DIR="$ROOT_DIR/public"
TMP_DIR="$ROOT_DIR/.tmp/icon-build"
ICONSET_DIR="$TMP_DIR/CloudChat.iconset"
APP_ICON_PNG="$TMP_DIR/app-icon.png"
TRAY_ICON_PNG="$TMP_DIR/tray-icon-template.png"

rm -rf "$TMP_DIR"
mkdir -p "$ICONSET_DIR" "$BUILD_DIR" "$PUBLIC_DIR"

cp "$SOURCE_PNG" "$TMP_DIR/source.png"

BASE_PNG="$TMP_DIR/source.png"
swift "$ROOT_DIR/scripts/render-macos-icon.swift" "$BASE_PNG" "$APP_ICON_PNG"
swift "$ROOT_DIR/scripts/render-tray-template.swift" "$BASE_PNG" "$TRAY_ICON_PNG"

sips -z 1024 1024 "$APP_ICON_PNG" --out "$BUILD_DIR/icon.png" >/dev/null
cp "$TRAY_ICON_PNG" "$BUILD_DIR/tray-iconTemplate.png"
sips -z 32 32 "$BASE_PNG" --out "$PUBLIC_DIR/favicon.png" >/dev/null

sips -z 16 16 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$APP_ICON_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$APP_ICON_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"

rm -rf "$TMP_DIR"
printf 'Generated build/icon.icns, build/icon.png, build/tray-iconTemplate.png, and public/favicon.png\n'
