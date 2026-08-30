/**
 * Singleton del Browser de Playwright. Un solo Browser para todo el proceso;
 * los BrowserContext (sesión) y Page (por request) se crean sobre él.
 */
import { chromium, type Browser } from 'playwright';
import { loadConfig } from './config';
import { logger } from './logger';

/** User-agent realista para reducir detección de headless. */
export const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  const cfg = loadConfig();
  logger.info({ headless: cfg.HEADLESS }, 'Lanzando Chromium');
  browser = await chromium.launch({
    headless: cfg.HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

/** true si el browser está vivo (para /healthz). */
export function isBrowserUp(): boolean {
  return browser !== null && browser.isConnected();
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
