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
import { ROOT, OUT, CONFIG_FILE, loadConfig, getActiveCourse } from './config.mjs';

const PORT = Number(process.env.UI_PORT || 7788);
const HOST = '127.0.0.1';

const clients = new Set();
let running = null; // { name, child, startedAt }

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
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
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

function startTask(taskKey, extraArgs = []) {
  if (running) return { ok: false, error: '已有任务在跑，请等它结束' };
  const def = TASKS[taskKey];
  if (!def) return { ok: false, error: `未知任务 ${taskKey}` };
  const args = def.args === null ? extraArgs : [...def.args, ...extraArgs];

  const child = spawn(process.execPath, [path.join(ROOT, 'src', def.file), ...args], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  running = { name: def.name, child, startedAt: Date.now() };
  broadcast('start', { name: def.name, args });

  const push = (buf) => {
    const text = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) broadcast('log', { line });
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);

  child.on('exit', (code) => {
    broadcast('done', { name: def.name, code });
    running = null;
  });
  child.on('error', (e) => {
    broadcast('log', { line: `启动失败：${e.message}` });
    broadcast('done', { code: -1 });
    running = null;
  });

  return { ok: true };
}

/* ───────── 路由 ───────── */

const server = http.createServer(async (req, res) => {
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
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/api/status') return json(res, 200, await status());

  if (url.pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    const r = startTask(body.task, body.args || []);
    return json(res, r.ok ? 200 : 409, r);
  }

  if (url.pathname === '/api/stop' && req.method === 'POST') {
    if (!running) return json(res, 200, { ok: false });
    running.child.kill();
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/llm' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    cfg.llm = {
      baseUrl: body.baseUrl || 'https://api.deepseek.com/v1',
      model: body.model || 'deepseek-chat',
      apiKey: body.apiKey || '',
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/courses' && req.method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, { courses: cfg.courses || [], active: cfg.active });
  }

  if (url.pathname === '/api/switch' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = loadConfig();
    cfg.active = Number(body.classroomId);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  界面已启动：http://${HOST}:${PORT}`);
  console.log('  关闭窗口或按 Ctrl+C 结束');
  console.log('');
});
