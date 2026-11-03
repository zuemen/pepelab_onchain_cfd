import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { DEFAULT_SIGNAL_API_URL } from './signalApi';
import { connectSrcOf, isConnectAllowed, checkSignalApiUrl } from './cspConnect';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const vercel = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'vercel.json'), 'utf8'));

describe('build-time CSP check for VITE_SIGNAL_API_URL', () => {
  it('reads connect-src from the real vercel.json', () => {
    expect(connectSrcOf(vercel)).toContain("'self'");
    expect(connectSrcOf(vercel).length).toBeGreaterThan(2);
  });

  it('the built-in default signal-api URL is allowed', () => {
    expect(isConnectAllowed(DEFAULT_SIGNAL_API_URL, connectSrcOf(vercel))).toBe(true);
    expect(checkSignalApiUrl(DEFAULT_SIGNAL_API_URL, vercel)).toBeNull();
    expect(checkSignalApiUrl(`${DEFAULT_SIGNAL_API_URL}/`, vercel)).toBeNull();
  });

  it('unset and empty string both resolve to the default (same rule as the app) and pass', () => {
    expect(checkSignalApiUrl(undefined, vercel)).toBeNull();
    expect(checkSignalApiUrl('', vercel)).toBeNull();
  });

  it('the default itself is checked too — an allow-list without it would fail the build', () => {
    const noSignal = {
      headers: [
        {
          source: '/(.*)',
          headers: [{ key: 'Content-Security-Policy', value: "connect-src 'self' https://sepolia.base.org" }],
        },
      ],
    };
    expect(checkSignalApiUrl(undefined, noSignal)).toContain(DEFAULT_SIGNAL_API_URL);
    expect(checkSignalApiUrl('', noSignal)).toContain(DEFAULT_SIGNAL_API_URL);
  });

  it('a URL outside the allow-list fails with an explanation naming the origin', () => {
    const msg = checkSignalApiUrl('https://my-signal-api.example.com/v1', vercel);
    expect(msg).toContain('https://my-signal-api.example.com');
    expect(msg).toContain('connect-src');
  });

  it('a different port or scheme is a different origin', () => {
    expect(isConnectAllowed('http://agent-git-master-zuemens-projects.vercel.app', connectSrcOf(vercel))).toBe(false);
    expect(isConnectAllowed('https://sepolia.base.org:8443', connectSrcOf(vercel))).toBe(false);
    expect(isConnectAllowed('not a url', connectSrcOf(vercel))).toBe(false);
    // 解析後的 origin（複審 A3）：大小寫、預設 port、query、尾斜線、userinfo 都正規化成同一個 origin。
    const host = new URL(DEFAULT_SIGNAL_API_URL).host;
    for (const u of [`https://${host.toUpperCase()}`, `https://${host}:443`, `https://${host}/?t=1`, `https://${host}/`, `https://x@${host}`]) {
      expect(isConnectAllowed(u, connectSrcOf(vercel)), u).toBe(true);
    }
    expect(isConnectAllowed(`https://${host}`, [`https://${host.toUpperCase()}:443/`])).toBe(true);
    expect(isConnectAllowed(`https://${host}`, ["'self'"])).toBe(false);
  });
});
