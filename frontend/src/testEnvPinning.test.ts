import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { NOT_PINNED, PINNED_ENV } from '../vitest.pinnedEnv';

// ----------------------------------------------------------------------

/**
 * PR #202 審查 M2：單元測試固定的環境變數是明確白名單（vitest.pinnedEnv.ts）。
 * 這裡斷言三件事：清單內容、實際生效、src 讀到的每一個 VITE_* 都有人做過決定。
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));

function envNamesReadBySource(): Set<string> {
  const names = new Set<string>();
  for (const rel of fs.readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    const file = path.join(SRC, rel);
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || !fs.statSync(file).isFile()) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

// 這組測試同步掃整個檔案樹，Windows 開發機在負載下要 3～17 秒。vitest 2 不對同步測試計時，
// vitest 4 會在同步測試結束後比對耗時、超過 testTimeout（預設 5 秒）就判失敗，所以在這裡明確給
// 60 秒上限：不讓機器負載決定結果，真正卡住時仍會失敗。
const SCAN = { timeout: 60_000 };
describe('vitest 固定的環境變數', SCAN, () => {
  it('白名單內容：租戶、語系、五個功能旗標、mock wallet、signal-api 網址、資產前綴', () => {
    expect([...PINNED_ENV].sort()).toEqual(
      [
        'VITE_TENANT',
        'VITE_LOCALE',
        'VITE_SHOW_LEVERAGE',
        'VITE_SHOW_PERPETUALS',
        'VITE_FEATURE_GAMEFI',
        'VITE_FEATURE_PEPE_REWARDS',
        'VITE_FEATURE_COPY_TRADING',
        'VITE_ENABLE_MOCK_WALLET',
        'VITE_SIGNAL_API_URL',
        'VITE_ASSETS_DIR',
      ].sort()
    );
  });

  it('實際生效：測試裡讀到的每一個都是空字串（不受 shell 或 .env.local 影響）', () => {
    const env = import.meta.env as unknown as Record<string, unknown>;
    for (const name of PINNED_ENV) expect(env[name], name).toBe('');
  });

  it('src 讀到的每一個 VITE_* 不是固定、就是在 NOT_PINNED 寫了理由——新增 env 時必須做決定', () => {
    const undecided = [...envNamesReadBySource()].filter(
      (name) => !(PINNED_ENV as readonly string[]).includes(name) && !(name in NOT_PINNED)
    );
    expect(undecided).toEqual([]);
  });

  it('兩份清單沒有重疊，NOT_PINNED 每一項都有理由', () => {
    for (const name of PINNED_ENV) expect(name in NOT_PINNED, name).toBe(false);
    for (const [name, why] of Object.entries(NOT_PINNED)) expect(why.length, name).toBeGreaterThan(0);
  });

  it('掃描本身有效：至少找得到語系與租戶', () => {
    const names = envNamesReadBySource();
    expect(names.has('VITE_LOCALE')).toBe(true);
    expect(names.has('VITE_TENANT')).toBe(true);
  });
});
