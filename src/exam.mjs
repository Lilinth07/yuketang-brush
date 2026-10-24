#!/usr/bin/env node
/**
 * 作业/测验助手（半自动）
 *
 *   npm run exam -- --list                     列出所有作业与完成状态
 *   npm run exam -- --leaf 90000003            导出题目为 markdown + 答案模板
 *   npm run exam -- --leaf 90000003 --fill     按答案文件自动填涂
 *   npm run exam -- --leaf 90000003 --fill --dry  只填不提交
 *
 * 字体加密由 fontdec.mjs 处理：字形比对一次后按 glyf 指纹缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, OUT, CFG, resolveCourse, COOKIE_FILE } from './config.mjs';
import { createDecoder } from './fontdec.mjs';
import { color, ok, fail, warn, info } from './ui.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const OPT = {
  list: flag('list'),
  leaf: Number(val('leaf', 0)) || null,
  fill: flag('fill'),
  dry: flag('dry'),
  delay: Number(val('delay', 0)) || 0,
  course: val('course'),
};

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

const COOKIES = fs.existsSync(COOKIE_FILE) ? JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')) : [];
if (!COOKIES.length) {
  console.error(fail('缺少登录态，先运行 npm run setup'));
  process.exit(2);
}
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

/* ═════════ 作业列表 ═════════ */

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

/* ═════════ 题目 ═════════ */

async function fetchExercise(leafId) {
  const list = await listAssignments();
  const hit = list.find((x) => Number(x.leaf) === Number(leafId));
  if (!hit) throw new Error(`leaf ${leafId} 不在作业列表里，先跑 --list 看可用 ID`);
  const r = await fetch(
    `${ORIGIN}/mooc-api/v1/lms/exercise/get_exercise_list/${hit.aid}/${SKU}/?classroom_id=${ROOM}`,
    { headers: { ...H, referer: `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}` } },
  );
  const j = await r.json();
  if (!j?.data?.problems) throw new Error(`题目拉取失败：${j?.msg || '未知错误'}`);
  return { meta: hit, data: j.data };
}

/* ═════════ 渲染 markdown ═════════ */

function renderMarkdown(meta, data, dec) {
  const L = [];
  // 注意：标题来自日志接口，本来就是明文，不能送进解码器
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
      const txt = dec.decodeHtml(o.value || '').replace(/\n+/g, ' ');
      L.push(`- **${o.key}.** ${txt}`);
    }
    L.push('');
  });

  L.push('---');
  L.push('');
  L.push('> 把答案填进同名的 `answers-<leaf>.json`，例如 `{"1":"C","2":"ABD"}`，然后：');
  L.push(`> \`npm run exam -- --leaf ${meta.leaf} --fill\``);
  return L.join('\n');
}

function answersTemplate(data) {
  const t = { _说明: '题号 -> 答案字母，多选连写如 ABD；留空表示跳过该题' };
  data.problems.forEach((_, i) => (t[String(i + 1)] = ''));
  return t;
}

/* ═════════ 填涂 ═════════ */

async function waitFrame(page, re, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = page.frames().find((x) => re.test(x.url()));
    if (f) return f;
    await sleep(800);
  }
  throw new Error('等不到作业 iframe');
}

/**
 * 平台会记住「答了但没提交」的草稿，再次进入时弹窗询问。
 * 不关掉它，后面所有点击都会落在遮罩上。
 */
async function dismissResumeDialog(frame, page) {
  for (const scope of [frame, page]) {
    for (const t of ['先不用了', '继续作答', '暂不提交', '取消']) {
      const b = scope.locator(`button:visible:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) {
        const vis = await b.isVisible().catch(() => false);
        if (!vis) continue;
        await b.click({ timeout: 3000 }).catch(() => {});
        await sleep(900);
        console.log(info(`已关闭「尚未提交」提示（${t}）`));
        return true;
      }
    }
  }
  return false;
}

/** 确认没有遮罩挡住操作 */
async function waitNoOverlay(frame, page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let blocked = false;
    for (const scope of [frame, page]) {
      const m = scope.locator('.el-message-box__wrapper:visible, .el-dialog__wrapper:visible').first();
      if (await m.count().catch(() => 0)) {
        if (await m.isVisible().catch(() => false)) blocked = true;
      }
    }
    if (!blocked) return true;
    await dismissResumeDialog(frame, page);
    await sleep(600);
  }
  return false;
}

async function fillAnswers(page, leafId, answers, total, { dry }) {
  const url = `${ORIGIN}/ai-workspace/lms-graph/${ROOM}/exercise/${leafId}?is_chapter=1`;
  console.log(info(`打开作业页 ${leafId}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const frame = await waitFrame(page, /iframe-exercise/);
  await frame.waitForSelector('label[role="radio"], label[role="checkbox"]', { timeout: 60000 }).catch(() => {});
  await sleep(2500);
  await dismissResumeDialog(frame, page);

  for (let i = 1; i <= total; i++) {
    const ans = String(answers[String(i)] || '').trim().toUpperCase();
    const label = `${color.gray(`[${i}/${total}]`)}`;

    if (ans) {
      const letters = ans.split('').filter((c) => /[A-Z]/.test(c));
      let clicked = 0;
      for (const L of letters) {
        // 必须限定 :visible —— 切换题目后旧题 DOM 还在，只是隐藏
        const opt = frame.locator(`label:visible:has(input[value="${L}"])`).first();
        if (!(await opt.count())) continue;

        const isOn = () =>
          opt
            .evaluate((el) => {
              const inp = el.querySelector('input');
              return el.classList.contains('is-checked') || Boolean(inp && inp.checked);
            })
            .catch(() => false);

        await opt.click({ timeout: 5000 }).catch(() => {});
        await jitter(180);
        let on = await isOn();
        if (!on) {
          await opt.click({ timeout: 3000 }).catch(() => {});
          await jitter(260);
          on = await isOn();
        }
        if (on) clicked++;
      }
      console.log(`${label} 选中 ${ans} ${clicked === letters.length ? color.green('✓') : color.yellow(`(${clicked}/${letters.length})`)}`);
    } else {
      console.log(`${label} ${color.gray('跳过（答案为空）')}`);
    }

    if (i < total) {
      await waitNoOverlay(frame, page);
      const next = frame.locator('button:visible:has-text("下一题")').last();
      if (await next.count()) {
        await next.click({ timeout: 5000 }).catch(() => {});
        await sleep(700);
      }
    }
  }

  if (dry) {
    console.log(warn('\n演练模式：已填涂但不提交。检查页面后手动提交，或去掉 --dry 重跑。'));
    return { submitted: false };
  }

  await jitter(700);
  console.log(info('点击提交…'));
  const submitBtn = frame.locator('button.el-button--primary:has-text("提交")').first();
  if (!(await submitBtn.count())) throw new Error('找不到提交按钮');
  const disabled = await submitBtn.isDisabled().catch(() => false);
  if (disabled) throw new Error('提交按钮是灰的，可能有题目未作答');

  await submitBtn.click({ timeout: 8000 });

  // 确认弹窗可能在 iframe 或父页面
  await sleep(1200);
  for (const scope of [frame, page]) {
    for (const t of ['确定', '确认', '提交']) {
      const b = scope.locator(`.el-message-box button:has-text("${t}"), .el-dialog button:has-text("${t}")`).first();
      if (await b.count().catch(() => 0)) {
        if (await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 5000 }).catch(() => {});
          await sleep(1500);
          break;
        }
      }
    }
  }

  await sleep(2500);
  const body = await frame.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200)).catch(() => '');
  const done = /已提交|提交成功|得分|成绩/.test(body);
  console.log(done ? ok(`提交完成：${body.slice(0, 80)}`) : warn('已点击提交，请自行确认结果'));
  return { submitted: true, hint: body.slice(0, 120) };
}

/* ═════════ 主流程 ═════════ */

console.log('');
console.log(color.bold('作业助手') + color.gray(`  ·  ${course.name}`));
console.log('');

if (OPT.list || !OPT.leaf) {
  const list = await listAssignments();
  console.log(`共发现 ${list.length} 个作业/测验：\n`);
  const w = Math.max(...list.map((x) => String(x.leaf).length));
  for (const x of list) {
    console.log(`  ${String(x.leaf).padEnd(w)}  ${x.title}`);
  }
  console.log('');
  console.log(color.gray('导出题目：npm run exam -- --leaf <ID>'));
  console.log('');
  process.exit(0);
}

let ex;
try {
  ex = await fetchExercise(OPT.leaf);
} catch (e) {
  console.error(fail(e.message));
  process.exit(3);
}
console.log(ok(`题目已拉取：${ex.meta.title} / ${ex.data.problems.length} 题`));

const fontUrl = ex.data.font;
const fontBuf = Buffer.from(await (await fetch(fontUrl, { headers: { 'user-agent': H['user-agent'] } })).arrayBuffer());
console.log(info(`字体 ${fontBuf.length} 字节`));

const browser = await chromium.launchPersistentContext(CFG.userDataDir, {
  channel: CFG.channel,
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  ignoreDefaultArgs: ['--enable-automation'],
});
const page = browser.pages()[0] || (await browser.newPage());

const dec = await createDecoder(page, fontBuf, OUT, (m) => console.log(info(m)));
console.log(ok(`解码就绪：${dec.mappedCount}/${dec.glyphCount} 字形`));

const md = renderMarkdown(ex.meta, ex.data, dec);
const mdFile = path.join(OUT, `exam-${ex.meta.leaf}.md`);
fs.writeFileSync(mdFile, md, 'utf8');

const ansFile = path.join(OUT, `answers-${ex.meta.leaf}.json`);
if (!fs.existsSync(ansFile)) {
  fs.writeFileSync(ansFile, JSON.stringify(answersTemplate(ex.data), null, 2), 'utf8');
}

console.log('');
console.log(ok(`题目已导出：${path.relative(ROOT, mdFile)}`));
console.log(ok(`答案模板：${path.relative(ROOT, ansFile)}`));
console.log('');

if (!OPT.fill) {
  console.log(color.gray('看看题目，把答案填进上面那个 json，然后加 --fill 重跑。'));
  console.log('');
  await browser.close();
  process.exit(0);
}

if (!fs.existsSync(ansFile)) {
  console.error(fail('答案文件不存在'));
  await browser.close();
  process.exit(4);
}
const answers = JSON.parse(fs.readFileSync(ansFile, 'utf8'));
const filled = Object.entries(answers).filter(([k, v]) => /^\d+$/.test(k) && String(v).trim());
if (!filled.length) {
  console.error(fail('答案文件里还没有任何答案'));
  await browser.close();
  process.exit(4);
}
console.log(info(`已读取 ${filled.length} 个答案`));

try {
  const r = await fillAnswers(page, ex.meta.leaf, answers, ex.data.problems.length, { dry: OPT.dry });
  console.log(r.submitted ? ok('完成') : warn('未提交'));
} catch (e) {
  console.error(fail(`填涂失败：${e.message}`));
}

console.log('');
await sleep(1500);
await browser.close();
process.exit(0);
