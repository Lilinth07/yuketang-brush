#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! "$ROOT/scripts/bootstrap-mac.sh"; then read -r -p '环境准备失败，按回车关闭。'; exit 1; fi
export PATH="$ROOT/.runtime/node/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.runtime/browsers"
export BROWSER_CHANNEL=chromium
cd "$ROOT" || exit 1
if curl -fsS --max-time 2 http://127.0.0.1:7788/api/health >/dev/null 2>&1; then
  open http://127.0.0.1:7788
  exit 0
fi
(
  for attempt in {1..30}; do
    if curl -fsS --max-time 1 http://127.0.0.1:7788/api/health >/dev/null 2>&1; then open http://127.0.0.1:7788; exit 0; fi
    sleep 1
  done
) &
node src/server.mjs
