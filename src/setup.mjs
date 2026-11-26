#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { launchProjectBrowser } from './browser.mjs';
import { loginPrompt, useEgoLite } from './ego-browser.mjs';
import { CFG, COOKIE_FILE, OUT, loadConfig, parseCourseUrl, saveConfig } from './config.mjs';
import { color, ok, fail, info } from './ui.mjs';

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(prompt).finally(() => rl.close());
}

function fromListing(item, origin) {
  const classroomId = Number(item.classroom_id);
  if (!Number.isSafeInteger(classroomId) || classroomId <= 0) return null;
  const universityId = Number(item.course?.university_id) || null;
  const url = new URL(`/v2/web/studentLog/${classroomId}`, origin);
  if (universityId) url.searchParams.set('university_id', universityId);
  url.searchParams.set('platform_id', '3');
  url.searchParams.set('classroom_id', classroomId);
  return {
    classroomId, universityId, origin, url: url.href,
    name: item.course?.name || item.name || `课程 ${classroomId}`,
    className: item.name,
    courseId: item.course?.id,
    university: item.course?.university_name,
    term: item.term,
    role: item.role,
    teacher: item.teacher,
  };
}

async function getJSON(page, endpoint) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { xtbz: 'ykt' }, credentials: 'same-origin' });
    return response.ok ? response.json() : null;
  }, endpoint);
}

async function checkLogin(ctx, page, origin) {
  await page.goto(`${origin}/v2/web/index`, { waitUntil: 'domcontentloaded' });
  const who = async () => {
    const result = await getJSON(page, '/api/v3/user/basic-info').catch(() => null);
    return result?.code === 0 && result.data?.id ? result.data : null;
  };
  let account = await who();
  if (account) return account;

  if (useEgoLite) {
    await ctx.handOff();
    console.log(info(loginPrompt));
    await ask('按回车继续 > ');
    await ctx.resume();
  } else {
    console.log(info('请在浏览器登录，最多等待 15 分钟。'));
  }
  const deadline = Date.now() + (useEgoLite ? 15000 : 15 * 60 * 1000);
  while (Date.now() < deadline) {
    account = await who();
    if (account) return account;
    await page.waitForTimeout(1200);
  }
  throw new Error('还没有检测到雨课堂登录，请登录后再同步课程。');
}

const TYPE = { 0: '视频', 1: '图文', 2: '讨论', 3: '作业', 4: '考试' };

async function fetchChapter(page, course) {
  const { classroomId } = course;
  const basic = (await getJSON(page,
    `/c27/online_courseware/course/classroom/${classroomId}/get_basic_info/?classroom_id=${classroomId}`))?.data;
  const sign = basic?.course_sign || course.sign;
  const universityId = basic?.university_id || course.universityId;
  if (!sign) throw new Error('平台没有返回这门课的目录参数，请确认该课程仍可访问。');

  const query = new URLSearchParams({
    cid: classroomId, sign, term: 'latest', uv_id: universityId ?? '', classroom_id: classroomId,
  });
  const data = (await getJSON(page, '/mooc-api/v1/lms/learn/course/chapter?' + query))?.data;
  if (!Array.isArray(data?.course_chapter)) throw new Error('平台没有返回章节目录，已有目录已保留。');
  const courseId = data.course_id || basic?.course_id || course.courseId;
  if (!courseId) throw new Error('平台没有返回课程编号，已有目录已保留。');

  const leaves = data.course_chapter.flatMap((chapter) =>
    (chapter.section_leaf_list || []).flatMap((section) =>
      (section.leaf_list || []).map((leaf) => ({
        section: chapter.name || '',
        leaf_id: leaf.id,
        chapter_id: leaf.chapter_id,
        section_id: leaf.section_id,
        name: leaf.name,
        leaf_type: leaf.leaf_type,
        type_name: TYPE[leaf.leaf_type] ?? `type-${leaf.leaf_type}`,
        is_show: leaf.is_show,
        is_locked: leaf.is_locked,
      })),
    ),
  );
  const videos = leaves.filter((leaf) => leaf.leaf_type === 0);
  const representative = videos.find((leaf) => leaf.is_locked !== true) || leaves[0];
  const leafInfo = representative
    ? (await getJSON(page, `/mooc-api/v1/lms/learn/leaf_info/${classroomId}/${representative.leaf_id}/?classroom_id=${classroomId}`)
      .catch(() => null))?.data
    : null;
  const leafStats = {};
  for (const leaf of leaves) {
    leafStats[leaf.type_name] = (leafStats[leaf.type_name] || 0) + 1;
  }
  return {
    leaves,
    course: {
      ...course,
      name: basic?.course_name || data.course_name || course.name,
      courseId, sign, universityId,
      platformId: basic?.platform_id || course.platformId || 3,
      skuId: leafInfo?.sku_id || course.skuId || null,
      lmsUserId: leafInfo?.user_id || course.lmsUserId || null,
      videoCount: videos.length,
      leafCount: leaves.length,
      leafStats,
      leafTypes: Object.keys(leafStats),
      syncedAt: new Date().toISOString(),
    },
  };
}

async function run() {
  const urlIndex = process.argv.indexOf('--url');
  const courseIndex = process.argv.indexOf('--course');
  if (urlIndex >= 0 && courseIndex >= 0) throw new Error('请选择一种课程定位方式。');
  const parsed = urlIndex < 0 ? null : parseCourseUrl(process.argv[urlIndex + 1] || '');
  const ordinal = courseIndex < 0 ? null : (process.argv[courseIndex + 1] || '').normalize('NFKC');
  if (ordinal !== null && !/^[1-9]\d*$/.test(ordinal)) {
    throw new Error('--course 后请输入正整数，例如 --course 2。');
  }
  const origin = parsed?.origin || CFG.origin;
  const cfg = loadConfig();
  console.log(color.bold('\n雨课堂 · 扫描课程目录\n'));
  const ctx = await launchProjectBrowser();
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const account = await checkLogin(ctx, page, origin);
    if (cfg.account?.id && String(cfg.account.id) !== String(account.id)) {
      throw new Error('EgoLite 当前登录的账号与此数据目录的账号不同。请切回原账号再同步。');
    }
    const existing = new Map(cfg.courses.map((course) => [Number(course.classroomId), course]));
    let selected;
    if (parsed) {
      selected = { ...existing.get(parsed.classroomId), ...parsed, url: parsed.normalized };
    } else {
      const response = await getJSON(page, '/v2/api/web/courses/list?identity=2');
      if (response?.errcode !== 0 || !Array.isArray(response.data?.list)) {
        throw new Error('读取课程列表失败，已有课程已保留。');
      }
      const listed = new Map();
      for (const item of response.data.list) {
        const summary = fromListing(item, origin);
        if (!summary) continue;
        const old = existing.get(summary.classroomId);
        const defined = Object.fromEntries(Object.entries(summary).filter(([, value]) => value != null));
        listed.set(summary.classroomId, { ...old, ...defined });
      }
      if (!listed.size) throw new Error('这个账号的课表为空，已有课程已保留。');

      // Preserve the numbering in the saved list and append newly discovered courses.
      cfg.courses = [
        ...cfg.courses.map((item) => listed.get(Number(item.classroomId)) || item),
        ...[...listed.values()].filter((item) => !existing.has(item.classroomId)),
      ];
      const current = cfg.courses.find((item) => Number(item.classroomId) === Number(cfg.active));
      selected = ordinal === null ? current || cfg.courses[0] : cfg.courses[Number(ordinal) - 1];
      if (!selected) {
        throw new Error(`没有第 ${ordinal} 门课。当前共有 ${cfg.courses.length} 门，请在网页的课程下拉框里选择。`);
      }
      console.log(ok(`已扫描到 ${listed.size} 门课程，正在读取「${selected.name}」的章节目录。`));
    }

    const { course, leaves } = await fetchChapter(page, selected);
    const leafCache = path.join(OUT, `leaves-${course.classroomId}.json`);
    if (!leaves.length && selected.leafCount > 0 && fs.existsSync(leafCache)) {
      throw new Error('平台返回了空目录，已有章节缓存已保留。');
    }
    const cookies = await ctx.cookies(origin);
    const scoped = cookies.filter((cookie) => /(^|\.)yuketang\.cn$/.test(cookie.domain));
    if (!scoped.length) throw new Error('没有读取到可用的雨课堂登录态，已有配置已保留。');

    cfg.courses = cfg.courses.some(({ classroomId }) => Number(classroomId) === course.classroomId)
      ? cfg.courses.map((item) => Number(item.classroomId) === course.classroomId ? course : item)
      : [...cfg.courses, course];
    cfg.active = course.classroomId;
    cfg.channel = useEgoLite ? 'ego' : CFG.channel;
    cfg.account = { ...cfg.account, id: account.id, name: account.name, school: account.school, at: new Date().toISOString() };

    fs.writeFileSync(leafCache, JSON.stringify(leaves, null, 2));
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(scoped, null, 2), { mode: 0o600 });
    fs.chmodSync(COOKIE_FILE, 0o600);
    saveConfig(cfg);
    console.log(ok(`「${course.name}」已设为当前课程，共 ${leaves.length} 个节点，其中 ${course.videoCount} 个视频。`));
  } finally {
    await ctx.close().catch(() => {});
  }
}

try {
  await run();
} catch (error) {
  console.error(fail(error.message));
  process.exitCode = 1;
}
