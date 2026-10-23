#!/usr/bin/env node
/**
 * 全量复核：npm run verify
 *   npm run verify -- --course 2
 * 只看完成率，不做任何上报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { OUT, COOKIE_FILE, CFG, resolveCourse } from './config.mjs';
import { createProgress, color, ok, fail, warn, truncate } from './ui.mjs';

const argv = process.argv.slice(2);
const val = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : null;
};

let course;
try {
  course = resolveCourse({ course: val('course') });
} catch (e) {
  console.error(`\n${fail(e.message)}\n`);
  process.exit(2);
}

if (!fs.existsSync(COOKIE_FILE)) {
  console.error(fail('缺少登录态，先运行 npm run setup'));
  process.exit(2);
}
const COOKIE = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

const ORIGIN = course.origin || CFG.origin;
const H = {
  cookie: COOKIE,
  xtbz: 'ykt',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  accept: 'application/json, text/plain, */*',
  referer: `${ORIGIN}/v2/web/studentLog/${course.classroomId}`,
};

const leafFile = [
  path.join(OUT, `leaves-${course.classroomId}.json`),
  path.join(OUT, 'leaves.json'),
].find((f) => fs.existsSync(f));
if (!leafFile) {
  console.error(fail('缺少章节树，先运行 npm run setup'));
  process.exit(2);
}

const videos = JSON.parse(fs.readFileSync(leafFile, 'utf8')).filter((l) => l.leaf_type === 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prog(vid) {
  const url = `${ORIGIN}/video-log/get_video_watch_progress/?cid=${course.courseId}&user_id=${course.lmsUserId}&classroom_id=${course.classroomId}&video_type=video&vtype=rate&video_id=${vid}&snapshot=1&no_loading=true`;
  const r = await fetch(url, { headers: H });
  const j = await r.json().catch(() => null);
  return j?.data?.[vid] || j?.[vid] || null;
}

console.log('');
console.log(color.bold(`复核  ·  ${course.name}`));
console.log(color.gray(`  视频节点 ${videos.length} 个\n`));

const bar = createProgress({ total: videos.length });
let done = 0, partial = 0, none = 0, totalSec = 0;
const bad = [];

for (let i = 0; i < videos.length; i++) {
  const l = videos[i];
  bar.update({ index: i + 1, name: truncate(l.name, 42), extra: color.gray('查询中…') });
  const p = await prog(l.leaf_id).catch(() => null);
  if (p?.completed === 1) {
    done++;
    totalSec += p.video_length || 0;
  } else if (p?.watch_length > 0) {
    partial++;
    bad.push({ vid: l.leaf_id, name: l.name, rate: p.rate, watch: p.watch_length, len: p.video_length });
  } else {
    none++;
    bad.push({ vid: l.leaf_id, name: l.name, rate: 0 });
  }
  await sleep(100);
}
bar.finish('');

const pct = ((done / videos.length) * 100).toFixed(1);
console.log('');
console.log(`${color.bold('已完成')}  ${done}/${videos.length}  ${color.green(pct + '%')}   ${color.gray(`累计 ${(totalSec / 3600).toFixed(2)} 小时`)}`);
if (partial) console.log(`${warn('部分完成')}  ${partial} 个`);
if (none) console.log(`${warn('未开始')}    ${none} 个`);

if (!bad.length) {
  console.log(`\n${ok('全部完成')}`);
  process.exit(0);
}

console.log(`\n${warn(`未完成 ${bad.length} 个：`)}`);
for (const b of bad.slice(0, 30)) {
  const detail = b.len ? ` ${Math.round((b.watch / b.len) * 100)}%` : '';
  console.log(color.gray(`   ${b.vid}  ${b.name}${detail}`));
}
console.log(color.gray('\n补跑：npm run brush -- --only <id1>,<id2>'));
process.exit(1);
