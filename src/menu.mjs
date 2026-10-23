#!/usr/bin/env node
/**
 * 双击 启动.bat 后进入的交互菜单。
 * 目标：不需要知道任何命令，只按数字。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { ROOT, OUT, LOGDIR, COOKIE_FILE, CONFIG_FILE, loadConfig } from './config.mjs';
import { color, truncate, visualWidth } from './ui.mjs';

const BIN = process.execPath;
const SRC = (f) => path.join(ROOT, 'src', f);

// 不依赖 ANSI 清屏，任何控制台都不会出现乱码
const clear = () => process.stdout.write('\n'.repeat(30));

async function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

const run = (file, args = []) =>
  new Promise((resolve) => {
    const p = spawn(BIN, [SRC(file), ...args], { stdio: 'inherit', cwd: ROOT });
    p.on('exit', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(1));
  });

/* ───── 状态 ───── */

let cache = null;
let cacheAt = 0;

async function fetchStat(course) {
  if (!course || !fs.existsSync(COOKIE_FILE)) return null;
  const now = Date.now();
  if (cache && now - cacheAt < 8000) return cache;

  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const url = `${course.origin}/c27/online_courseware/course/classroom/${course.classroomId}/${course.skuId}/study_stat/?classroom_id=${course.classroomId}&term=latest&uv_id=${course.universityId}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: {
        cookie,
        xtbz: 'ykt',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
        accept: 'application/json, text/plain, */*',
        referer: `${course.origin}/v2/web/studentLog/${course.classroomId}`,
      },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    const j = await r.json();
    const up = j?.data?.unit_progress;
    const res = up
      ? { done: up.completed, total: up.total, label: up.display, score: j.data.score, study: j.data.study_progress }
      : null;
    cache = res;
    cacheAt = now;
    return res;
  } catch {
    return null;
  }
}

function box(lines) {
  const w = Math.max(...lines.map((l) => visualWidth(l))) + 2;
  const top = '┌' + '─'.repeat(w) + '┐';
  const bot = '└' + '─'.repeat(w) + '┘';
  const body = lines.map((l) => '│ ' + l + ' '.repeat(w - visualWidth(l) - 1) + '│');
  return [top, ...body, bot].join('\n');
}

function kv(label, value, width = 8) {
  return color.gray(label) + ' '.repeat(Math.max(1, width - visualWidth(label))) + value;
}

/* ───── 主界面 ───── */

let lastMsg = '';

async function render(cfg) {
  clear();
  const course = cfg.courses[0];

  console.log(
    color.bold(
      box([
        '雨课堂刷课器',
        color.gray('双击就能用 · 无需命令'),
      ]),
    ),
  );
  console.log('');

  if (!course) {
    console.log(`  ${color.yellow('还没有配置课程')}`);
    console.log(color.gray('  先扫码登录，再粘贴一次课程页面的网址就行。'));
    console.log('');
    console.log(`  ${color.green('[1]')} 开始配置`);
    console.log(`  ${color.gray('[0]')} 退出`);
    console.log('');
    return { items: { '1': 'setup' }, configured: false };
  }

  const stat = await fetchStat(course);
  const total = course.videoCount || 0;

  console.log(`  ${kv('课程', color.bold(truncate(course.name, 34)))}`);
  console.log(`  ${kv('视频', `${total} 个`)}`);
  if (stat) {
    const pct = stat.total ? ((stat.done / stat.total) * 100).toFixed(0) : '0';
    const barW = 24;
    const filled = Math.round((barW * stat.done) / (stat.total || 1));
    const bar = color.green('█'.repeat(filled)) + color.gray('░'.repeat(Math.max(0, barW - filled)));
    console.log(`  ${kv('总进度', `${bar} ${stat.done}/${stat.total} ${pct}%`)}`);
    if (stat.score != null) console.log(`  ${kv('得分', String(stat.score))}`);
  } else {
    console.log(`  ${kv('进度', color.gray('读取中…（登录态可能已过期）'))}`);
  }
  console.log('');

  if (cfg.courses.length > 1) {
    console.log(color.gray(`  另有 ${cfg.courses.length - 1} 门课已配置，可在「更换课程」里切换`));
    console.log('');
  }

  console.log(`  ${color.green('[1]')} 开始刷课`);
  console.log(`  ${color.green('[2]')} 查看完成情况`);
  console.log(`  ${color.green('[3]')} 添加 / 更换课程`);
  console.log(`  ${color.gray('[4]')} 环境诊断`);
  console.log(`  ${color.gray('[5]')} 打开日志文件夹`);
  console.log(`  ${color.gray('[0]')} 退出`);
  console.log('');

  if (lastMsg) {
    console.log(`  ${lastMsg}`);
    lastMsg = '';
    console.log('');
  }

  return { items: { '1': 'brush', '2': 'verify', '3': 'setup', '4': 'doctor', '5': 'logs', '0': 'exit' }, configured: true };
}

/* ───── 动作 ───── */

async function actSetup() {
  clear();
  console.log(color.cyan('  开始配置课程\n'));
  await run('setup.mjs');
  cache = null;
  await ask(color.gray('  按回车返回菜单 '));
}

async function actBrush() {
  clear();
  const mode = await ask(
    `  ${color.gray('先演练一遍看计划？')}\n` +
      `  ${color.green('[1]')} 直接开始\n` +
      `  ${color.gray('[2]')} 先演练（不发请求）\n` +
      `  请选择 > `,
  );
  clear();
  if (mode === '2') {
    await run('brush.mjs', ['--dry', '--no-verify']);
    console.log('');
    const go = await ask(`  ${color.gray('演练没问题，现在正式跑？(y/N) > ')}`);
    if (!/^y/i.test(go)) return;
    clear();
  }
  await run('brush.mjs');
  cache = null;
  console.log('');
  await ask(color.gray('  按回车返回菜单 '));
}

async function actVerify() {
  clear();
  await run('verify.mjs');
  cache = null;
  console.log('');
  await ask(color.gray('  按回车返回菜单 '));
}

async function actDoctor() {
  clear();
  await run('doctor.mjs');
  console.log('');
  await ask(color.gray('  按回车返回菜单 '));
}

async function actLogs() {
  const dir = fs.existsSync(LOGDIR) ? LOGDIR : OUT;
  try {
    spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    lastMsg = color.green(`已打开 ${path.relative(ROOT, dir)}`);
  } catch {
    lastMsg = color.yellow(`打开失败，手动去 ${dir}`);
  }
}

/* ───── 入口 ───── */

async function main() {
  for (;;) {
    const cfg = loadConfig();
    const menu = await render(cfg);

    const ans = await ask(color.gray('  请选择 > '));
    if (!ans) continue;

    if (ans === '0' || ans.toLowerCase() === 'q') {
      clear();
      console.log(color.gray('\n  再见\n'));
      return;
    }

    // 未配置时，任何非 0 输入都直接进配置
    if (!menu.configured) {
      if (ans === '1') await actSetup();
      continue;
    }

    switch (menu.items[ans]) {
      case 'brush':
        await actBrush();
        break;
      case 'verify':
        await actVerify();
        break;
      case 'setup':
        await actSetup();
        break;
      case 'doctor':
        await actDoctor();
        break;
      case 'logs':
        await actLogs();
        break;
      default:
        break;
    }
  }
}

process.on('SIGINT', () => {
  clear();
  console.log(color.gray('\n  已退出\n'));
  process.exit(0);
});

main().catch((e) => {
  console.error(color.red(`\n  出错：${e.message}\n`));
  process.exit(1);
});
