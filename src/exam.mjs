#!/usr/bin/env node
/**
 * 作业/测验助手
 *
 *   npm run exam -- --list                          列出作业
 *   npm run exam -- --leaf 90000003                 导出题目
 *   npm run exam -- --leaf 90000003 --fill --dry    填涂但不提交
 *   npm run exam -- --leaf 90000003 --fill          填涂并自动提交
 *   npm run exam -- --leaf 90000003 --fill --manual 填涂后把窗口交给你点提交
 *   npm run exam -- --all --manual                  所有已有答案的作业，逐个做
 *
 * 为什么要有 --manual：直接点提交会触发 pointer 行为风控
 * （center-hit-ratio / click-directness 等），人工点一次最省事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchProjectBrowser } from './browser.mjs';
import { ROOT, OUT, CFG, resolveCourse, COOKIE_FILE } from './config.mjs';
import { createDecoder, needsDecoding } from './fontdec.mjs';
import { color, ok, fail, warn, info } from './ui.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OPT = {
  list: flag('list'),
  all: flag('all'),
  leaf: Number(val('leaf', 0)) || null,
  fill: flag('fill'),
  api: flag('api'),
  auto: flag('auto'),
  manual: flag('manual'),
  dry: flag('dry'),
  fast: flag('fast'),
  force: flag('force'),
  llmCheck: flag('llm-check'),
  delay: Number(val('delay', 0)) || 0,
  wait: Number(val('wait', 15)) || 15,
  course: val('course'),
};

/* ── LLM 连通性测试（不需要课程配置） ── */

if (OPT.llmCheck) {
  const { loadLLMConfig, checkLLM } = await import('./answer.mjs');
  const llm = loadLLMConfig(ROOT);
  console.log('');
  console.log(color.bold('AI 连通性测试'));
  console.log(color.gray(`  端点  ${llm.baseUrl}`));
  console.log(color.gray(`  模型  ${llm.model}`));
  console.log(color.gray(`  Key   ${llm.apiKey ? llm.apiKey.slice(0, 6) + '…' + llm.apiKey.slice(-4) : '(未设置)'}`));
  console.log('');
  if (!llm.apiKey) {
    console.log(fail('没有 API Key。运行 npm run llm 配置，或设置环境变量 LLM_API_KEY'));
    await new Promise((r) => setTimeout(r, 80));
    process.exit(2);
  }
  try {
    const r = await checkLLM(llm);
    console.log(ok(`连通正常，${r.ms}ms`));
    console.log(color.gray(`  模型回复：${r.reply}`));
    if (r.usage) console.log(color.gray(`  tokens：${r.usage.total_tokens ?? '-'}`));
  } catch (e) {
    console.log(fail(`连接失败：${e.message}`));
    await new Promise((r) => setTimeout(r, 80));
    process.exit(1);
  }
  console.log('');
  process.exit(0);
}

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
const COOKIE = COOKIES.map((c) => `${c.name}=${c.value}`).join('; ');

const H = {
  cookie: COOKIE,
  xtbz: 'ykt',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0',
  accept: 'application/json, text/plain, */*',
  referer: `${ORIGIN}/v2/web/studentLog/${ROOM}`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base = 0) => sleep(base + Math.floor(Math.random() * 400));
const ansFileOf = (leaf) => path.join(OUT, `answers-${leaf}.json`);

/* ═════════ 数据 ═════════ */

async function listAssignments() {
  const seen = new Map();
  for (let p = 0; p < 12; p++) {
    const r = await fetch(`${ORIGIN}/v2/api/web/logs/learn/${ROOM}?actype=-1&page=${p}&offset=20&sort=-1`, { headers: H });
    const j = await r.json().catch(() => null);
    const acts = j?.data?.activities || [];
    if (!acts.length) break;
    for (const a of acts) {
      const c = a.content || {};
      if (c.leaf_type_id && c.leaf_id) {
        seen.set(c.leaf_id, { leaf: c.leaf_id, aid: c.leaf_type_id, title: (a.title || '').trim() });
      }
    }
    if (!j.data.has_more) break;
  }
  return [...seen.values()];
}

async function fetchExercise(leafId) {
  const list = await listAssignments();
  const hit = list.find((x) => Number(x.leaf) === Number(leafId));
  if (!hit) throw new Error(`leaf ${leafId} 不在作业列表里`);
  const r = await fetch(
    `${ORIGIN}/mooc-api/v1/lms/exercise/get_exercise_list/${hit.aid}/${SKU}/?classroom_id=${ROOM}`,
    { headers: { ...H, referer: `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}` } },
  );
  const j = await r.json();
  if (!j?.data?.problems) throw new Error(`题目拉取失败：${j?.msg || '未知'}`);
  return { meta: hit, data: j.data };
}

/* ═════════ 导出 ═════════ */

function renderMarkdown(meta, data, dec) {
  const L = [];
  L.push(`# ${meta.title}`);
  L.push('');
  L.push(`- 题目数：**${data.problems.length}**`);
  L.push(`- 总分：**${data.problems.reduce((s, p) => s + (p.content.Score || 0), 0)}**`);
  L.push(`- leaf_id：\`${meta.leaf}\`   assignment_id：\`${meta.aid}\``);
  L.push('');
  L.push('> 题干由字形比对还原，个别形近字可能有误（如 卮/危、侪/济），结合上下文理解即可。');
  L.push('');
  L.push('---');
  L.push('');
  data.problems.forEach((p, i) => {
    const c = p.content;
    L.push(`## ${i + 1}. ${c.TypeText || c.Type}（${c.Score} 分）`);
    L.push('');
    L.push(dec.decodeHtml(c.Body));
    L.push('');
    for (const o of c.Options || []) {
      L.push(`- **${o.key}.** ${dec.decodeHtml(o.value || '').replace(/\n+/g, ' ')}`);
    }
    L.push('');
  });
  L.push('---');
  L.push('');
  L.push(`> 答案写进 \`answers-${meta.leaf}.json\`，然后：\`npm run exam -- --leaf ${meta.leaf} --fill --manual\``);
  return L.join('\n');
}

function answersTemplate(data) {
  const t = { _说明: '题号 -> 答案字母，多选连写如 ABD；留空表示跳过该题' };
  data.problems.forEach((_, i) => (t[String(i + 1)] = ''));
  return t;
}

/* ═════════ 浏览器 ═════════ */

async function waitFrame(page, re, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = page.frames().find((x) => re.test(x.url()));
    if (f) return f;
    await sleep(800);
  }
  throw new Error('等不到作业 iframe');
}

async function dismissResumeDialog(frame, page) {
  for (const scope of [frame, page]) {
    for (const t of ['先不用了', '继续作答', '暂不提交', '取消']) {
      const b = scope.locator(`button:visible:has-text("${t}")`).first();
      if (!(await b.count().catch(() => 0))) continue;
      if (!(await b.isVisible().catch(() => false))) continue;
      await b.click({ timeout: 3000 }).catch(() => {});
      await sleep(900);
      return true;
    }
  }
  return false;
}

async function waitNoOverlay(frame, page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let blocked = false;
    for (const scope of [frame, page]) {
      const m = scope.locator('.el-message-box__wrapper:visible, .el-dialog__wrapper:visible').first();
      if ((await m.count().catch(() => 0)) && (await m.isVisible().catch(() => false))) blocked = true;
    }
    if (!blocked) return true;
    await dismissResumeDialog(frame, page);
    await sleep(600);
  }
  return false;
}

/** 检测是否在上面的挑战（轨迹/验证码） */
async function hasChallenge(frame) {
  return frame
    .evaluate(() => /安全核验|请完成|按住|拖动|滑块|验证/.test(document.body.innerText || ''))
    .catch(() => false);
}

/** 有验证码就把窗口交给用户，等他过完再继续 */
async function waitChallengePassed(frame, page, waitMin) {
  if (!(await hasChallenge(frame))) return true;
  await page.bringToFront().catch(() => {});
  await showBanner(frame, '页面有安全核验 —— 请先手动完成，完成后自动继续');
  console.log('');
  console.log(color.bold(color.yellow('━━ 需要你过一下安全核验 ━━')));
  console.log('   按提示拖拽（按住起点 → 依次经过 1、2、3 → 终点松开）。');
  console.log(color.gray(`   最多等 ${waitMin} 分钟。`));
  console.log('');
  const deadline = Date.now() + waitMin * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2500);
    if (!(await hasChallenge(frame))) {
      console.log(ok('核验已通过，继续填涂'));
      await sleep(1000);
      return true;
    }
  }
  console.log(warn('等待超时，核验仍未通过'));
  return false;
}

/**
 * 模拟人类指针点击。
 * 直接 locator.click() 会瞬移 + 正中元素中心，命中 anti-cheat 的
 * pointer.move-per-down / trajectory-points / center-hit-ratio / click-directness。
 * 这里改用：贝塞尔轨迹 + 落点偏移 + 按下期间微抖 + 随机节奏。
 */
async function humanClick(page, locator) {
  const rnd = (a, b) => a + Math.random() * (b - a);

  await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width < 1 || box.height < 1) {
    await locator.click({ timeout: 5000 }).catch(() => {});
    return false;
  }

  // 落点避开正中，落在 35%~65% 区间
  const tx = box.x + box.width * rnd(0.35, 0.65);
  const ty = box.y + box.height * rnd(0.35, 0.65);

  // 起点：左侧偏上一点，模拟从上一处移过来
  const sx = Math.max(4, tx + rnd(-180, -70));
  const sy = Math.max(4, ty + rnd(-90, 90));

  const c1x = sx + (tx - sx) * rnd(0.2, 0.4) + rnd(-55, 55);
  const c1y = sy + (ty - sy) * rnd(0.2, 0.4) + rnd(-55, 55);
  const c2x = sx + (tx - sx) * rnd(0.6, 0.8) + rnd(-55, 55);
  const c2y = sy + (ty - sy) * rnd(0.6, 0.8) + rnd(-55, 55);

  const steps = Math.floor(rnd(16, 30));
  await page.mouse.move(sx, sy);
  await sleep(rnd(25, 70));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * tx;
    const y = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ty;
    await page.mouse.move(x, y);
    await sleep(rnd(6, 17));
  }

  await sleep(rnd(45, 120));
  await page.mouse.down();

  // 按下期间保持轻微移动 —— 人手指按下去不会纹丝不动
  const wobbles = 2 + Math.floor(rnd(0, 2));
  for (let i = 0; i < wobbles; i++) {
    await sleep(rnd(25, 60));
    await page.mouse.move(tx + rnd(-2.5, 2.5), ty + rnd(-2.5, 2.5));
  }

  await sleep(rnd(35, 85));
  await page.mouse.up();
  return true;
}

/** 在页面上挂一条醒目的操作提示 */
async function showBanner(frame, text) {
  await frame
    .evaluate((t) => {
      const old = document.getElementById('__dsh_banner');
      if (old) old.remove();
      const d = document.createElement('div');
      d.id = '__dsh_banner';
      d.style.cssText =
        'position:fixed;left:0;right:0;top:0;z-index:2147483647;background:#ff6b00;color:#fff;' +
        'padding:14px 20px;font:600 16px/1.5 "Microsoft YaHei",sans-serif;text-align:center;' +
        'box-shadow:0 2px 12px rgba(0,0,0,.3)';
      d.textContent = t;
      document.body.appendChild(d);
    }, text)
    .catch(() => {});
}

/** 判断是否已经提交成功 */
async function isSubmitted(frame) {
  const t = await frame
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
    .catch(() => '');
  if (!t) return false;
  if (/已提交|提交成功|查看解析|查看答案|正确答案|重新作答|重做/.test(t)) return true;
  if (/得分\s*[:：]/.test(t)) return true;
  return false;
}

/* ═════════ 接口直提（不走 UI） ═════════ */

/**
 * POST /mooc-api/v1/lms/exercise/problem_apply/
 *   { classroom_id, problem_id, answer: ["C"] }    单选
 *   { classroom_id, problem_id, answer: ["A","B"] } 多选
 * 需要 X-CSRFToken（取 cookie 里的 csrftoken）。
 *
 * 实测：连续提交不产生 pointer / environment 风险分，
 * 比模拟点击安全得多——因为根本没碰 DOM。
 */
/** 带 429 退避的 POST：5s → 10s → 20s，最多 3 次 */
async function postWithRetry(url, opts, { retries = 3, log = console.log } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(url, opts).catch(() => null);
    if (!r) {
      if (attempt === retries) return null;
      await sleep(2000);
      continue;
    }
    if (r.status !== 429) return r;
    if (attempt === retries) return r;
    const wait = 5000 * 2 ** attempt; // 5s / 10s / 20s
    log(color.yellow(`  429 限流，${wait / 1000}s 后重试（${attempt + 1}/${retries}）`));
    await sleep(wait);
  }
  return null;
}

async function submitViaAPI(leafId, problems, answers, { delayMs = 4200 } = {}) {
  const csrf = COOKIES.find((c) => c.name === 'csrftoken')?.value || '';
  const url = `${ORIGIN}/mooc-api/v1/lms/exercise/problem_apply/?classroom_id=${ROOM}&uv_id=2910&term=latest`;
  const referer = `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}`;

  let okN = 0;
  let skipN = 0;
  const wrong = [];

  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const raw = String(answers[String(i + 1)] || '').trim().toUpperCase();
    if (!raw) {
      skipN++;
      console.log(`${color.gray(`[${i + 1}/${problems.length}]`)} ${color.gray('无答案，跳过')}`);
      continue;
    }
    const letters = raw.split('').filter((c) => /[A-Z]/.test(c));
    if (!letters.length) {
      skipN++;
      continue;
    }

    const r = await postWithRetry(
      url,
      {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json', 'x-csrftoken': csrf, referer },
        body: JSON.stringify({ classroom_id: ROOM, problem_id: p.problem_id, answer: letters }),
      },
      { log: console.log },
    );

    let j = null;
    try {
      j = await r.json();
    } catch {}

    if (j?.success) {
      okN++;
      const sc = j.data?.my_score;
      const right = j.data?.is_right ?? j.data?.is_correct;
      const correct = Array.isArray(j.data?.answer) ? j.data.answer.join('') : '';
      if (right) {
        console.log(`${color.gray(`[${i + 1}/${problems.length}]`)} 提交 ${letters.join('')} ${color.green(`✓ ${sc}分`)}`);
      } else {
        wrong.push({ n: i + 1, mine: letters.join(''), correct });
        console.log(
          `${color.gray(`[${i + 1}/${problems.length}]`)} 提交 ${letters.join('')} ${color.red(`✗ ${sc}分`)}${correct ? color.gray(`  正确答案 ${correct}`) : ''}`,
        );
      }
    } else if (/chance/i.test(j?.msg || '')) {
      skipN++;
      console.log(`${color.gray(`[${i + 1}/${problems.length}]`)} ${color.yellow('已无作答机会，跳过')}`);
    } else {
      console.log(`${color.gray(`[${i + 1}/${problems.length}]`)} ${color.red('提交失败')} ${j?.msg || r?.status || ''}`);
    }

    await sleep(delayMs + Math.floor(Math.random() * 1000));
  }

  return { submitted: okN > 0, via: 'api', ok: okN, skipped: skipN, wrong };
}

/**
 * 整卷一次提交：POST /mooc-api/v1/lms/exercise/problem_batch_apply/
 *   {
 *     classroom_id, exercise_id, leaf_id,
 *     answer_dict: { "<problem_id>": ["A"], "<problem_id>": ["A","B"] }
 *   }
 * 响应 data 形如 { "<problem_id>": [结果或错误文本, code] }。
 *
 * 相比逐题 problem_apply，只发一个请求，不会被 429 打断。
 */
async function submitViaBatch(leafId, aid, problems, answers) {
  const csrf = COOKIES.find((c) => c.name === 'csrftoken')?.value || '';
  const answerDict = {};
  let planned = 0;

  for (let i = 0; i < problems.length; i++) {
    const raw = String(answers[String(i + 1)] || '').trim().toUpperCase();
    const letters = raw.split('').filter((c) => /[A-Z]/.test(c));
    if (!letters.length) continue;
    answerDict[String(problems[i].problem_id)] = { answer: letters };
    planned++;
  }

  if (!planned) {
    console.log(warn('答案文件是空的，跳过'));
    return { submitted: false, via: 'empty' };
  }

  const url = `${ORIGIN}/mooc-api/v1/lms/exercise/problem_batch_apply/?classroom_id=${ROOM}&uv_id=2910&term=latest`;
  const referer = `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}`;

  console.log(info(`整卷提交：${planned} 题，1 个请求`));
  const r = await postWithRetry(
    url,
    {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json', 'x-csrftoken': csrf, referer },
      body: JSON.stringify({ classroom_id: ROOM, exercise_id: aid, leaf_id: Number(leafId), answer_dict: answerDict }),
    },
    { log: console.log },
  );

  if (!r) {
    console.log(fail('提交请求失败'));
    return { submitted: false, via: 'batch-error' };
  }

  let j = null;
  try {
    j = await r.json();
  } catch {}

  if (!j?.success) {
    console.log(fail(`提交失败：${j?.msg || r.status}`));
    return { submitted: false, via: 'batch-fail' };
  }

  const data = j.data || {};
  let okN = 0;
  let skipN = 0;
  const wrong = [];

  for (const [pid, val] of Object.entries(data)) {
    const n = problems.findIndex((p) => String(p.problem_id) === String(pid));
    const idx = n >= 0 ? n + 1 : '?';
    if (Array.isArray(val) && typeof val[1] === 'number') {
      const [res, code] = val;
      if (code === 0 && res && typeof res === 'object') {
        okN++;
        const sc = res.my_score;
        const right = res.is_right ?? res.is_correct;
        const correct = Array.isArray(res.answer) ? res.answer.join('') : '';
        if (right === false) wrong.push({ n: idx, correct });
        console.log(
          `${color.gray(`[${idx}]`)} ${right === false ? color.red(`✗ ${sc}分`) : color.green(`✓ ${sc}分`)}${
            correct && right === false ? color.gray(`  正确答案 ${correct}`) : ''
          }`,
        );
      } else {
        skipN++;
        console.log(`${color.gray(`[${idx}]`)} ${color.yellow(String(res).slice(0, 40))}`);
      }
    } else if (val && typeof val === 'object') {
      okN++;
      const sc = val.my_score;
      const right = val.is_right ?? val.is_correct;
      const correct = Array.isArray(val.answer) ? val.answer.join('') : '';
      if (right === false) wrong.push({ n: idx, correct });
      console.log(
        `${color.gray(`[${idx}]`)} ${right === false ? color.red(`✗ ${sc}分`) : color.green(`✓ ${sc}分`)}${
          correct && right === false ? color.gray(`  正确答案 ${correct}`) : ''
        }`,
      );
    } else {
      okN++;
      console.log(`${color.gray(`[${idx}]`)} ${color.gray(String(JSON.stringify(val)).slice(0, 60))}`);
    }
  }

  return { submitted: okN > 0, via: 'batch', ok: okN, skipped: skipN, wrong };
}

/* ═════════ 填涂 ═════════ */

async function fillAnswers(page, leafId, answers, total, { dry, manual, waitMin }) {
  const url = `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}?is_chapter=1`;
  console.log(info(`打开作业页 ${leafId}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const frame = await waitFrame(page, /iframe-exercise/);
  await frame.waitForSelector('label[role="radio"], label[role="checkbox"]', { timeout: 60000 }).catch(() => {});
  await sleep(2500);
  await dismissResumeDialog(frame, page);

  // 有挑战就先让用户过掉，否则后面所有点击都会被遮罩吃掉
  if (!(await waitChallengePassed(frame, page, Math.min(waitMin, 10)))) {
    return { submitted: false, via: 'challenge-timeout' };
  }

  // 默认走人类化点击；--fast 退回普通 click（快但会被风控）
  const click = (loc) =>
    OPT.fast ? loc.click({ timeout: 5000 }).catch(() => {}) : humanClick(page, loc);

  for (let i = 1; i <= total; i++) {
    const ans = String(answers[String(i)] || '').trim().toUpperCase();
    const label = `${color.gray(`[${i}/${total}]`)}`;

    if (ans) {
      const letters = ans.split('').filter((c) => /[A-Z]/.test(c));
      let clicked = 0;
      for (const L of letters) {
        const opt = frame.locator(`label:visible:has(input[value="${L}"])`).first();
        if (!(await opt.count())) continue;
        const isOn = () =>
          opt
            .evaluate((el) => {
              const inp = el.querySelector('input');
              return el.classList.contains('is-checked') || Boolean(inp && inp.checked);
            })
            .catch(() => false);
        await click(opt);
        await jitter(180);
        let on = await isOn();
        if (!on) {
          await click(opt);
          await jitter(260);
          on = await isOn();
        }
        if (on) clicked++;
      }
      console.log(`${label} 选中 ${ans} ${clicked === letters.length ? color.green('✓') : color.yellow(`(${clicked}/${letters.length})`)}`);
    } else {
      console.log(`${label} ${color.gray('跳过')}`);
    }

    if (i < total) {
      await waitNoOverlay(frame, page);
      const next = frame.locator('button:visible:has-text("下一题")').last();
      if (await next.count()) {
        await click(next);
        await sleep(700);
      }
    }
  }

  await waitNoOverlay(frame, page);
  const submitBtn = frame.locator('button.el-button--primary:has-text("提交")').first();
  const disabled = await submitBtn.isDisabled().catch(() => true);
  console.log('');
  if (disabled) {
    console.log(warn('提交按钮仍是灰的 —— 还有题目没作答'));
    return { submitted: false, ready: false };
  }
  console.log(ok('提交按钮已可用'));

  if (dry) {
    console.log(warn('演练模式：已填涂但不提交。'));
    return { submitted: false, ready: true };
  }

  if (manual) {
    await page.bringToFront().catch(() => {});
    await showBanner(frame, '请手动点击【提交】按钮 —— 完成后本页会自动关闭并继续下一个');
    console.log('');
    console.log(color.bold(color.yellow('━━ 等你手动提交 ━━')));
    console.log('   浏览器窗口已切到前台。请点击页面底部的【提交】按钮。');
    console.log(color.gray('   如果弹出安全核验（轨迹拖拽），按住起点依次经过 1→2→3 到终点松开。'));
    console.log(color.gray(`   最多等 ${waitMin} 分钟；检测到提交成功后自动关页面继续。`));
    console.log('');

    const deadline = Date.now() + waitMin * 60 * 1000;
    let tick = 0;
    while (Date.now() < deadline) {
      if (await isSubmitted(frame)) {
        await showBanner(frame, '已检测到提交成功，正在关闭…').catch(() => {});
        console.log('\n' + ok('检测到提交完成'));
        await sleep(1200);
        return { submitted: true, via: 'manual' };
      }
      if (++tick % 10 === 0) process.stdout.write(color.gray('.'));
      await sleep(2500);
    }
    console.log('\n' + warn('等待超时，按未提交处理'));
    return { submitted: false, via: 'manual-timeout' };
  }

  // 自动提交
  await jitter(700);
  console.log(info('点击提交…'));
  if (OPT.fast) await submitBtn.click({ timeout: 8000 });
  else await humanClick(page, submitBtn);
  await sleep(1200);
  for (const scope of [frame, page]) {
    for (const t of ['确定', '确认']) {
      const b = scope.locator(`.el-message-box button:has-text("${t}"), .el-dialog button:has-text("${t}")`).first();
      if ((await b.count().catch(() => 0)) && (await b.isVisible().catch(() => false))) {
        await b.click({ timeout: 5000 }).catch(() => {});
        await sleep(1500);
        break;
      }
    }
  }
  await sleep(2500);

  if (await isSubmitted(frame)) {
    console.log(ok('自动提交成功'));
    return { submitted: true, via: 'auto' };
  }
  const blocked = await frame
    .evaluate(() => /安全核验|请完成|拖动|按住/.test(document.body.innerText || ''))
    .catch(() => false);
  if (blocked) {
    console.log(warn('触发了安全核验，自动提交失败 —— 请改用 --manual'));
    return { submitted: false, via: 'blocked' };
  }
  console.log(warn('已点提交，但没检测到完成状态，请人工确认'));
  return { submitted: false, via: 'unknown' };
}

/* ═════════ 单个作业 ═════════ */

async function processOne(leafId, { auto, fill, dry, manual, waitMin }) {
  const t0 = Date.now();
  const ex = await fetchExercise(leafId);
  console.log('');
  console.log(color.bold(`── ${ex.meta.title}`) + color.gray(`  ${ex.data.problems.length} 题`));

  // 整卷已作答的直接跳过，省掉解码和模型调用
  const allDone = ex.data.problems.every((p) => Number(p.user?.my_count) > 0);
  if (allDone && !OPT.force) {
    console.log(color.gray('  全部题目已作答，跳过'));
    return { leaf: leafId, title: ex.meta.title, submitted: false, via: 'done' };
  }

  const fontBuf = Buffer.from(
    await (await fetch(ex.data.font, { headers: { 'user-agent': H['user-agent'] } })).arrayBuffer(),
  );
  // 只有需要重新比对字形、或者要走 UI 填涂时，才启动浏览器
  const uiMode = Boolean(fill) && !OPT.api;
  const needBrowser = needsDecoding(fontBuf, OUT) || uiMode;
  const page = needBrowser ? await ensurePage() : null;
  const dec = await createDecoder(page, fontBuf, OUT, (m) => console.log(info(m)));

  const mdFile = path.join(OUT, `exam-${leafId}.md`);
  fs.writeFileSync(mdFile, renderMarkdown(ex.meta, ex.data, dec), 'utf8');

  const ansFile = ansFileOf(leafId);
  if (!fs.existsSync(ansFile)) {
    fs.writeFileSync(ansFile, JSON.stringify(answersTemplate(ex.data), null, 2), 'utf8');
  }

  if (auto) {
    const { loadLLMConfig, llmAnswer } = await import('./answer.mjs');
    try {
      const items = ex.data.problems.map((p, i) => ({
        n: i + 1,
        type: p.content.TypeText || p.content.Type,
        multi: p.content.Type === 'MultipleChoice',
        stem: dec.decodeHtml(p.content.Body),
        options: (p.content.Options || []).map((o) => ({ key: o.key, text: dec.decodeHtml(o.value || '').replace(/\n+/g, ' ') })),
      }));
      const { answers } = await llmAnswer(ex.meta.title, items, { ...loadLLMConfig(ROOT), log: (m) => console.log(info(m)) });
      if (!Object.keys(answers).length) {
        console.log(fail('模型没有返回任何可用答案'));
        return { leaf: leafId, title: ex.meta.title, submitted: false, via: 'llm-empty' };
      }
      fs.writeFileSync(ansFile, JSON.stringify({ ...answersTemplate(ex.data), ...answers }, null, 2), 'utf8');
      console.log(ok(`模型作答 ${Object.keys(answers).length} 题`));
    } catch (e) {
      console.log(fail(`模型作答失败：${e.message}`));
      return { leaf: leafId, title: ex.meta.title, submitted: false, via: 'llm-error' };
    }
  }

  let result = { submitted: false, via: 'skip' };
  if (fill) {
    const answers = JSON.parse(fs.readFileSync(ansFile, 'utf8'));
    const n = Object.entries(answers).filter(([k, v]) => /^\d+$/.test(k) && String(v).trim()).length;
    if (!n) {
      console.log(warn('答案文件是空的，跳过填涂'));
    } else {
      console.log(info(`读取 ${n} 个答案`));
      if (OPT.api) {
        if (OPT.dry) {
          console.log(warn('演练：接口模式下只打印计划'));
          for (let i = 0; i < ex.data.problems.length; i++) {
            const a = answers[String(i + 1)];
            console.log(`  ${String(i + 1).padStart(2)}  ${a || color.gray('(空)')}`);
          }
          result = { submitted: false, via: 'dry' };
        } else {
          result = await submitViaBatch(leafId, ex.meta.aid, ex.data.problems, answers);
        }
      } else {
        result = await fillAnswers(page, leafId, answers, ex.data.problems.length, { dry, manual, waitMin });
      }
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(color.gray(`  用时 ${secs}s · 结果 ${result.submitted ? '已提交' : result.via}`));
  return { leaf: leafId, title: ex.meta.title, ...result };
}

/* ═════════ 主流程 ═════════ */

console.log('');
console.log(color.bold('作业助手') + color.gray(`  ·  ${course.name}`));
console.log('');

if (OPT.list || (!OPT.leaf && !OPT.all)) {
  const list = await listAssignments();
  console.log(`共 ${list.length} 个作业/测验：\n`);
  const w = Math.max(...list.map((x) => String(x.leaf).length));
  for (const x of list) {
    const hasAns = fs.existsSync(ansFileOf(x.leaf));
    console.log(`  ${String(x.leaf).padEnd(w)}  ${x.title}${hasAns ? color.green('  [有答案]') : ''}`);
  }
  console.log('');
  console.log(color.gray('导出题目：npm run exam -- --leaf <ID>'));
  console.log(color.gray('批量提交：npm run exam -- --all --fill --api'));
  console.log('');
  process.exit(0);
}

// 组装任务列表
let tasks = [];
if (OPT.all) {
  const list = await listAssignments();

  if (OPT.auto) {
    // 先确认 AI 真的能用：没 key、key 错、模型名错，都在这里一次性暴露
    const { loadLLMConfig, checkLLM } = await import('./answer.mjs');
    const llm = loadLLMConfig(ROOT);
    if (!llm.apiKey) {
      console.log('');
      console.log(fail('自动答题需要 AI，但还没有配置'));
      console.log(color.gray('  运行 npm run llm 配置（默认 DeepSeek），或设置环境变量 LLM_API_KEY'));
      process.exit(2);
    }
    console.log(color.gray(`  使用 ${llm.model} @ ${llm.baseUrl}`));
    try {
      const probe = await checkLLM(llm);
      console.log(ok(`AI 就绪，${probe.ms}ms`));
    } catch (e) {
      console.log('');
      console.log(fail(`AI 不可用：${e.message}`));
      console.log(color.gray('  用 npm run llm 重新配置，或 npm run llm-check 单独排查'));
      if (/deepseek-flash|404|model/i.test(e.message)) {
        console.log(color.gray('  DeepSeek 官方可用模型：deepseek-chat / deepseek-reasoner'));
      }
      process.exit(2);
    }

    // 模型答题：不需要预先有答案文件，全部作业都是候选，
    // 已完成的会在 processOne 里被跳过
    tasks = list.map((x) => x.leaf);
    console.log(info(`批量模式：模型答题，${tasks.length} 个作业（已完成的自动跳过）`));
  } else {
    const c = list
      .filter((x) => fs.existsSync(ansFileOf(x.leaf)))
      .filter((x) => {
        try {
          const a = JSON.parse(fs.readFileSync(ansFileOf(x.leaf), 'utf8'));
          return Object.entries(a).some(([k, v]) => /^\d+$/.test(k) && String(v).trim());
        } catch {
          return false;
        }
      });
    if (!c.length) {
      console.log(warn('没有任何作业有可用答案。'));
      console.log(color.gray(`共 ${list.length} 个作业，0 个有答案。想用模型答题请选「模型自动答题并提交」`));
      process.exit(0);
    }
    tasks = c.map((x) => x.leaf);
    console.log(info(`批量模式：${tasks.length}/${list.length} 个作业有答案`));
  }
} else {
  tasks = [OPT.leaf];
}

/* ── 浏览器按需启动 ── */

let browser = null;
let page = null;

async function ensurePage() {
  if (page) return page;
  browser = await launchProjectBrowser();
  // 持久化上下文会恢复上次的标签页（常见表现：一启动就跳回课程页），
  // 这里只留一个空白页
  const pages = browser.pages();
  for (let i = 1; i < pages.length; i++) await pages[i].close().catch(() => {});
  page = pages[0] || (await browser.newPage());
  await page.goto('about:blank').catch(() => {});
  return page;
}

async function closeBrowser() {
  if (!browser) return;
  await browser.close().catch(() => {});
  browser = null;
  page = null;
}

const results = [];
for (let i = 0; i < tasks.length; i++) {
  const leaf = tasks[i];
  console.log('');
  console.log(color.gray(`━━ (${i + 1}/${tasks.length}) ━━`));
  try {
    results.push(
      await processOne(leaf, {
        auto: OPT.auto,
        fill: OPT.fill,
        dry: OPT.dry,
        manual: OPT.manual,
        waitMin: OPT.wait,
      }),
    );
  } catch (e) {
    console.error(fail(`处理失败：${e.message}`));
    results.push({ leaf, error: e.message });
  }
}

console.log('');
if (results.length > 1) {
  console.log(color.bold('━━ 批量汇总 ━━'));
  const okN = results.filter((r) => r.submitted).length;
  for (const r of results) {
    const mark = r.submitted ? color.green('✓ 已提交') : r.error ? color.red('✗ 出错') : color.gray(`· ${r.via}`);
    console.log(`  ${String(r.leaf).padEnd(10)} ${mark}  ${r.title || ''}`);
  }
  console.log(`\n  已提交 ${okN}/${results.length}`);
}

await sleep(600);
await closeBrowser();
process.exit(results.some((result) => result.error) ? 1 : 0);
