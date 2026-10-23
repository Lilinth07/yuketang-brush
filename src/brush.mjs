#!/usr/bin/env node
/**
 * 雨课堂刷课器
 *
 *   npm run brush                     处理配置里的第一门课
 *   npm run brush -- --course 2       第二门课
 *   npm run brush -- --course <url>   按 URL 指定
 *   npm run brush -- --dry            只演练
 *   npm run brush -- --only 123,456   只跑指定节点
 *   npm run brush -- --verbose        滚动输出全部节点日志
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, OUT, LOGDIR, COOKIE_FILE, CFG, resolveCourse, loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createProgress, color, ok, fail, warn, info, truncate, visualWidth } from './ui.mjs';

/* ═══════════════ 参数 ═══════════════ */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OPT = {
  step: Number(val('step', 5)),
  tsStep: Number(val('ts-step', 5000)),
  margin: Number(val('margin', 12)),
  maxEvents: Number(val('max-events', 400)),
  sleepMs: Number(val('sleep', 1200)),
  retryRound: Number(val('retry', 60)),
  dry: flag('dry'),
  force: flag('force'),
  noVerify: flag('no-verify'),
  verbose: flag('verbose'),
  quiet: flag('quiet'),
  only: (val('only', '') || '').split(',').filter(Boolean).map(Number),
  course: val('course', null),
};

/* ═══════════════ 课程 ═══════════════ */

let course;
try {
  course = resolveCourse({ course: OPT.course, url: OPT.course && /^https?:/.test(OPT.course) ? OPT.course : null });
} catch (e) {
  console.error(`\n${fail(e.message)}\n`);
  process.exit(2);
}

const ORIGIN = course.origin || CFG.origin;
const REFERER = `${ORIGIN}/v2/web/studentLog/${course.classroomId}`;
const videoPage = (vid) => `${ORIGIN}/ai-workspace/lms-graph/${course.classroomId}/video/${vid}`;

/* ═══════════════ 日志 ═══════════════ */

let printer = (line) => console.log(line);

const log = createLogger({
  dir: LOGDIR,
  name: `brush-${course.classroomId}`,
  level: OPT.verbose ? 'debug' : 'info',
  echo: false,
  onLine: (line, rec) => {
    if (OPT.verbose || rec?.lvl === 'warn' || rec?.lvl === 'error') printer(line);
  },
});

/* ═══════════════ 请求层 ═══════════════ */

const COOKIES = (() => {
  if (!fs.existsSync(COOKIE_FILE)) {
    console.error(`\n${fail('缺少登录态')} 先运行：npm run setup\n`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
})();
const COOKIE_HEADER = COOKIES.map((c) => `${c.name}=${c.value}`).join('; ');

async function http(method, url, body, referer = REFERER) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method,
    headers: {
      cookie: COOKIE_HEADER,
      xtbz: 'ykt',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: ORIGIN,
      referer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text, ms: Date.now() - t0 };
}

const progressUrl = (vid) =>
  `${ORIGIN}/video-log/get_video_watch_progress/?cid=${course.courseId}&user_id=${course.lmsUserId}&classroom_id=${course.classroomId}&video_type=video&vtype=rate&video_id=${vid}&snapshot=1&no_loading=true`;

async function getProgress(vid) {
  const r = await http('GET', progressUrl(vid), null, videoPage(vid));
  const j = r.json;
  return j?.data?.[vid] || j?.[vid] || null;
}

function makeEvent(vid, cp, sq, ts) {
  return {
    i: 5, et: 'heartbeat', p: 'web', n: 'ali-cdn.xuetangx.com', lob: 'ykt',
    cp: +cp.toFixed(1), fp: 0, tp: 0, sp: 1, ts: String(ts),
    u: course.lmsUserId, uip: '', c: course.courseId, v: vid,
    skuid: course.skuId, classroomid: course.classroomId,
    cc: course.cc, d: 0, pg: `${vid}_13bxa`, sq, t: 'video', cards_id: 0, slide: 0, v_url: '',
  };
}

const postEvents = (vid, events) =>
  http('POST', `${ORIGIN}/video-log/heartbeat/`, { heart_data: events }, videoPage(vid));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const fmtSec = (s) => (s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}min`);

/* ═══════════════ 头部 ═══════════════ */

console.log('');
console.log(color.bold(`雨课堂刷课  ·  ${course.name}`));
console.log(
  color.gray(
    `  classroom ${course.classroomId}  course ${course.courseId}  sku ${course.skuId}  ${
      OPT.dry ? '演练模式（不发请求）' : '正式执行'
    }`,
  ),
);
console.log('');

log.phase('init');
log.node('course', {
  name: course.name, classroomId: course.classroomId, courseId: course.courseId,
  skuId: course.skuId, lmsUserId: course.lmsUserId, sign: course.sign,
});
log.node('options', OPT);
log.node('logs', log.files);

/* ═══════════════ auth ═══════════════ */

log.phase('auth');
const authRes = await http('GET', `${ORIGIN}/api/v3/user/basic-info`);
if (authRes.json?.code !== 0) {
  console.log(fail('登录态已失效，重新运行 npm run setup'));
  log.error('auth failed', { status: authRes.status, code: authRes.json?.code });
  await log.flush();
  process.exit(2);
}
const ME = authRes.json.data;
log.ok('auth ok', { uid: ME.id, name: ME.name, school: ME.school });

/* ═══════════════ tree ═══════════════ */

log.phase('tree');
const leafFile = [
  path.join(OUT, `leaves-${course.classroomId}.json`),
  path.join(OUT, 'leaves.json'),
].find((f) => fs.existsSync(f));

if (!leafFile) {
  console.log(fail('缺少章节树缓存，重新运行 npm run setup'));
  log.error('leaf cache missing');
  await log.flush();
  process.exit(3);
}

const leaves = JSON.parse(fs.readFileSync(leafFile, 'utf8'));
const videoLeaves = leaves.filter((l) => l.leaf_type === 0);
log.ok('tree loaded', { file: path.basename(leafFile), total: leaves.length, videos: videoLeaves.length });

/* ═══════════════ plan ═══════════════ */

log.phase('plan');
let todo = videoLeaves.filter((l) => l.is_locked !== true);
if (OPT.only.length) todo = todo.filter((l) => OPT.only.includes(l.leaf_id));
if (!todo.length) {
  console.log(warn('没有待处理节点'));
  await log.flush();
  process.exit(0);
}
log.ok('plan ready', { count: todo.length });

/* ═══════════════ run ═══════════════ */

log.phase('run');

const ui = createProgress({ total: todo.length });
printer = (line) => ui.log(line);

const stat = { ok: 0, ok2: 0, skip: 0, fail: 0, dry: 0, err: 0, posted: 0, events: 0 };
const detail = [];

async function probeDuration(vid) {
  const t = Date.now();
  const r = await postEvents(vid, [makeEvent(vid, 0.5, 1, t + OPT.tsStep), makeEvent(vid, 1.0, 2, t + OPT.tsStep * 2)]);
  log.debug('probe posted', { vid, status: r.status });
  await sleep(1500);
  const p = await getProgress(vid);
  return { dur: p?.video_length || 0, p };
}

async function brushOne(leaf) {
  const vid = leaf.leaf_id;
  const t0 = Date.now();
  log.node('lesson:begin', { vid, name: leaf.name, section: leaf.section });

  const p0 = await getProgress(vid);
  log.node('lesson:state', { vid, completed: p0?.completed, rate: p0?.rate, watch: p0?.watch_length, dur: p0?.video_length });

  if (p0?.completed === 1 && !OPT.force) {
    log.ok('lesson:skip', { vid, rate: p0.rate });
    return { result: 'skip', meta: `已学完 ${fmtDur(p0.video_length)}` };
  }

  let dur = p0?.video_length || 0;
  if (!dur) {
    if (OPT.dry) {
      log.warn('lesson:dry no-duration', { vid });
      return { result: 'dry', meta: '缺时长（演练不探测）' };
    }
    const pr = await probeDuration(vid);
    dur = pr.dur;
    log.node('lesson:probe', { vid, dur });
    if (!dur) {
      log.error('lesson:fail', { vid, why: 'no-duration' });
      return { result: 'fail', meta: '拿不到时长' };
    }
  }

  const need = Math.min(OPT.maxEvents, Math.ceil(dur / OPT.step) + OPT.margin);
  const start = Date.now();
  const events = [];
  for (let k = 1; k <= need; k++) {
    events.push(makeEvent(vid, Math.min(k * OPT.step, dur - 0.5), 200 + k, start + k * OPT.tsStep));
  }

  if (OPT.dry) {
    log.ok('lesson:dry', { vid, dur, events: need });
    return { result: 'dry', meta: `${fmtDur(dur)} · 计划 ${need} 条` };
  }

  const r = await postEvents(vid, events);
  stat.posted++;
  stat.events += events.length;
  log.node('lesson:post', { vid, events: need, status: r.status, ms: r.ms });

  await sleep(2000);
  const p1 = await getProgress(vid);
  log.node('lesson:verify', { vid, watch: p1?.watch_length, dur: p1?.video_length, rate: p1?.rate, completed: p1?.completed });

  if (p1?.completed === 1) {
    log.ok('lesson:done', { vid, dur, rate: p1.rate, elapsed: Date.now() - t0 });
    return { result: 'ok', meta: `${fmtDur(dur)} · ${need} 条` };
  }

  log.warn('lesson:retry', { vid, rate: p1?.rate });
  const t2 = Date.now();
  const again = [];
  for (let k = 1; k <= OPT.retryRound; k++) {
    again.push(makeEvent(vid, Math.min(dur - 0.3, k * 3), 600 + k, t2 + k * OPT.tsStep));
  }
  await postEvents(vid, again);
  stat.posted++;
  stat.events += again.length;
  await sleep(2000);
  const p2 = await getProgress(vid);
  log.node('lesson:verify2', { vid, watch: p2?.watch_length, rate: p2?.rate, completed: p2?.completed });

  if (p2?.completed === 1) {
    log.ok('lesson:done', { vid, dur, rate: p2.rate, retried: true, elapsed: Date.now() - t0 });
    return { result: 'ok2', meta: `补发达标 · ${fmtDur(dur)}` };
  }
  log.error('lesson:fail', { vid, watch: p2?.watch_length, rate: p2?.rate });
  return { result: 'fail', meta: justify(p2?.watch_length, p2?.video_length) };
}

function justify(watch, total) {
  if (!total) return '未完成';
  return `未完成 ${Math.round(((watch || 0) / total) * 100)}%`;
}

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log(warn('\n收到中断，写完当前节点后停止…'));
});

const tAll = Date.now();

for (let i = 0; i < todo.length; i++) {
  if (interrupted) break;
  const leaf = todo[i];
  const label = truncate(`${leaf.leaf_id} ${leaf.name}`, 46);
  ui.update({ index: i + 1, name: label, extra: color.gray('执行中…') });

  let res;
  try {
    res = await brushOne(leaf);
  } catch (e) {
    stat.err++;
    log.error('lesson:exception', { vid: leaf.leaf_id, err: e.message });
    res = { result: 'fail', meta: e.message.slice(0, 40) };
  }

  const key = res.result === 'ok2' ? 'ok' : res.result;
  if (res.result === 'ok2') stat.ok2++;
  stat[key] = (stat[key] || 0) + 1;
  detail.push({ leaf: leaf.leaf_id, name: leaf.name, ...res });

  const badge =
    res.result === 'ok' || res.result === 'ok2'
      ? color.green('✓ 完成')
      : res.result === 'skip'
        ? color.gray('· 跳过')
        : res.result === 'dry'
          ? color.cyan('· 演练')
          : color.red('✗ 失败');

  ui.update({ index: i + 1, name: label, extra: `${badge} ${color.gray(res.meta || '')}` });
  ui.log(
    `${color.gray(`[${String(i + 1).padStart(String(todo.length).length)}/${todo.length}]`)} ${badge}  ${truncate(
      leaf.name,
      38,
    )} ${color.gray(res.meta || '')}`,
  );

  await sleep(OPT.sleepMs);
}

ui.finish('');

/* ═══════════════ verify ═══════════════ */

if (!OPT.noVerify && !OPT.dry) {
  log.phase('verify');
  const vp = createProgress({ total: videoLeaves.length });
  let done = 0, partial = 0, none = 0, totalSec = 0;
  const bad = [];

  for (let i = 0; i < videoLeaves.length; i++) {
    const l = videoLeaves[i];
    vp.update({ index: i + 1, name: truncate(l.name, 40), extra: color.gray('复核中…') });
    const p = await getProgress(l.leaf_id).catch(() => null);
    if (p?.completed === 1) {
      done++;
      totalSec += p.video_length || 0;
    } else if (p?.watch_length > 0) {
      partial++;
      bad.push({ vid: l.leaf_id, name: l.name, rate: p.rate });
    } else {
      none++;
      bad.push({ vid: l.leaf_id, name: l.name, rate: 0 });
    }
    await sleep(100);
  }
  vp.finish('');

  log.ok('verify:complete', { total: videoLeaves.length, done, partial, none, hours: +(totalSec / 3600).toFixed(2) });
  for (const b of bad) log.warn('verify:outstanding', b);

  const pct = ((done / videoLeaves.length) * 100).toFixed(1);
  console.log('');
  console.log(
    `${color.bold('复核')}  ${done}/${videoLeaves.length} 已完成 ${color.green(pct + '%')}  ${color.gray(
      `累计 ${(totalSec / 3600).toFixed(2)} 小时`,
    )}`,
  );
  if (bad.length) {
    console.log(warn(`${bad.length} 个节点未完成：`));
    for (const b of bad.slice(0, 15)) console.log(color.gray(`    ${b.vid}  ${b.name}  rate=${b.rate}`));
  }
}

/* ═══════════════ summary ═══════════════ */

log.phase('summary');
const totalMs = Date.now() - tAll;

console.log('');
console.log(color.bold('━━ 运行汇总 ━━'));
const rows = [
  ['课程', course.name],
  ['账号', `${ME.name} (${ME.id})`],
  ['处理节点', String(todo.length)],
  ['成功', color.green(String(stat.ok))],
  ['跳过', color.gray(String(stat.skip))],
  ['失败', stat.fail ? color.red(String(stat.fail)) : '0'],
  ['异常', stat.err ? color.red(String(stat.err)) : '0'],
  ['POST', String(stat.posted)],
  ['事件', String(stat.events)],
  ['耗时', fmtSec(totalMs / 1000)],
  ['日志', color.gray(path.relative(ROOT, log.files.log))],
];
const w = Math.max(...rows.map((r) => visualWidth(r[0])));
for (const [k, v] of rows) console.log(`  ${k}${' '.repeat(w - visualWidth(k))}  ${v}`);
console.log('');

fs.writeFileSync(
  path.join(OUT, `brush-${course.classroomId}-${Date.now()}.json`),
  JSON.stringify(
    { course: { classroomId: course.classroomId, courseId: course.courseId, name: course.name }, me: { id: ME.id, name: ME.name }, stat, detail, logs: log.files, endedAt: new Date().toISOString() },
    null,
    2,
  ),
);

await log.flush();
process.exit(stat.fail || stat.err ? 1 : 0);
