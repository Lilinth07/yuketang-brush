/**
 * 自动作答：调用 OpenAI 兼容接口，把题目丢给模型，拿回 JSON 答案。
 *
 * 配置优先级：环境变量 > config.local.json 的 llm 字段
 *   LLM_BASE_URL   默认 https://api.openai.com/v1
 *   LLM_API_KEY    必填
 *   LLM_MODEL      默认 gpt-4o-mini
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadLLMConfig(rootDir) {
  const cfgFile = path.join(rootDir, 'config.local.json');
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).llm || {};
  } catch {}

  return {
    baseUrl: process.env.LLM_BASE_URL || local.baseUrl || 'https://api.openai.com/v1',
    apiKey: process.env.LLM_API_KEY || local.apiKey || '',
    model: process.env.LLM_MODEL || local.model || 'gpt-4o-mini',
  };
}

function buildPrompt(title, items) {
  const lines = [];
  lines.push('下面是一份中文马克思主义基本原理课的作业题。');
  lines.push('注意：题干由字形识别程序还原，可能存在形近字错误（例如「卮机」应为「危机」、「经侪」应为「经济」、「杜会」应为「社会」、「畋革」应为「改革」、「囟由」应为「自由」、「主产」应为「生产」、「兮司」应为「公司」、「丨」应为「一」），请结合上下文自行纠正后再作答。');
  lines.push('');
  lines.push(`作业名称：${title}`);
  lines.push('');
  for (const it of items) {
    lines.push(`【第 ${it.n} 题】${it.type}${it.multi ? '（多选，可能不止一个正确选项）' : '（单选）'}`);
    lines.push(it.stem);
    for (const o of it.options) lines.push(`  ${o.key}. ${o.text}`);
    lines.push('');
  }
  lines.push('请只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。');
  lines.push('格式：{"1":"C","2":"ABD","3":"A"}');
  lines.push('多选用连续字母表示，如 "ABD"。每题都必须给出答案。');
  return lines.join('\n');
}

function parseAnswers(text, total) {
  let s = String(text).trim();
  // 去掉可能的代码围栏
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`模型没返回 JSON：${s.slice(0, 120)}`);
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    throw new Error(`模型返回的 JSON 解析失败：${e.message}`);
  }
  const out = {};
  for (let i = 1; i <= total; i++) {
    const v = obj[String(i)] ?? obj[i];
    if (!v) continue;
    const letters = String(v)
      .toUpperCase()
      .replace(/[^A-D]/g, '')
      .split('')
      .filter((c, idx, arr) => arr.indexOf(c) === idx)
      .sort()
      .join('');
    if (letters) out[String(i)] = letters;
  }
  return out;
}

/**
 * @param items  [{ n, type, multi, stem, options:[{key,text}] }]
 */
export async function llmAnswer(title, items, { baseUrl, apiKey, model, log = () => {} }) {
  if (!apiKey) {
    throw new Error(
      '没有配置 LLM API。设置环境变量后重试：\n' +
        '  $env:LLM_API_KEY="sk-..."\n' +
        '  $env:LLM_MODEL="gpt-4o-mini"        # 可选\n' +
        '  $env:LLM_BASE_URL="https://..."     # 可选，兼容 OpenAI 的中转/本地服务都可以',
    );
  }

  const prompt = buildPrompt(title, items);
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  log(`请求模型 ${model}（${items.length} 题）…`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: '你是严谨的中文考试答题助手，只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}：${t.slice(0, 200)}`);
  }

  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content || '';
  const answers = parseAnswers(content, items.length);

  const missing = items.map((x) => x.n).filter((n) => !answers[String(n)]);
  if (missing.length) log(`注意：模型漏答 ${missing.length} 题（${missing.join(',')}）`);

  return { answers, raw: content };
}
