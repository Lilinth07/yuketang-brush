#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! "$ROOT/scripts/bootstrap-mac.sh"; then read -r -p '环境准备失败，按回车关闭。'; exit 1; fi
export PATH="$ROOT/.runtime/node/bin:$PATH"
export YUKETANG_BROWSER=auto
cd "$ROOT" || exit 1
node src/menu.mjs
