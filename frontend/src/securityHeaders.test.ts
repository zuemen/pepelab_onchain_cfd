import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

// ----------------------------------------------------------------------

/**
 * 正式站的安全標頭寫在 `vercel.json`。這裡鎖住三件事：
 *   1. 該有的標頭都在；
 *   2. `script-src` 沒有 unsafe-inline / unsafe-eval，`connect-src` 沒有萬用字元；
 *   3. 原始碼裡實際 fetch 的外部網域都列在 `connect-src`——新增一個外部 API 卻忘了
 *      改 CSP，正式站會靜默失敗（瀏覽器擋掉、只在 console 留一行），這個測試讓它在
 *      CI 就失敗。
 */
const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vercel = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

const all = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)')!.headers.map((h) => [h.key.toLowerCase(), h.value])
);
const csp = all['content-security-policy'] ?? '';
const directive = (name: string): string[] =>
  (csp.split(';').map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) ?? []).slice(1);

const read = (rel: string) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
const hostOf = (url: string) => new URL(url).origin;

describe('vercel.json security headers', () => {
  it('sets every header the DD checklist asks for', () => {
    for (const key of [
      'content-security-policy',
      'x-frame-options',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'strict-transport-security',
    ]) {
      expect(all[key], key).toBeTruthy();
    }
    expect(all['x-frame-options']).toBe('DENY');
    expect(all['x-content-type-options']).toBe('nosniff');
    expect(directive('frame-ancestors')).toEqual(["'none'"]);
    expect(all['strict-transport-security']).toMatch(/max-age=\d{8,}/);
  });

  it('script-src has no inline or eval escape hatch', () => {
    const script = directive('script-src');
    expect(script).toEqual(["'self'"]);
    expect(csp).not.toMatch(/unsafe-eval/);
  });

  it('connect-src is an explicit allow-list — no wildcard, no bare scheme', () => {
    const connect = directive('connect-src');
    expect(connect.length).toBeGreaterThan(1);
    for (const src of connect) {
      expect(src, src).not.toMatch(/\*/);
      expect(src, src).not.toMatch(/^(https?|wss?):$/);
    }
  });

  it('connect-src covers every external endpoint the app fetches', () => {
    const connect = directive('connect-src');
    const signalDefault = read('src/lib/pepefi/signalApi.ts').match(/'(https:\/\/[^']+)'/)![1];
    const coingecko = read('src/hooks/useLivePrices.ts').match(/`(https:\/\/api\.coingecko\.com)/)![1];
    const baseRpc = read('src/lib/pepefi/chains.ts').match(/rpcUrls:\s*\['(https:\/\/[^']+)'/)![1];
    for (const url of [signalDefault, coingecko, baseRpc]) {
      expect(connect, url).toContain(hostOf(url));
    }
  });
});
