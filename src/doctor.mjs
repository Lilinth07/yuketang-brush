#!/usr/bin/env node
/**
 * 环境自检：node src/doctor.mjs
 * 把「跑不起来」的常见原因一次性列清楚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, OUT, COOKIE_FILE, CONFIG_FILE, CFG, loadConfig } from './config.mjs';
import { color, ok, fail, warn, info } from './ui.mjs';

const results = [];
const add = (level, name, detail, hint) => results.push({ level, name, detail, hint });

/* 1. Node（import.meta.dirname 需要 20.11+） */
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 20 || (major === 20 && minor >= 11)) add('ok', 'Node.js', `v${process.versions.node}`);
else add('fail', 'Node.js', `v${process.versions.node}`, '需要 >= 20.11，去 nodejs.org 装 LTS');

/* 2. playwright */
let pw = null;
try {
  pw = await import('playwright');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/playwright/package.json'), 'utf8'));
  add('ok', 'playwright', `v${pkg.version}`);
} catch {
  add('fail', 'playwright', '未安装', '运行 npm install');
}

/* 3. 浏览器通道 */
if (pw) {
  const want = CFG.channel;
  let found = false;
  try {
    const exe = pw.chromium.executablePath();
    found = Boolean(exe && fs.existsSync(exe));
  } catch {}
  const known = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((p) => fs.existsSync(p));

  if (known.length) add('ok', '浏览器', `${known.length} 个可用：${known.map((p) => path.basename(p)).join(', ')}`);
  else if (found) add('ok', '浏览器', 'playwright 自带 chromium');
  else add('fail', '浏览器', `没找到 ${want}`, '装 Edge 或 Chrome，或运行 npx playwright install chromium');
}

/* 4. 配置 */
const cfg = loadConfig();
if (!cfg.courses.length) {
  add('fail', '配置', 'config.local.json 不存在或没有课程', '运行 npm run setup');
} else {
  const c = cfg.courses[0];
  const need = ['classroomId', 'courseId', 'skuId', 'sign', 'lmsUserId', 'cc'];
  const miss = need.filter((k) => !c[k]);
  if (miss.length) add('fail', '配置', `${cfg.courses.length} 门课，第一门缺 ${miss.join(', ')}`, `运行 npm run setup -- --url "${c.url || ''}"`);
  else
    add(
      'ok',
      '配置',
      `${cfg.courses.length} 门课 · ${c.name} · 视频 ${c.videoCount || '?'} 个`,
    );
}

/* 5. 登录态 */
if (!fs.existsSync(COOKIE_FILE)) {
  add('fail', '登录态', 'out/cookies.json 不存在', '运行 npm run setup');
} else {
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  const origin = cfg.courses[0]?.origin || CFG.origin;
  const cookie = cookies.map((x) => `${x.name}=${x.value}`).join('; ');
  try {
    const r = await fetch(`${origin}/api/v3/user/basic-info`, {
      headers: { cookie, xtbz: 'ykt', 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    if (j.code === 0 && j.data?.id) {
      add('ok', '登录态', `${j.data.name} (${j.data.id}) · ${cookies.length} 条 cookie`);
    } else {
      add('fail', '登录态', `已过期（code=${j.code}）`, '重新运行 npm run setup');
    }
  } catch (e) {
    add('warn', '登录态', `无法验证：${e.message}`, '检查网络');
  }
}

/* 6. 章节树缓存 */
const leafFile = cfg.courses[0] ? path.join(OUT, `leaves-${cfg.courses[0].classroomId}.json`) : null;
if (leafFile && fs.existsSync(leafFile)) {
  const n = JSON.parse(fs.readFileSync(leafFile, 'utf8')).filter((l) => l.leaf_type === 0).length;
  add('ok', '章节树', `${path.basename(leafFile)} · 视频 ${n} 个`);
} else if (leafFile) {
  add('warn', '章节树', '缓存缺失', '运行 npm run setup 重新拉取');
}

/* 输出 */
const icon = { ok: color.green('✓'), warn: color.yellow('!'), fail: color.red('✗') };
const w = Math.max(...results.map((r) => r.name.length));

console.log('\n' + color.bold('环境自检') + '\n');
for (const r of results) {
  console.log(`  ${icon[r.level]} ${r.name.padEnd(w)}  ${r.detail}`);
  if (r.hint) console.log(`    ${color.gray('→ ' + r.hint)}`);
}

const bad = results.filter((r) => r.level === 'fail').length;
console.log('');
if (bad) {
  console.log(fail(`${bad} 项需要修复`));
  process.exit(1);
}
console.log(ok('全部就绪，可以运行 npm run brush'));
