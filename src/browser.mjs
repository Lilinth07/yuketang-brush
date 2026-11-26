import { launchEgoLite, useEgoLite } from './ego-browser.mjs';
import { CFG } from './config.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function macLoginBrowser() {
  if (process.env.YUKETANG_BROWSER_EXECUTABLE && existsSync(process.env.YUKETANG_BROWSER_EXECUTABLE)) {
    return { channel: CFG.channel, executablePath: process.env.YUKETANG_BROWSER_EXECUTABLE };
  }
  for (const appDir of ['/Applications', path.join(homedir(), 'Applications')]) {
    for (const [channel, name] of [['chrome', 'Google Chrome'], ['msedge', 'Microsoft Edge']]) {
      const executablePath = path.join(appDir, `${name}.app`, 'Contents', 'MacOS', name);
      if (existsSync(executablePath)) return { channel, executablePath };
    }
  }
  return null;
}

export async function launchProjectBrowser() {
  if (useEgoLite) return launchEgoLite();
  if (process.platform === 'darwin') {
    const browser = macLoginBrowser();
    if (!browser) throw new Error('登录和扫描课程需要已安装的 EgoLite、Google Chrome 或 Microsoft Edge。');
    const { chromium } = await import('playwright');
    return chromium.launchPersistentContext(`${CFG.userDataDir}-${browser.channel}`, {
      executablePath: browser.executablePath, headless: false, viewport: null,
    });
  }
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(CFG.userDataDir, {
    channel:CFG.channel, headless:false, viewport:null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}
