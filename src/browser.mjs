import { CFG } from './config.mjs';

export async function launchProjectBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(CFG.userDataDir, {
    channel:CFG.channel, headless:false, viewport:null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', '--autoplay-policy=no-user-gesture-required'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
}
