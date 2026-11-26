#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MACOS_VERSION=13.5
TARGET="$(uname -m)-apple-macos${MACOS_VERSION}"
"$ROOT/scripts/bootstrap-mac.sh"
APP="${YUKETANG_APP_OUTPUT:-$ROOT/dist/雨课堂.app}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
MACOS="$STAGE/雨课堂.app/Contents/MacOS"
RESOURCES="$STAGE/雨课堂.app/Contents/Resources"
PROJECT="$RESOURCES/project"
mkdir -p "$MACOS" "$PROJECT" "$(dirname "$APP")"
xcrun --find swiftc >/dev/null || { echo '请先安装 Xcode Command Line Tools：xcode-select --install' >&2; exit 1; }
xcrun swiftc -target "$TARGET" "$ROOT/macos/MenuBarApp.swift" -o "$MACOS/Yuketang" -framework Cocoa
xcrun clang -target "$TARGET" "$ROOT/macos/service-launcher.c" -o "$MACOS/service-launcher"
cp "$ROOT/macos/Info.plist" "$STAGE/雨课堂.app/Contents/Info.plist"
if [[ -n "${YUKETANG_APP_DATA_DIR:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :YuketangDataDirectory string $YUKETANG_APP_DATA_DIR" "$STAGE/雨课堂.app/Contents/Info.plist"
fi
xcrun swiftc -target "$TARGET" "$ROOT/macos/GenerateIcon.swift" -o "$STAGE/render-icon" -framework Cocoa
"$STAGE/render-icon" "$STAGE/AppIcon.iconset"
iconutil -c icns "$STAGE/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns"
# Copy a deliberate allowlist. Account data and local configuration never enter the app.
for item in src scripts docs; do ditto "$ROOT/$item" "$PROJECT/$item"; done
mkdir -p "$PROJECT/.runtime" "$PROJECT/node_modules"
for dependency in playwright playwright-core; do
  ditto "$ROOT/node_modules/$dependency" "$PROJECT/node_modules/$dependency"
done
ditto "$ROOT/.runtime/node" "$PROJECT/.runtime/node"
for item in package.json package-lock.json README.md LICENSE; do cp "$ROOT/$item" "$PROJECT/$item"; done
codesign --force --sign - "$MACOS/service-launcher"
codesign --force --sign - "$STAGE/雨课堂.app"
codesign --verify "$STAGE/雨课堂.app"
if [[ -e "$APP" ]]; then rm -rf "$APP"; fi
mv "$STAGE/雨课堂.app" "$APP"
echo "已生成：$APP"
echo '可将它拖到「应用程序」。此为本地签名构建；公开分发需由发布者另行签名与公证。'
