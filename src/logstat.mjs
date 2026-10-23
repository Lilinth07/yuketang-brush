#!/usr/bin/env node
/**
 * 读最近一次运行的 jsonl，输出节点级摘要。
 *   node src/logstat.mjs              最近一次
 *   node src/logstat.mjs <file.jsonl> 指定文件
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOGDIR = path.join(ROOT, 'out', 'logs');

let file = process.argv[2];
if (!file) {
  const cands = fs.existsSync(LOGDIR)
    ? fs.readdirSync(LOGDIR).filter((f) => f.endsWith('.jsonl'))
    : [];
  if (!cands.length) {
    console.error('out/logs 下没有 jsonl，先跑一次 node src/brush.mjs');
    process.exit(1);
  }
  file = path.join(LOGDIR, cands.sort().pop());
}
if (!path.isAbsolute(file)) file = path.resolve(process.cwd(), file);

const recs = fs
  .readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const t = (r) => recs.find((x) => x.phase === r);
const last = recs[recs.length - 1];

const lvl = recs.reduce((a, r) => ((a[r.lvl] = (a[r.lvl] || 0) + 1), a), {});
const phases = [];
for (const r of recs) if (!phases.includes(r.phase)) phases.push(r.phase);

const phaseDur = {};
for (let i = 0; i < recs.length; i++) {
  const cur = recs[i].phase;
  const next = recs.slice(i + 1).find((x) => x.phase !== cur);
  if (!(cur in phaseDur)) phaseDur[cur] = (next ? next.elapsedMs : last.elapsedMs) - recs[i].elapsedMs;
}

const lessons = {};
const has = (r, s) => (r.msg || '').includes(s);
for (const r of recs) {
  if (!r.vid) continue;
  if (!lessons[r.vid]) lessons[r.vid] = { vid: r.vid, name: '', result: '-', rate: null, events: null };
  const L = lessons[r.vid];
  if (has(r, 'lesson:begin')) L.name = r.name || '';
  if (has(r, 'lesson:done')) L.result = 'ok';
  if (has(r, 'lesson:skip')) L.result = 'skip';
  if (has(r, 'lesson:dry')) L.result = 'dry';
  if (has(r, 'lesson:fail')) L.result = 'fail';
  if (has(r, 'lesson:retry')) L.result = 'retry';
  if (typeof r.rate === 'number') L.rate = r.rate;
  if (typeof r.events === 'number') L.events = r.events;
}

const tally = Object.values(lessons).reduce((a, l) => ((a[l.result] = (a[l.result] || 0) + 1), a), {});
const problems = Object.values(lessons).filter((l) => l.result === 'fail' || l.result === 'retry');
const posted = recs.filter((r) => has(r, 'lesson:post'));
const events = posted.reduce((s, r) => s + (r.events || 0), 0);

const pad = (s, n) => String(s).padEnd(n);

console.log(`日志: ${path.basename(file)}`);
console.log(`记录: ${recs.length} 条   跨度: ${((last?.elapsedMs || 0) / 1000).toFixed(1)}s\n`);

console.log('级别统计');
for (const k of ['ok', 'info', 'warn', 'error', 'debug']) if (lvl[k]) console.log(`  ${pad(k, 6)} ${lvl[k]}`);

console.log('\n阶段耗时');
for (const p of phases) {
  const ms = phaseDur[p] || 0;
  const bar = '█'.repeat(Math.min(30, Math.round(ms / 1000)));
  console.log(`  ${pad(p, 10)} ${String(Math.round(ms)).padStart(6)}ms  ${bar}`);
}

console.log('\n节结果');
for (const [k, v] of Object.entries(tally)) console.log(`  ${pad(k, 7)} ${v}`);

const all = Object.values(lessons);
if (all.length && all.length <= 40) {
  console.log('\n节明细');
  for (const l of all) {
    console.log(`  ${pad(l.vid, 10)} ${pad(l.result, 6)} rate=${l.rate ?? '-'}  ${l.name}`);
  }
}

console.log('\n上报');
console.log(`  POST 次数 ${posted.length}   事件总数 ${events}`);
if (posted.length) {
  const avg = Math.round(events / posted.length);
  console.log(`  平均每节 ${avg} 条`);
}

if (problems.length) {
  console.log('\n需要关注的节点');
  for (const p of problems) console.log(`  ${p.vid}  ${pad(p.result, 6)} ${p.name}`);
} else {
  console.log('\n无失败/重试节点');
}

const errs = recs.filter((r) => r.lvl === 'error');
if (errs.length) {
  console.log('\nerror 明细');
  for (const e of errs.slice(0, 20)) console.log(`  [${e.phase}] ${e.msg} ${e.err || ''}`);
}
