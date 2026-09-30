import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

// ----------------------------------------------------------------------

/**
 * 回歸護欄：正式頁面不得 import 範本假資料（`src/_mock`）。
 *
 * 範本的通知鈴、聯絡人彈窗、帳戶抽屜的「Jaydon Frankie」都曾經從 `_mock` 拿假資料
 * 擺在 app 外殼上——每個訪客（包括做盡職調查的銀行）都看得到。這個測試掃整個
 * `src`（扣掉 `_mock` 自己與測試檔），任何一行 import `_mock` 就失敗。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function productionSources(): string[] {
  return fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(SRC, rel))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => !path.relative(SRC, file).split(path.sep).includes('_mock'))
    .filter((file) => fs.statSync(file).isFile());
}

const MOCK_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](?:src\/_mock|(?:\.\.?\/)+(?:[\w-]+\/)*_mock)(?:\/[^'"]*)?['"]/;
const MOCK_PERSONA = /Jaydon Frankie|demo@minimals\.cc|useMockedUser/;

describe('no _mock in production code', () => {
  const files = productionSources();

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the import pattern catches the forms we care about', () => {
    expect(MOCK_IMPORT.test(`import { _contacts } from 'src/_mock/_others';`)).toBe(true);
    expect(MOCK_IMPORT.test(`import type { X } from 'src/_mock';`)).toBe(true);
    expect(MOCK_IMPORT.test(`import { _mock } from '../../_mock/_mock';`)).toBe(true);
    expect(MOCK_IMPORT.test(`const m = import('src/_mock');`)).toBe(true);
    expect(MOCK_IMPORT.test(`import { x } from 'src/lib/pepefi/mockish';`)).toBe(false);
  });

  it('no production file imports src/_mock', () => {
    const offenders = files
      .filter((file) => MOCK_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('no production file carries the template demo persona', () => {
    const offenders = files
      .filter((file) => !path.relative(SRC, file).startsWith('locales'))
      .filter((file) => MOCK_PERSONA.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
