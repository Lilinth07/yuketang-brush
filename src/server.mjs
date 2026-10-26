#!/usr/bin/env node
/**
 * 本地 Web 界面：npm run ui
 *
 * 只监听 127.0.0.1。业务逻辑不重写，直接调用现有 CLI（exam.mjs / brush.mjs），
 * 把 stdout 用 SSE 推到浏览器。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ROOT, OUT, CONFIG_FILE, loadConfig, saveConfig, getActiveCourse } from './config.mjs';

const PORT = Number(process.env.UI_PORT || 7788);
const HOST = '127.0.0.1';

const clients = new Set();
let running = null; // { name, child, startedAt }
let terminalText = '服务终端已就绪。可以输入 npm run setup，或点击「初始化课程」。\n';
let outputSequence = 0;
const appendTerminal = (text) => {
  terminalText = (terminalText + text).slice(-200000);
  broadcast('terminal', { text, sequence: ++outputSequence });
};

function stopTask(job = running) {
  if (!job) return;
  const signal = (name) => {
    try {
      if (process.platform === 'win32') job.child.kill(name);
      else process.kill(-job.child.pid, name);
    } catch {}
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 2500).unref();
}

/* ───────── 工具 ───────── */

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      b += c;
      if (b.length > 65536) { tooLarge = true; b = ''; }
    });
    req.on('end', () => {
      try {
        const body = b ? JSON.parse(b) : {};
        resolve(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/* ───────── 状态 ───────── */

async function courseStat(course) {
  const cookieFile = path.join(OUT, 'cookies.json');
  if (!course || !fs.existsSync(cookieFile)) return null;
  const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const url = `${course.origin}/c27/online_courseware/course/classroom/${course.classroomId}/${course.skuId}/study_stat/?classroom_id=${course.classroomId}&term=latest&uv_id=${course.universityId}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
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
    }).finally(() => clearTimeout(t));
    const j = await r.json();
    const up = j?.data?.unit_progress;
    if (!up) return null;
    return {
      done: up.completed,
      total: up.total,
      score: j.data.score,
      unfinished: (j.data.unfinished?.by_type || []).reduce((s, x) => s + x.count, 0),
    };
  } catch {
    return null;
  }
}

async function status() {
  const cfg = loadConfig();
  const course = getActiveCourse(cfg);
  const stat = await courseStat(course);
  const cookieFile = path.join(OUT, 'cookies.json');
  return {
    course: course
      ? {
          name: course.name,
          classroomId: course.classroomId,
          videoCount: course.videoCount,
          origin: course.origin,
        }
      : null,
    stat,
    loggedIn: fs.existsSync(cookieFile),
    ai: {
      configured: Boolean(cfg.llm?.apiKey || process.env.LLM_API_KEY),
      model: cfg.llm?.model || process.env.LLM_MODEL || 'deepseek-chat',
      baseUrl: cfg.llm?.baseUrl || 'https://api.deepseek.com/v1',
    },
    running: running ? { name: running.name, since: running.startedAt } : null,
    courses: (cfg.courses || []).length,
  };
}

/* ───────── 任务 ───────── */

const TASKS = {
  'video': { file: 'brush.mjs', args: [], name: '刷视频' },
  'video-exam': { file: 'brush.mjs', args: ['--exam'], name: '视频 + 作业' },
  'exam-list': { file: 'exam.mjs', args: ['--list'], name: '作业列表' },
  'exam-auto': { file: 'exam.mjs', args: ['--all', '--auto', '--fill', '--api'], name: 'AI 答题' },
  'exam-submit': { file: 'exam.mjs', args: ['--all', '--fill', '--api'], name: '提交已有答案' },
  'exam-export': { file: 'exam.mjs', args: null, name: '导出题目' },
  'verify': { file: 'verify.mjs', args: [], name: '复核完成度' },
  'llm-check': { file: 'exam.mjs', args: ['--llm-check'], name: 'AI 连通测试' },
};

function startTask(taskKey, extraArgs = [], commandDefinition = null) {
  if (running) return { ok: false, error: '已有任务在跑，请等它结束' };
  const def = commandDefinition || TASKS[taskKey];
  if (!def) return { ok: false, error: `未知任务 ${taskKey}` };
  if (!Array.isArray(extraArgs) || extraArgs.length > 64 || extraArgs.some((x) => typeof x !== 'string' || x.length > 8192)) return { ok: false, error: '命令参数格式不正确' };
  const args = def.args === null ? extraArgs : [...def.args, ...extraArgs];

  const child = spawn(process.execPath, [path.join(ROOT, 'src', def.file), ...args], {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    env: { ...process.env, NO_COLOR: '1' },
  });

  running = { name: def.name, child, startedAt: Date.now() };
  child.stdin.on('error', () => {});
  appendTerminal(`\n$ ${def.name}\n`);
  broadcast('start', { name: def.name, args });

  const push = (text) => {
    text = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
    appendTerminal(text);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) broadcast('log', { line });
    }
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (buf) => push(decoder.write(buf)));
    stream.on('end', () => { const tail = decoder.end(); if (tail) push(tail); });
  }

  child.on('close', (code, signal) => {
    appendTerminal(`\n[${signal ? '已停止' : `退出码 ${code}`}]\n`);
    broadcast('done', { name: def.name, code, signal });
    if (running?.child === child) running = null;
  });
  child.on('error', (e) => {
    broadcast('log', { line: `启动失败：${e.message}` });
    broadcast('done', { code: -1 });
    if (running?.child === child) running = null;
  });

  return { ok: true };
}

const COMMANDS = {
  setup: ['setup.mjs'], login: ['login.mjs'], doctor: ['doctor.mjs'],
  menu: ['menu.mjs'], brush: ['brush.mjs'], dry: ['brush.mjs', '--dry'],
  verify: ['verify.mjs'], logstat: ['logstat.mjs'], exam: ['exam.mjs'],
  llm: ['llm.mjs'], 'llm-check': ['exam.mjs', '--llm-check'],
};

// Parse command arguments without invoking a system shell.
function parseCommand(command) {
  if (typeof command !== 'string' || command.length > 8192 || /[\r\n\0]/.test(command)) throw new Error('请输入一行项目命令');
  const words = [];
  let word = '', quote = '', active = false;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      active = true;
    } else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) {
      if (active) { words.push(word); word = ''; active = false; }
    } else { word += char; active = true; }
  }
  if (quote) throw new Error('命令中的引号没有闭合');
  if (active) words.push(word);
  if (words[0] !== 'npm' || words[1] !== 'run' || !Object.hasOwn(COMMANDS, words[2])) {
    throw new Error('请输入本服务的 npm run 命令，例如 npm run setup、npm run doctor');
  }
  const [file, ...defaults] = COMMANDS[words[2]];
  const extra = words.slice(words[3] === '--' ? 4 : 3);
  return { file, args: [...defaults, ...extra], name: command.trim() };
}

/* ───────── 路由 ───────── */

async function handleRequest(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Yuketang-Service-Pid', String(process.pid));
  const allowedHosts = [`${HOST}:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: '仅限本机页面访问' });
  if (req.method === 'POST' && (
    (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`)) ||
    req.headers['sec-fetch-site'] === 'cross-site' ||
    !req.headers['content-type']?.startsWith('application/json')
  )) return json(res, 403, { error: '请从本服务页面操作' });
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    res.write(`event: terminal-snapshot\ndata: ${JSON.stringify({ text: terminalText, sequence: outputSequence })}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/health') return json(res, 200, {ok:true,pid:process.pid});
  if (url.pathname === '/api/status') return json(res, 200, await status());

  if (url.pathname === '/api/terminal/run' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const def = parseCommand(body.command);
      const result = startTask(null, [], def);
      return json(res, result.ok ? 200 : 409, result);
    } catch (error) { return json(res, 400, { ok: false, error: error.message }); }
  }
  if (url.pathname === '/api/terminal/input' && req.method === 'POST') {
    const body = await readBody(req);
    if (!running || running.child.stdin.destroyed) return json(res, 409, { ok: false, error: '当前没有等待输入的命令' });
    if (typeof body.text !== 'string' || body.text.length > 16384 || /[\r\n\0]/.test(body.text)) return json(res, 400, { ok: false, error: '请一次输入一行内容' });
    running.child.stdin.write(body.text + '\n');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const r = startTask(body.task, body.args || []);
    return json(res, r.ok ? 200 : 409, r);
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (!running) return json(res, 200, { ok: false });
    stopTask();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/llm' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    if (['baseUrl','model','apiKey'].some((key) => body[key] !== undefined && typeof body[key] !== 'string')) return json(res, 400, {ok:false,error:'AI 配置必须填写文字'});
    try {
      const endpoint = new URL(body.baseUrl || cfg.llm?.baseUrl || 'https://api.deepseek.com/v1');
      if (!['http:','https:'].includes(endpoint.protocol)) throw new Error();
    } catch { return json(res, 400, {ok:false,error:'请填写有效的 http:// 或 https:// AI 接口地址'}); }
    cfg.llm = {
      baseUrl: body.baseUrl || cfg.llm?.baseUrl || 'https://api.deepseek.com/v1',
      model: body.model || cfg.llm?.model || 'deepseek-chat',
      apiKey: body.apiKey?.trim() || cfg.llm?.apiKey || '',
    };
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/courses' && req.method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, { courses: (cfg.courses || []).map(({classroomId,name}) => ({classroomId,name})), active: cfg.active });
  }

  if (url.pathname === '/api/switch' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    if (running) return json(res, 409, { ok:false, error:'请先等待当前任务结束，再切换课程' });
    if (!cfg.courses.some((course) => Number(course.classroomId) === Number(body.classroomId))) return json(res, 400, { ok:false, error:'找不到所选课程' });
    cfg.active = Number(body.classroomId);
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('网页请求失败：'+error.message);
    if (!res.headersSent) json(res, 500, {ok:false,error:'操作失败，请检查本地配置或查看服务日志'});
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  界面已启动：http://${HOST}:${PORT}`);
  console.log('  关闭窗口或按 Ctrl+C 结束');
  console.log('');
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const job = running;
  const taskClosed = job ? new Promise((resolve) => job.child.once('close', resolve)) : Promise.resolve();
  stopTask(job);
  for (const client of clients) client.end();
  server.close();
  await Promise.race([taskClosed, new Promise((resolve) => setTimeout(resolve, 2800))]);
  if (job && process.platform !== 'win32') { try { process.kill(-job.child.pid, 'SIGKILL'); } catch {} }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? '本机端口 7788 已被占用，请先退出旧的雨课堂服务。' : error.message);
  shutdown();
});
if (process.env.YUKETANG_APP_MANAGED === '1') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    shutdown();
  });
}
