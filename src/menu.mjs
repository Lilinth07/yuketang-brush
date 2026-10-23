#!/usr/bin/env node
/**
 * 双击 启动.bat 后进入的交互菜单。
 * 目标：不需要知道任何命令，只按数字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, OUT, LOGDIR, COOKIE_FILE,
  loadConfig, getActiveCourse, setActiveCourse, removeCourse,
} from './config.mjs';
import { color, truncate, visualWidth } from './ui.mjs';

const BIN = process.execPath;
const SRC = (f) => path.join(ROOT, 'src', f);

// 不依赖 ANSI 清屏，任何控制台都不会出现乱码
const clear = () => process.stdout.write('\n'.repeat(30));

/**
 * 自带行缓冲的输入器。
 * 不用 readline：它每次 close 都会丢掉内核缓冲里已到达的行，
 * 导致「菜单里连点两下，第二下没反应」。
 */
class LineReader {
  constructor(stream = process.stdin) {
    this.lines = [];
    this.waiters = [];
    this.partial = '';
    this.stream = stream;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      this.partial += chunk;
      let i;
      while ((i = this.partial.indexOf('\n')) >= 0) {
        const line = this.partial.slice(0, i).replace(/\r$/, '');
        this.partial = this.partial.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
    stream.on('end', () => {
      while (this.waiters.length) this.waiters.shift()('');
    });
  }

  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((res) => this.waiters.push(res));
  }

  async ask(prompt) {
    process.stdout.write(prompt);
    return (await this.next()).trim();
  }
}

const input = new LineReader();
const ask = (prompt) => input.ask(prompt);

const run = (file, args = []) =>
  new Promise((resolve) => {
    // 让子进程独占 stdin
    process.stdin.pause();
    const p = spawn(BIN, [SRC(file), ...args], { stdio: 'inherit', cwd: ROOT });
    const done = (code) => {
      process.stdin.resume();
      resolve(code ?? 0);
    };
    p.on('exit', done);
    p.on('error', () => done(1));
  });

/* ───── 进度缓存 ───── */

const statCache = new Map();

async function fetchStat(course, { force = false } = {}) {
  if (!course || !fs.existsSync(COOKIE_FILE)) return null;
  const key = course.classroomId;
  const hit = statCache.get(key);
  if (!force && hit && Date.now() - hit.at < 8000) return hit.data;

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
    const data = up
      ? { done: up.completed, total: up.total, label: up.display, score: j.data.score }
      : null;
    statCache.set(key, { at: Date.now(), data });
    return data;
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

function progressBar(done, total, width = 24) {
  const filled = Math.round((width * done) / (total || 1));
  return color.green('█'.repeat(filled)) + color.gray('░'.repeat(Math.max(0, width - filled)));
}

/* ───── 主界面 ───── */

let lastMsg = '';

async function render() {
  const cfg = loadConfig();
  const course = getActiveCourse(cfg);

  clear();
  console.log(color.bold(box(['雨课堂刷课器', color.gray('双击就能用 · 无需命令')])));
  console.log('');

  if (!course) {
    console.log(`  ${color.yellow('还没有配置课程')}`);
    console.log(color.gray('  先扫码登录，再粘贴一次课程页面的网址就行。'));
    console.log('');
    console.log(`  ${color.green('[1]')} 开始配置`);
    console.log(`  ${color.gray('[0]')} 退出`);
    console.log('');
    return { configured: false };
  }

  const stat = await fetchStat(course);

  console.log(`  ${kv('课程', color.bold(truncate(course.name, 32)))}`);
  console.log(`  ${kv('视频', `${course.videoCount || '?'} 个`)}`);
  if (stat) {
    const pct = stat.total ? ((stat.done / stat.total) * 100).toFixed(0) : '0';
    console.log(`  ${kv('总进度', `${progressBar(stat.done, stat.total)} ${stat.done}/${stat.total} ${pct}%`)}`);
    if (stat.score != null) console.log(`  ${kv('得分', String(stat.score))}`);
  } else {
    console.log(`  ${kv('进度', color.gray('读取中…（登录态可能已过期）'))}`);
  }

  if (cfg.courses.length > 1) {
    const pos = cfg.courses.findIndex((c) => Number(c.classroomId) === Number(course.classroomId)) + 1;
    console.log(`  ${kv('课程库', color.gray(`共 ${cfg.courses.length} 门，当前第 ${pos} 门`))}`);
  }
  console.log('');

  console.log(`  ${color.green('[1]')} 开始刷课`);
  console.log(`  ${color.green('[2]')} 查看完成情况`);
  console.log(`  ${color.cyan('[3]')} 课程管理${cfg.courses.length > 1 ? color.gray(`（${cfg.courses.length} 门）`) : ''}`);
  console.log(`  ${color.gray('[4]')} 环境诊断`);
  console.log(`  ${color.gray('[5]')} 打开日志文件夹`);
  console.log(`  ${color.gray('[0]')} 退出`);
  console.log('');

  if (lastMsg) {
    console.log(`  ${lastMsg}`);
    lastMsg = '';
    console.log('');
  }

  return { configured: true };
}

/* ───── 课程管理 ───── */

async function actCourses() {
  for (;;) {
    const cfg = loadConfig();
    const active = getActiveCourse(cfg);
    clear();

    console.log(color.bold('  课程管理') + '\n');

    if (!cfg.courses.length) {
      console.log(color.gray('  还没有课程。'));
    } else {
      cfg.courses.forEach((c, i) => {
        const isActive = Number(c.classroomId) === Number(active?.classroomId);
        const mark = isActive ? color.green('▶') : ' ';
        const name = isActive ? color.bold(truncate(c.name, 28)) : truncate(c.name, 28);
        console.log(`  ${mark} ${color.cyan(`[${i + 1}]`)} ${name}  ${color.gray(`${c.videoCount || '?'} 个视频`)}`);
      });
    }

    console.log('');
    console.log(`  ${color.green('[a]')} 添加新课程`);
    if (cfg.courses.length) console.log(`  ${color.yellow('[d]')} 删除课程`);
    console.log(`  ${color.gray('[0]')} 返回`);
    console.log('');

    const ans = (await ask(color.gray('  请选择 > '))).trim();
    if (!ans || ans === '0') return;

    if (ans.toLowerCase() === 'a') {
      await run('setup.mjs');
      statCache.clear();
      const go = await ask(color.gray('\n  按回车返回课程管理 '));
      void go;
      continue;
    }

    if (ans.toLowerCase() === 'd') {
      const n = Number((await ask(color.gray('  删除第几门？输入序号 > '))).trim());
      const target = cfg.courses[n - 1];
      if (!target) {
        await ask(color.gray('  序号无效，按回车继续 '));
        continue;
      }
      const sure = (await ask(`  确认删除「${truncate(target.name, 24)}」？(y/N) > `)).trim();
      if (/^y/i.test(sure)) {
        removeCourse(target.classroomId);
        statCache.clear();
        lastMsg = color.yellow(`已删除「${truncate(target.name, 20)}」`);
      }
      continue;
    }

    const n = Number(ans);
    if (cfg.courses[n - 1]) {
      const target = cfg.courses[n - 1];
      setActiveCourse(target.classroomId);
      statCache.clear();
      lastMsg = color.green(`已切换到「${truncate(target.name, 20)}」`);
      return;
    }
  }
}

/* ───── 其它动作 ───── */

async function actBrush() {
  clear();
  const course = getActiveCourse(loadConfig());
  console.log(color.bold(`  刷课  ·  ${course?.name || ''}\n`));

  const mode = await ask(
    `${color.gray('  先演练一遍看计划？')}\n` +
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
  statCache.clear();
  console.log('');
  await ask(color.gray('  按回车返回菜单 '));
}

async function actVerify() {
  clear();
  await run('verify.mjs');
  statCache.clear();
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
    const menu = await render();
    const ans = await ask(color.gray('  请选择 > '));

    if (ans === '0' || ans.toLowerCase() === 'q') {
      clear();
      console.log(color.gray('\n  再见\n'));
      return;
    }

    if (!menu.configured) {
      if (ans === '1' || ans.toLowerCase() === 'a') {
        clear();
        await run('setup.mjs');
        statCache.clear();
        await ask(color.gray('\n  按回车返回菜单 '));
      }
      continue;
    }

    switch (ans) {
      case '1':
        await actBrush();
        break;
      case '2':
        await actVerify();
        break;
      case '3':
        await actCourses();
        break;
      case '4':
        await actDoctor();
        break;
      case '5':
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
