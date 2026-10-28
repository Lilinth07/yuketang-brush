#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! "$ROOT/scripts/bootstrap-mac.sh"; then read -r -p '环境准备失败，按回车关闭。'; exit 1; fi
export PATH="$ROOT/.runtime/node/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.runtime/browsers"
export BROWSER_CHANNEL=chromium
cd "$ROOT" || exit 1
node src/menu.mjs
