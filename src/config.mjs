import path from 'node:path';
import fs from 'node:fs';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const OUT = path.join(ROOT, 'out');
export const LOGDIR = path.join(OUT, 'logs');
export const CONFIG_FILE = path.join(ROOT, 'config.local.json');
export const COOKIE_FILE = path.join(OUT, 'cookies.json');

fs.mkdirSync(LOGDIR, { recursive: true });

export const CFG = {
  origin: process.env.SITE_ORIGIN || 'https://www.yuketang.cn',

  // 持久化登录态目录
  userDataDir: process.env.PROFILE_DIR || path.join(ROOT, '.profile'),

  // 真实浏览器通道：msedge / chrome
  channel: process.env.BROWSER_CHANNEL || 'msedge',
  headless: process.env.HEADLESS === '1',

  // 倍速（UI 路线用）
  rate: Number(process.env.RATE || 1.5),
  maxHours: Number(process.env.MAX_HOURS || 8),

  pollMs: 2500,
  stallSec: 45,
  stallSeekBack: 2,

  quizSelectors: [
    '.el-dialog__wrapper',
    '.el-message-box',
    '[class*="question-modal"]',
    '[class*="quiz"]',
    '[class*="exercise"]',
    '[class*="anti-cheat"]',
    '[class*="antiCheat"]',
    '[class*="exam-modal"]',
  ],

  answersFile: path.join(ROOT, 'answers.json'),
  pauseOnQuiz: process.env.PAUSE_ON_QUIZ !== '0',
  webhook: process.env.WEBHOOK || '',
};

/* ═════════ 本地配置（不入库） ═════════ */

const EMPTY = { version: 1, profileDir: '.profile', channel: 'msedge', courses: [] };

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...EMPTY };
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...EMPTY, ...c, courses: Array.isArray(c.courses) ? c.courses : [] };
  } catch (e) {
    throw new Error(`config.local.json 解析失败：${e.message}`);
  }
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return CONFIG_FILE;
}

export function hasConfig() {
  const c = loadConfig();
  return c.courses.some((x) => x.courseId && x.cc && x.lmsUserId);
}

/* ═════════ 课程 URL 解析 ═════════ */

/**
 * 支持两种形态：
 *   https://www.yuketang.cn/v2/web/studentLog/10000001?university_id=2910&platform_id=3&classroom_id=10000001
 *   https://changjiang.yuketang.cn/v2/web/studentLog/10000001?...
 */
export function parseCourseUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('URL 格式不对，应形如 https://www.yuketang.cn/v2/web/studentLog/<classroom_id>?university_id=<id>&platform_id=3');
  }
  const m = u.pathname.match(/\/studentLog\/(\d+)/) || u.pathname.match(/\/(\d{5,})/);
  const q = u.searchParams;
  const classroomId = Number(q.get('classroom_id') || m?.[1] || 0);
  if (!classroomId) throw new Error('URL 里找不到 classroom_id');
  return {
    origin: u.origin,
    classroomId,
    universityId: Number(q.get('university_id') || 0) || null,
    platformId: Number(q.get('platform_id') || 3) || 3,
    normalized: `${u.origin}/v2/web/studentLog/${classroomId}${q.toString() ? '?' + q.toString() : ''}`,
  };
}

/* ═════════ 课程定位 ═════════ */

/**
 * 解析出一次运行要用的课程参数。
 * 优先级：--course <url|序号> > 环境变量 COURSE_URL > 配置里第一门课
 */
export function resolveCourse({ course, url } = {}) {
  const cfg = loadConfig();
  const list = cfg.courses || [];

  const need = ['courseId', 'skuId', 'sign', 'lmsUserId', 'cc', 'classroomId'];

  if (url || (course && /^https?:/i.test(course))) {
    const target = url || course;
    const parsed = parseCourseUrl(target);
    const hit = list.find((c) => c.classroomId === parsed.classroomId);
    if (!hit) {
      throw new Error(
        `这个课程还没初始化：classroom_id=${parsed.classroomId}\n  先运行：npm run setup -- --url "${target}"`,
      );
    }
    return hit;
  }

  if (course && /^\d+$/.test(course)) {
    const i = Number(course) - 1;
    if (!list[i]) throw new Error(`没有第 ${course} 门课，配置里共 ${list.length} 门`);
    return list[i];
  }

  const envUrl = process.env.COURSE_URL;
  if (envUrl) {
    const parsed = parseCourseUrl(envUrl);
    const hit = list.find((c) => c.classroomId === parsed.classroomId);
    if (hit) return hit;
  }

  if (!list.length) {
    throw new Error('还没有配置任何课程。先运行：npm run setup');
  }
  const first = list[0];
  const miss = need.filter((k) => !first[k]);
  if (miss.length) {
    throw new Error(`课程配置不完整（缺 ${miss.join(', ')}）。重新运行：npm run setup -- --url "${first.url}"`);
  }
  return first;
}

export function loadAnswers() {
  try {
    return JSON.parse(fs.readFileSync(CFG.answersFile, 'utf8'));
  } catch {
    return {};
  }
}

export function log(...a) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}]`, ...a);
}
