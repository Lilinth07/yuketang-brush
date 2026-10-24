#!/usr/bin/env node
/**
 * AI 配置向导：把模型端点 / 密钥写进 config.local.json，并当场测一次连通。
 *
 *   npm run llm
 *   npm run llm -- --key sk-xxxx
 *   npm run llm -- --base https://api.deepseek.com/v1 --model deepseek-chat
 *
 * 默认走 DeepSeek 官方接口。任何兼容 OpenAI Chat Completions 的服务都能填。
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { ROOT, CONFIG_FILE, loadConfig, saveConfig } from './config.mjs';
import { DEFAULT_LLM, loadLLMConfig, checkLLM } from './answer.mjs';
import { color, ok, fail, warn, info } from './ui.mjs';

const argv = process.argv.slice(2);
const val = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PRESETS = [
  { name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

const cur = loadLLMConfig(ROOT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (k) => (k ? k.slice(0, 6) + '…' + k.slice(-4) : '(未设置)');

console.log('');
console.log(color.bold('AI 配置') + color.gray('  ·  OpenAI Chat Completions 协议'));
console.log('');
console.log(color.gray(`  当前端点  ${cur.baseUrl}`));
console.log(color.gray(`  当前模型  ${cur.model}`));
console.log(color.gray(`  当前密钥  ${mask(cur.apiKey)}`));
console.log('');
console.log(color.gray('  常用预设（回车用默认，或直接输入序号换一套）：'));
PRESETS.forEach((p, i) => console.log(color.gray(`    ${i + 1}. ${p.name.padEnd(12)} ${p.baseUrl}  ·  ${p.model}`)));
console.log('');

let baseUrl = val('base');
let model = val('model');
let apiKey = val('key');

if (!baseUrl || !model) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pick = (await rl.question(color.gray('  预设序号（直接回车 = 保持不变）> '))).trim();
    if (/^\d+$/.test(pick) && PRESETS[Number(pick) - 1]) {
      baseUrl = PRESETS[Number(pick) - 1].baseUrl;
      model = PRESETS[Number(pick) - 1].model;
      console.log(info(`已选用 ${PRESETS[Number(pick) - 1].name}`));
    }
    baseUrl = (await rl.question(`  端点 [${baseUrl || cur.baseUrl}] > `)).trim() || baseUrl || cur.baseUrl;
    model = (await rl.question(`  模型 [${model || cur.model}] > `)).trim() || model || cur.model;
    if (!apiKey) {
      apiKey = (await rl.question(`  API Key [${mask(cur.apiKey)}] > `)).trim() || cur.apiKey;
    }
  } finally {
    rl.close();
  }
}

if (!apiKey) {
  console.log('');
  console.log(fail('没有 API Key。去 https://platform.deepseek.com/api_keys 拿一个'));
  { await sleep(80); process.exit(2); }
}

console.log('');
console.log(info('测试连通性…'));

// DeepSeek 官方只有 deepseek-chat / deepseek-reasoner
if (/api\.deepseek\.com/i.test(baseUrl) && !/^deepseek-(chat|reasoner)$/.test(model)) {
  console.log(warn(`注意：DeepSeek 官方没有「${model}」这个模型`));
  console.log(color.gray('  可用：deepseek-chat（V3，快） / deepseek-reasoner（R1，推理强）'));
}

let testOk = false;
try {
  const r = await checkLLM({ baseUrl, model, apiKey });
  console.log(ok(`连通正常，${r.ms}ms`));
  console.log(color.gray(`  模型回复：${r.reply}`));
  testOk = true;
} catch (e) {
  console.log(fail(`连接失败：${e.message}`));
  const go = process.argv.includes('--force');
  if (!go) {
    console.log(color.gray('  加 --force 可以强行保存（例如模型名暂时不可用）'));
    { await sleep(80); process.exit(1); }
  }
}

const cfg = loadConfig();
cfg.llm = { baseUrl, model, apiKey };
saveConfig(cfg);

console.log('');
console.log(ok(`已写入 ${CONFIG_FILE.replace(ROOT + '\\', '')}`));
console.log(color.gray(`  端点  ${baseUrl}`));
console.log(color.gray(`  模型  ${model}`));
console.log('');
if (testOk) {
  console.log(color.bold('下一步：'));
  console.log(`  npm run exam -- --leaf <ID> --auto --api ${color.gray('# 模型自动答题并提交')}`);
  console.log('');
}
{ await sleep(80); process.exit(0); }
