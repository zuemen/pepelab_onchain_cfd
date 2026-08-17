import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { countHan, findInlineDisplayStrings } from './scanDisplayStrings';

// ----------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '../..');

/**
 * 已經搬完的目錄。每完成一批就加一行。
 *
 * 這份清單是遷移能不能收斂的關鍵：沒有它，最後那 20% 永遠不會有人回頭做完，
 * 而已經搬好的目錄也會慢慢長回內嵌字串。
 */
const MIGRATED_DIRS: string[] = [
  // 'src/layouts',            ← nav 那批完成後解開
];

/**
 * `en` catalog 裡尚未翻譯的中文字數（不含註解）。
 *
 * 搬移階段兩份 catalog 寫入同一份原文，所以 `en` 一開始就帶著中文。這個數字**只能
 * 下降**：歸零代表英文版翻完了。目前的 12 個字來自 meta description。
 */
const EN_HAN_BASELINE = 12;

function sourceFilesUnder(dir: string): string[] {
  const abs = path.resolve(FRONTEND_ROOT, dir);
  if (!fs.existsSync(abs)) {
    return [];
  }
  return fs
    .readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(abs, rel))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => fs.statSync(file).isFile());
}

// ----------------------------------------------------------------------

describe('findInlineDisplayStrings', () => {
  it('flags Chinese text written straight into JSX', () => {
    const found = findInlineDisplayStrings('  return <Button>領取 mUSDC</Button>\n');
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(1);
  });

  it('flags a Chinese string passed as a prop', () => {
    const found = findInlineDisplayStrings('<Chip label="尚未部署" />\n');
    expect(found).toHaveLength(1);
  });

  it('does not flag a line comment', () => {
    // 中文註解是給開發者與 agent 看的文件，不是顯示字串——1,196 行都留在原地。
    expect(findInlineDisplayStrings('// 這一頁是最大的下單路徑\nconst x = 1\n')).toEqual([]);
  });

  it('does not flag a block comment spanning several lines', () => {
    const source = [
      '/**',
      ' * 開倉時間（unix 秒）。',
      ' * ESG 獎勵有最短持有期。',
      ' */',
      'const x = 1',
    ].join('\n');
    expect(findInlineDisplayStrings(source)).toEqual([]);
  });

  it('does not flag a trailing comment after real code', () => {
    expect(findInlineDisplayStrings('const [ammPrice] = useState(0n)   // 池內現價\n')).toEqual([]);
  });

  it('does not flag developer output sent to the console', () => {
    expect(findInlineDisplayStrings("console.warn('[prettyError] 認不出來的錯誤', err)\n")).toEqual(
      []
    );
  });

  it('reports the line number so a failure points at something', () => {
    const found = findInlineDisplayStrings('const a = 1\nconst b = 2\nconst c = "保證金不足"\n');
    expect(found).toEqual([{ line: 3, text: 'const c = "保證金不足"' }]);
  });
});

describe('countHan', () => {
  it('counts Han characters and ignores everything else', () => {
    expect(countHan('鏈上永續 + x402')).toBe(4);
    expect(countHan('PepeLab')).toBe(0);
  });
});

// ----------------------------------------------------------------------

describe('migration ratchets', () => {
  it('keeps every migrated directory free of inline display strings', () => {
    const offenders = MIGRATED_DIRS.flatMap((dir) =>
      sourceFilesUnder(dir).flatMap((file) =>
        findInlineDisplayStrings(fs.readFileSync(file, 'utf8')).map(
          (hit) => `${path.relative(FRONTEND_ROOT, file)}:${hit.line}  ${hit.text.trim()}`
        )
      )
    );

    expect(offenders).toEqual([]);
  });

  it('never lets the untranslated Chinese in the en catalog grow', () => {
    const remaining = sourceFilesUnder('src/locales/en')
      .flatMap((file) => findInlineDisplayStrings(fs.readFileSync(file, 'utf8')))
      .reduce((sum, hit) => sum + countHan(hit.text), 0);

    expect(remaining).toBeLessThanOrEqual(EN_HAN_BASELINE);
  });
});

describe('the html shell', () => {
  const html = fs.readFileSync(path.resolve(FRONTEND_ROOT, 'index.html'), 'utf8');

  it('takes its document language from the built locale', () => {
    expect(html).toContain('lang="%LOCALE_HTML_LANG%"');
  });

  it('takes its title and description from the catalog', () => {
    expect(html).toContain('%APP_TITLE%');
    expect(html).toContain('%APP_DESCRIPTION%');
  });

  it('holds no copy of the display strings itself', () => {
    expect(html).not.toContain('Agent-Native RWA Perpetuals');
    expect(html).not.toContain('鏈上永續');
  });
});
