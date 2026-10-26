#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Darwin ]]; then echo '此入口仅用于 macOS。' >&2; exit 1; fi
NODE_VERSION="${NODE_VERSION:-24.22.1}"
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo '不支持的 Mac 架构' >&2; exit 1 ;; esac
NODE="$ROOT/.runtime/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  TEMP="$(mktemp -d)"
  trap 'rm -rf "$TEMP"' EXIT
  ARCHIVE="node-v${NODE_VERSION}-darwin-${ARCH}.tar.gz"
  BASE="https://nodejs.org/dist/v${NODE_VERSION}"
  echo '正在准备独立 Node.js 环境…'
  curl -fL --retry 2 "$BASE/SHASUMS256.txt" -o "$TEMP/SHASUMS256.txt"
  curl -fL --retry 2 "$BASE/$ARCHIVE" -o "$TEMP/$ARCHIVE"
  EXPECTED="$(awk -v file="$ARCHIVE" '$2 == file {print $1}' "$TEMP/SHASUMS256.txt")"
  ACTUAL="$(shasum -a 256 "$TEMP/$ARCHIVE" | awk '{print $1}')"
  [[ -n "$EXPECTED" && "$EXPECTED" == "$ACTUAL" ]] || { echo 'Node.js 校验失败' >&2; exit 1; }
  mkdir -p "$ROOT/.runtime/node"
  tar -xzf "$TEMP/$ARCHIVE" --strip-components=1 -C "$ROOT/.runtime/node"
fi
export PATH="$ROOT/.runtime/node/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$ROOT/.runtime/browsers"
export BROWSER_CHANNEL=chromium
cd "$ROOT"
if [[ ! -f node_modules/playwright/package.json ]]; then
  npm ci --ignore-scripts --no-audit --no-fund
fi
if ! "$NODE" --input-type=module -e 'import fs from "node:fs"; import {chromium} from "playwright"; process.exit(fs.existsSync(chromium.executablePath()) ? 0 : 1);'; then
  echo '正在安装独立浏览器（Chrome for Testing，不会替换系统浏览器）…'
  "$NODE" node_modules/playwright/cli.js install chromium --no-shell
fi
