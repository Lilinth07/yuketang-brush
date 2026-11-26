#!/usr/bin/env node
/**
 * 单独重登：npm run login
 * 只做一件事——打开登录页，等你扫码，成功后把 cookie 存到 out/cookies.json。
 * 首次使用建议直接跑 npm run setup（会把课程参数一起配好）。
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { loginPrompt, useEgoLite } from './ego-browser.mjs';
import { launchProjectBrowser } from './browser.mjs';
import { CFG, COOKIE_FILE, OUT, getActiveCourse } from './config.mjs';
import { color, ok, fail, warn } from './ui.mjs';

fs.mkdirSync(OUT, { recursive: true });

console.log('');
console.log(color.bold('雨课堂 登录'));
console.log(color.gray('  在弹出的窗口里扫码，或输入账号密码。\n'));

let ctx;
try { ctx = await launchProjectBrowser(); } catch (error) { console.log(fail(error.message)); process.exit(2); }

try {
  const origin = getActiveCourse()?.origin || CFG.origin;
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`${origin}/web/?next=/v2/web/index`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  async function whoami() {
    return page
      .evaluate(async () => {
        try {
          const r = await fetch('/api/v3/user/basic-info', { credentials: 'include' });
          const j = await r.json();
          return { code: j.code, uid: j.data?.id || null, name: j.data?.name || '' };
        } catch {
          return { code: -1 };
        }
      })
      .catch(() => ({ code: -1 }));
  }

  let me = await whoami();
  if (me.code === 0 && me.uid) {
    console.log(ok(`已登录：${me.name} (${me.uid})`));
  } else {
    if (!useEgoLite) console.log(warn('等待登录，最多 15 分钟…'));
    if (useEgoLite) {
      await ctx.handOff();
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { await rl.question(loginPrompt + '\n按回车继续 > '); } finally { rl.close(); }
      await ctx.resume();
    }
    const deadline = Date.now() + (useEgoLite ? 10000 : 15 * 60 * 1000);
    let tick = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      me = await whoami();
      if (me.code === 0 && me.uid) break;
      if (++tick % 15 === 0) process.stdout.write(color.gray('.'));
    }
    process.stdout.write('\n');
    if (me.code !== 0 || !me.uid) {
      console.log(fail('未检测到登录'));
      process.exitCode = 2;
    } else console.log(ok(`登录成功：${me.name} (${me.uid})`));
  }

  if (!process.exitCode) {
    const cookies = await ctx.cookies(origin);
    const keep = cookies.filter((c) => /(^|\.)yuketang\.cn$/.test(c.domain.replace(/^\./, '')));
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(keep, null, 2), {mode:0o600});
    fs.chmodSync(COOKIE_FILE, 0o600);
    console.log(ok('雨课堂登录态已保存'));
  }
} catch (error) {
  console.log(fail(error.message));
  process.exitCode = 2;
} finally {
  await ctx.close().catch(() => {});
}
