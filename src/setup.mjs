#!/usr/bin/env node
/**
 * 首次使用引导：登录 → 输入课程 URL → 自动发现参数 → 落盘配置
 *
 *   npm run setup
 *   npm run setup -- --url "https://www.yuketang.cn/v2/web/studentLog/10000001?university_id=2910&platform_id=3"
 *
 * 会自动发现：
 *   classroomId / universityId / platformId  ← URL
 *   sign / courseId                          ← 课程接口
 *   skuId / lmsUserId                        ← leaf_info
 *   cc（设备指纹）                            ← 播放页心跳
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import {
  ROOT, OUT, COOKIE_FILE, CONFIG_FILE,
  CFG, loadConfig, saveConfig, parseCourseUrl,
} from './config.mjs';
import { color, ok, fail, warn, info, step } from './ui.mjs';

const argv = process.argv.slice(2);
const argUrl = (() => {
  const i = argv.indexOf('--url');
  return i >= 0 ? argv[i + 1] : null;
})();

const TOTAL = 5;
const say = (s) => console.log(s);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(q).finally(() => rl.close());
}

/* ═════════ 启动浏览器 ═════════ */

say(color.bold('\n雨课堂刷课器 · 初始化向导\n'));

let targetUrl = argUrl;
if (!targetUrl) {
  say(info('在浏览器里打开你要刷的课程页面，地址栏整条复制过来'));
  say(color.gray('  形如 https://www.yuketang.cn/v2/web/studentLog/10000001?university_id=2910&platform_id=3\n'));
  targetUrl = (await ask('课程 URL > ')).trim();
}
if (!targetUrl) {
  say(fail('没有输入 URL，退出'));
  process.exit(1);
}

let parsed;
try {
  parsed = parseCourseUrl(targetUrl);
} catch (e) {
  say(fail(e.message));
  process.exit(1);
}
say(ok(`classroom_id = ${parsed.classroomId}  university_id = ${parsed.universityId || '?'}  platform_id = ${parsed.platformId}`));

say('\n' + step(1, TOTAL, '启动浏览器'));
const ctx = await chromium.launchPersistentContext(CFG.userDataDir, {
  channel: CFG.channel,
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--autoplay-policy=no-user-gesture-required'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = ctx.pages()[0] || (await ctx.newPage());
say(ok('浏览器已启动（窗口标题带「个人」的那个）'));

/* ═════════ 登录 ═════════ */

async function isLoggedIn() {
  const r = await page
    .evaluate(async () => {
      try {
        const res = await fetch('/api/v3/user/basic-info', { credentials: 'include' });
        const j = await res.json();
        return { code: j.code, uid: j.data?.id || null, name: j.data?.name || '' };
      } catch {
        return { code: -1 };
      }
    })
    .catch(() => ({ code: -1 }));
  return r;
}

say('\n' + step(2, TOTAL, '检查登录态'));
await page.goto(parsed.normalized, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(5000);

let me = await isLoggedIn();
if (me.code === 0 && me.uid) {
  say(ok(`已登录：${me.name} (${me.uid})`));
} else {
  say(warn('未登录。请在弹出的浏览器窗口里扫码或输入账号密码。'));
  say(color.gray('  微信扫码 / 雨课堂 App 扫码 / 学号密码，任选一种。首次使用需先关注服务号。\n'));
  const deadline = Date.now() + 15 * 60 * 1000;
  let tick = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    me = await isLoggedIn();
    if (me.code === 0 && me.uid) break;
    if (++tick % 15 === 0) process.stdout.write(color.gray('.'));
  }
  process.stdout.write('\n');
  if (me.code !== 0 || !me.uid) {
    say(fail('15 分钟内未检测到登录，退出'));
    await ctx.close();
    process.exit(2);
  }
  say(ok(`登录成功：${me.name} (${me.uid})`));
}

/* ═════════ 发现参数 ═════════ */

say('\n' + step(3, TOTAL, '读取课程结构'));

const found = { sign: null, cid: null, uv: parsed.universityId, skuId: null, lmsUserId: null, cc: null, courseName: null, chapters: 0 };

// 3.1 从页面请求里截 sign（最准）
// 注意：chapter 请求参数里的 cid 其实是 classroom_id，真正的 course_id 在响应体里
page.on('request', (r) => {
  const u = r.url();
  if (!u.includes('/lms/learn/course/chapter')) return;
  try {
    const q = new URL(u).searchParams;
    found.sign = q.get('sign') || found.sign;
    found.uv = Number(q.get('uv_id')) || found.uv;
  } catch {}
});

await page.goto(parsed.normalized, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(12000);

// 3.2 兜底：课程基础信息里带 course_sign / course_id
if (!found.sign || !found.cid) {
  try {
    const r = await page.evaluate(async (room) => {
      const res = await fetch(`/c27/online_courseware/course/classroom/${room}/get_basic_info/?classroom_id=${room}`, {
        credentials: 'include',
        headers: { xtbz: 'ykt' },
      });
      return await res.json();
    }, parsed.classroomId);
    const d = r?.data || {};
    found.sign = found.sign || d.course_sign;
    found.cid = found.cid || d.course_id;
    found.courseName = d.course_name || d.name;
  } catch {}
}

if (!found.sign) {
  say(fail('拿不到 sign，页面结构可能变了'));
  await ctx.close();
  process.exit(3);
}

// 3.3 拉章节树（注意：这个接口的 cid 参数实际要传 classroom_id）
const chapter = await page
  .evaluate(
    async ({ cid, sign, uv, room }) => {
      const res = await fetch(
        `/mooc-api/v1/lms/learn/course/chapter?cid=${cid}&sign=${sign}&term=latest&uv_id=${uv}&classroom_id=${room}`,
        { credentials: 'include', headers: { xtbz: 'ykt' } },
      );
      return await res.json();
    },
    { cid: parsed.classroomId, sign: found.sign, uv: found.uv, room: parsed.classroomId },
  )
  .catch(() => null);

const TYPE = { 0: '视频', 1: '图文', 2: '讨论', 3: '作业', 4: '考试' };
const leaves = [];
for (const sec of chapter?.data?.course_chapter || []) {
  for (const s of sec.section_leaf_list || []) {
    for (const l of s.leaf_list || []) {
      leaves.push({
        section: sec.name || '',
        leaf_id: l.id,
        chapter_id: l.chapter_id,
        section_id: l.section_id,
        name: l.name,
        leaf_type: l.leaf_type,
        type_name: TYPE[l.leaf_type] ?? `type-${l.leaf_type}`,
        is_show: l.is_show,
        is_locked: l.is_locked,
      });
    }
  }
}
found.courseName = found.courseName || chapter?.data?.course_name || '';
found.chapters = leaves.length;

// course_id 的权威来源：章节接口响应体（不是请求参数）
if (chapter?.data?.course_id) found.cid = chapter.data.course_id;

if (!found.cid) {
  say(fail('拿不到 course_id'));
  await ctx.close();
  process.exit(3);
}
say(ok(`sign = ${found.sign}   course_id = ${found.cid}   uv_id = ${found.uv}`));

const videos = leaves.filter((l) => l.leaf_type === 0);
if (!videos.length) {
  say(fail('这门课里没有视频节点'));
  await ctx.close();
  process.exit(4);
}
say(ok(`课程「${found.courseName}」共 ${leaves.length} 个节点，其中视频 ${videos.length} 个`));

fs.mkdirSync(OUT, { recursive: true });
const leafCache = path.join(OUT, `leaves-${parsed.classroomId}.json`);
fs.writeFileSync(leafCache, JSON.stringify(leaves, null, 2));
say(color.gray(`  章节树缓存 → ${path.relative(ROOT, leafCache)}`));

// 3.4 leaf_info 拿 sku_id / lms user_id
const firstVideo = videos[0];
const info1 = await page
  .evaluate(
    async ({ room, vid }) => {
      const res = await fetch(`/mooc-api/v1/lms/learn/leaf_info/${room}/${vid}/?classroom_id=${room}`, {
        credentials: 'include',
        headers: { xtbz: 'ykt' },
      });
      return await res.json();
    },
    { room: parsed.classroomId, vid: firstVideo.leaf_id },
  )
  .catch(() => null);
found.skuId = info1?.data?.sku_id || null;
found.lmsUserId = info1?.data?.user_id || null;

/* ═════════ 抓设备指纹 cc ═════════ */

say('\n' + step(4, TOTAL, '抓取设备指纹（打开一节视频，让它播放 10 秒）'));

const hb = [];
const onReq = (r) => {
  if (!r.url().includes('/video-log/heartbeat/')) return;
  const body = r.postData();
  if (!body) return;
  try {
    const j = JSON.parse(body);
    for (const e of j.heart_data || []) {
      if (e?.cc) hb.push({ cc: e.cc, u: e.u, v: e.v });
    }
  } catch {}
};
page.on('request', onReq);

const playUrl = `${parsed.origin}/ai-workspace/lms-graph/${parsed.classroomId}/video/${firstVideo.leaf_id}?is_chapter=1`;
const playPage = await ctx.newPage();
playPage.on('request', onReq);
await playPage.goto(playUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await playPage.waitForTimeout(8000);

await playPage
  .evaluate(async () => {
    for (const v of document.querySelectorAll('video')) {
      v.muted = true;
      try {
        await v.play();
      } catch {}
    }
  })
  .catch(() => {});

const ccDeadline = Date.now() + 30000;
while (Date.now() < ccDeadline && !hb.length) {
  await playPage.waitForTimeout(1500);
  await playPage
    .evaluate(async () => {
      for (const v of document.querySelectorAll('video')) {
        if (v.paused) {
          v.muted = true;
          try {
            await v.play();
          } catch {}
        }
      }
    })
    .catch(() => {});
}

if (hb.length) {
  found.cc = hb[0].cc;
  found.lmsUserId = found.lmsUserId || hb[0].u;
  say(ok(`cc = ${found.cc}`));
  say(ok(`lms user_id = ${found.lmsUserId}`));
} else {
  say(warn('没抓到心跳报文。可能是这节已学完不触发播放。'));
  say(color.gray('  可以先手动在窗口里点开任意一节视频播几秒，然后回到这里按回车。'));
  await playPage.close();
  await ask('按回车继续（或 Ctrl+C 退出）');
}
await playPage.close().catch(() => {});

if (!found.cc) {
  say(warn('cc 仍为空。可以手动填写：在浏览器 F12 → Network 里找 video-log/heartbeat/ 的请求体 heart_data[0].cc'));
  const manual = (await ask('cc（直接回车跳过）> ')).trim();
  if (manual) found.cc = manual;
}

/* ═════════ 落盘 ═════════ */

say('\n' + step(5, TOTAL, '保存配置'));

const cookies = await ctx.cookies();
fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies.filter((c) => /yuketang\.cn$/.test(c.domain.replace(/^\./, ''))), null, 2));

const cfg = loadConfig();
const entry = {
  name: found.courseName || `classroom-${parsed.classroomId}`,
  url: parsed.normalized,
  origin: parsed.origin,
  classroomId: parsed.classroomId,
  universityId: found.uv || parsed.universityId,
  platformId: parsed.platformId,
  courseId: found.cid,
  skuId: found.skuId,
  sign: found.sign,
  lmsUserId: found.lmsUserId,
  cc: found.cc,
  videoCount: videos.length,
  discoveredAt: new Date().toISOString(),
};

const idx = cfg.courses.findIndex((c) => Number(c.classroomId) === entry.classroomId);
const isNew = idx < 0;
cfg.courses = isNew ? [...cfg.courses, entry] : cfg.courses.map((c, i) => (i === idx ? { ...c, ...entry } : c));

// 关键：把刚配置的这门课设为「当前课程」，否则菜单和 brush 仍会用旧课程
cfg.active = entry.classroomId;
cfg.profileDir = path.relative(ROOT, CFG.userDataDir) || '.profile';
cfg.channel = CFG.channel;
saveConfig(cfg);

await ctx.close();

say('\n' + color.green('━━ 初始化完成 ━━'));
say(`  课程      ${entry.name}`);
say(`  节点      视频 ${entry.videoCount} 个 / 共 ${found.chapters} 个`);
say(`  状态      ${color.green('已设为当前课程')}`);
say(`  登录态    ${cookies.length} 条 cookie`);
say(`  配置      ${path.relative(ROOT, CONFIG_FILE)}`);
say(`  账号      ${me.name} (${me.uid})`);
say('');
say(color.bold('下一步：'));
say(`  npm run dry      ${color.gray('# 先看计划，不发请求')}`);
say(`  npm run brush    ${color.gray('# 正式执行')}`);
say('');
say(color.gray('  配置和登录态都在 .gitignore 里，不会被提交。'));
say('');
