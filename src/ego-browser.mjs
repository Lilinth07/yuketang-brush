import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const browserMode = process.env.YUKETANG_BROWSER;
const egoPaths = [
  process.env.EGO_BROWSER_BIN,
  path.join(homedir(), '.local/bin/ego-browser'),
  '/opt/homebrew/bin/ego-browser',
  '/usr/local/bin/ego-browser',
  ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'ego-browser')),
];
const installedEgo = egoPaths.find((file) => file && existsSync(file));
export const useEgoLite = browserMode === 'ego' ||
  (process.platform === 'darwin' && browserMode !== 'playwright' && Boolean(installedEgo));

export function egoExecutable() {
  return process.env.EGO_BROWSER_BIN || installedEgo || 'ego-browser';
}

async function run(script, data, timeout = 100000) {
  const marker = 'YUKETANG_BROWSER_' + randomUUID() + ':';
  const code = `
    const input = ${JSON.stringify(data)};
    const work = async () => { ${script} };
    const reply = await work().then(result => ({result}), () => ({failed:true}));
    console.log(${JSON.stringify(marker)} + JSON.stringify(reply));`;
  try {
    const { stdout, stderr } = await exec(egoExecutable(), ['nodejs', '-e', code], { timeout, maxBuffer: 2 * 1024 * 1024 });
    const line = (stdout + '\n' + stderr).split(/\r?\n/).find((item) => item.startsWith(marker));
    const result = line && JSON.parse(line.slice(marker.length));
    if (result && !result.failed) return result.result;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('找不到 EgoLite。请打开 EgoLite 并完成首次设置。');
  }
  throw new Error('EgoLite 操作失败，请检查 EgoLite 是否运行、雨课堂标签页是否打开及操作权是否已交还。');
}

export const loginPrompt = '请在 EgoLite 完成登录，然后回到服务终端发送空回复继续。';

export async function launchEgoLite() {
  const { id, label } = await run(`
    const entry = (await listTaskSpaces()).find(s => s.name === input.name);
    if (entry?.ownership === 'agentDelegatedToUser') throw new Error('User control');
    const task = entry?.ownership === 'user' ? await claimTaskSpace(entry.id)
      : await taskSpace(entry?.id ?? input.name);
    const page = (await task.pages())[0] ??
      await task.adopt((await task.tabs()).find(item => item.active).page);
    return { id: task.spaceId, label: page.label };
  `, { name: '雨课堂 App' });
  let kept = label;
  let delegated = false;

  function call(script, data = {}, timeout) {
    return run(`
      const task = await taskSpace(input.id);
      const page = input.label ? task.page(input.label) : null;
      ${script}
    `, { ...data, id }, timeout);
  }

  function wrap(label) {
    return {
      goto: (url, options) => call('await page.goto(input.url, input.options);', { label, url, options }),
      evaluate: (fn, argument) => call('const callback = (0, eval)(\`(\${input.source})\`); return Object.hasOwn(input, "argument") ? await page.evaluate(callback, input.argument) : await page.evaluate(callback);',
        { label, source: fn.toString(), argument }),
      waitForTimeout: sleep,
      close: () => call('await page.close();', { label }),
      keep() { kept = label; },
    };
  }

  return {
    pages: () => [wrap(label)],
    async newPage() { return wrap(await call('return (await task.newPage()).label;')); },
    async cookies(origin) {
      const url = new URL(origin);
      if (url.protocol !== 'https:' || (url.hostname !== 'yuketang.cn' && !url.hostname.endsWith('.yuketang.cn'))) {
        throw new Error('只读取当前雨课堂站点的登录态');
      }
      const dir = await mkdtemp(path.join(tmpdir(), 'yuketang-login-'));
      const file = path.join(dir, 'session.json');
      try {
        await call(`
          const { writeFile } = await import('node:fs/promises');
          const { cookies } = await page.cdp('Network.getCookies', { urls: [input.origin] });
          await writeFile(input.file, JSON.stringify(cookies.filter(cookie => !cookie.partitionKey)),
            { flag: 'wx', mode: 0o600 });
        `, { label, origin: url.origin, file });
        const cookies = JSON.parse(await readFile(file, 'utf8'));
        if (!cookies.length) throw new Error('EgoLite 中未找到此站点可供本项目使用的登录态');
        return cookies;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async handOff() {
      await call('await task.handOff();');
      delegated = true;
    },
    async resume() {
      await run('await takeOverTaskSpace(input.id);', { id });
      delegated = false;
    },
    async close() {
      if (!delegated) await call('await task.finish({keep:[input.kept]});', { kept });
    },
  };
}
