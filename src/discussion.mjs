#!/usr/bin/env node
/**
 * 讨论区发言
 *
 *   npm run discuss -- --list        列出 10 个讨论单元的主题与发言状态
 *   npm run discuss -- --fill        按 out/discussions.json 逐个发言
 *
 * 接口（抓包得到）：
 *   GET  /v/discussion/v2/unit/discussion/?classroom_id&leaf_id&topic_type=4&channel=xt&sku_id
 *   POST /v/discussion/v2/comment/
 *        { to_user, topic_id, content: { text, upload_images: [], accessory_list: [] } }
 *
 * 注意 content 必须是对象，传字符串会 400 APIException。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, OUT, CFG, resolveCourse, COOKIE_FILE } from './config.mjs';
import { color, ok, fail, warn, info } from './ui.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OPT = { list: flag('list'), fill: flag('fill'), course: val('course'), max: Number(val('max', 50)) };
const PLAN_FILE = path.join(OUT, 'discussions.json');

let course;
try {
  course = resolveCourse({ course: OPT.course });
} catch (e) {
  console.error(`\n${fail(e.message)}\n`);
  process.exit(2);
}
const ORIGIN = course.origin || CFG.origin;
const ROOM = course.classroomId;
const SKU = course.skuId;

if (!fs.existsSync(COOKIE_FILE)) {
  console.error(fail('缺少登录态，先运行 npm run setup'));
  process.exit(2);
}
const COOKIES = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
const CSRF = COOKIES.find((c) => c.name === 'csrftoken')?.value || '';
const H = {
  cookie: COOKIES.map((c) => `${c.name}=${c.value}`).join('; '),
  xtbz: 'ykt',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  accept: 'application/json, text/plain, */*',
  referer: `${ORIGIN}/v2/web/studentLog/${ROOM}`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───── 讨论节点 ───── */

function discussionLeaves() {
  const f = path.join(OUT, `leaves-${ROOM}.json`);
  if (!fs.existsSync(f)) throw new Error('缺少章节树缓存，先运行 npm run setup');
  return JSON.parse(fs.readFileSync(f, 'utf8')).filter((l) => l.leaf_type === 4);
}

async function unitInfo(leaf) {
  const url = `${ORIGIN}/v/discussion/v2/unit/discussion/?classroom_id=${ROOM}&leaf_id=${leaf}&topic_type=4&channel=xt&sku_id=${SKU}`;
  const j = await (await fetch(url, { headers: H })).json().catch(() => null);
  const d = j?.data;
  if (!d) return null;
  const text = String(d.content?.text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    leaf: Number(leaf),
    topicId: d.id ?? d.topic_id ?? d.chapter_id ?? null,
    toUser: d.user_id ?? null,
    title: text.slice(0, 120),
    commented: d.commented ?? 0,
    mine: Number(d.user_comment_num || 0) > 0,
  };
}

async function myStatus(leaf) {
  const url = `${ORIGIN}/v/discussion/v2/student/comment/status/?leaf_id=${leaf}&classroom_id=${ROOM}&_t=${Date.now()}`;
  const j = await (await fetch(url, { headers: H })).json().catch(() => null);
  return Boolean(j?.data);
}

/* ───── 发帖 ───── */

async function postComment(topicId, toUser, text) {
  const body = {
    to_user: toUser,
    topic_id: topicId,
    content: { text, upload_images: [], accessory_list: [] },
  };
  const r = await fetch(`${ORIGIN}/v/discussion/v2/comment/`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json', 'x-csrftoken': CSRF, origin: ORIGIN },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { status: r.status, ok: j?.code === 0, msg: j?.msg || t.slice(0, 120) };
}

/* ───── 主流程 ───── */

console.log('');
console.log(color.bold('讨论区') + color.gray(`  ·  ${course.name}`));
console.log('');

const leaves = discussionLeaves();
if (!leaves.length) {
  console.log(warn('没有找到讨论单元'));
  process.exit(0);
}

const plan = [];
// 保留上一次写好的 text，避免 --fill 时把自己刚填的内容冲掉
const prev = fs.existsSync(PLAN_FILE) ? JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')) : [];
const prevText = new Map(prev.map((p) => [Number(p.leaf), p.text]).filter(([, t]) => t));

for (const l of leaves) {
  const info = await unitInfo(l.leaf_id);
  const done = info ? await myStatus(l.leaf_id) : false;
  plan.push({ ...info, section: l.section || '', done, text: prevText.get(Number(l.leaf_id)) || '' });
  if (info) {
    console.log(
      `${done ? color.green('✓') : color.gray('·')} ${color.gray(String(l.leaf_id))} ${String(l.section || '').slice(0, 12).padEnd(14)} ${color.gray(`topic=${info.topicId}`)} 已有 ${info.commented} 条`,
    );
    console.log(color.gray(`    ${info.title.slice(0, 90)}`));
  } else {
    console.log(`${color.yellow('?')} ${l.leaf_id} 读取失败`);
  }
  await sleep(600);
}

fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), 'utf8');
console.log('');
console.log(ok(`已写入 ${path.relative(ROOT, PLAN_FILE)}（${plan.filter((p) => !p.done).length} 个待发言）`));

if (!OPT.fill) {
  console.log(color.gray('往文件里每个作业加一个 "text" 字段（≤50 字），再加 --fill 发送'));
  process.exit(0);
}

/* ───── 发送 ───── */

const todo = plan.filter((p) => !p.done && p.text);
if (!todo.length) {
  console.log(warn('没有可发送的内容：要么都已发言，要么文件里没有 text 字段'));
  process.exit(0);
}

console.log('');
let okN = 0;
for (const p of todo) {
  const text = String(p.text).trim();
  const len = [...text].length;
  if (len > OPT.max) {
    console.log(`${color.yellow('!')} ${p.leaf} 超过 ${OPT.max} 字（${len}），跳过`);
    continue;
  }
  const r = await postComment(p.topicId, p.toUser, text);
  if (r.ok) {
    okN++;
    console.log(`${color.green('✓')} ${p.leaf} 已发言（${len} 字）`);
  } else {
    console.log(`${color.red('✗')} ${p.leaf} ${r.status} ${r.msg}`);
  }
  p.done = r.ok;
  await sleep(2500 + Math.floor(Math.random() * 1500));
}

fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2), 'utf8');
console.log('');
console.log(ok(`完成：${okN}/${todo.length}`));
process.exit(0);
