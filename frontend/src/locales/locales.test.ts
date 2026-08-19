import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { countHan, findInlineDisplayStrings } from './scanDisplayStrings';

// ----------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '../..');

/**
 * #37：全樹掃描取代了原本「已搬完目錄」的白名單（`MIGRATED_PATHS`）。掃描範圍是
 * 整個 `src`，扣掉 catalog 本身（`src/locales/{zh-TW,en}` 就是中文原文與英文譯文
 * 住的地方，不是漏搬的顯示字串）與測試檔。
 */
function allSourceFiles(): string[] {
  const root = path.resolve(FRONTEND_ROOT, 'src');
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(root, rel))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => fs.statSync(file).isFile())
    .filter((file) => {
      const rel = path.relative(FRONTEND_ROOT, file).split(path.sep).join('/');
      return !rel.startsWith('src/locales/');
    });
}

/**
 * `en` catalog 裡尚未翻譯的中文字數（不含註解），每個檔案各自的天花板。
 *
 * #41 把翻譯拆成十幾張各自獨立的票，同時動工。天花板原本是單一總數，兩張票的
 * PR 會在同一行上衝突，而且誰都無法只憑這個數字證明「我的檔案真的翻完了」——
 * 別的檔案還沒動的空間會被這張票的進度借走，遮住了真正的退步。改成逐檔案的
 * 天花板後，每張票只動自己名下那一行，退步只會讓那一個檔案的斷言失敗，不會
 * 被別的檔案沖銷掉。
 *
 * 數字全部用下面斷言同一套 `findInlineDisplayStrings` + `countHan` 現場重算——
 * 不是抄 #41 issue 原本的表格，那張表在開票時就已經跟原始碼脫勾（詳見 #41 的
 * 更新記錄）。0 代表這個檔案已經翻完，之後只能維持 0，不能再上升。
 *
 * 不在這份清單裡的檔案，天花板視為 0：新增一個 catalog 檔案時，要嘛它一開始
 * 就不帶中文，要嘛得先在這裡登記非零的天花板，否則會立刻讓 ratchet 失敗。
 */
const EN_HAN_BASELINES: Record<string, number> = {
  'errors.ts': 0,
  'pepe.ts': 1370,
  'exchange.ts': 0,
  'terminal.ts': 0,
  'sessions.ts': 657,
  'pepelab.ts': 555,
  'tokens.ts': 543,
  'admin.ts': 486,
  'landing.ts': 327,
  'kyc.ts': 319,
  'pepeStageSkins.ts': 264,
  'x402.ts': 251,
  'stake.ts': 236,
  'copy.ts': 122,
  'rewards.ts': 102,
  'esg.ts': 36,
  'marketplace.ts': 13,
  'common.ts': 0,
  'freshness.ts': 0,
  'history.ts': 0,
  'index.ts': 0,
  'meta.ts': 0,
  'nav.ts': 0,
  'portfolio.ts': 0,
  'traderDashboard.ts': 0,
  'traderProfile.ts': 0,
  'vault.ts': 0,
  'whale.ts': 0,
};

/** 傳目錄就回它底下所有原始碼檔案，傳單一檔案就回那一個。測試檔一律排除。 */
function sourceFilesIn(pathish: string): string[] {
  const abs = path.resolve(FRONTEND_ROOT, pathish);
  if (!fs.existsSync(abs)) {
    return [];
  }
  if (fs.statSync(abs).isFile()) {
    return [abs];
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

/**
 * 唯一的例外：中文只出現在檔案路徑裡的那一行。
 *
 * 造型資料表指向的圖檔就叫 `/skins/03_忍者蛙戰士.png`——那是磁碟上的檔名，不是
 * 使用者讀的字；改它要連同 `public/` 底下的檔案一起改名，跟這次遷移無關。
 *
 * 例外寫成「條件」而不是「某檔案某行」是刻意的：寫成行號，檔案一動就過期；寫成
 * 整個檔案豁免，就等於那個檔案退出 ratchet。這條規則只放行資產路徑，其他任何
 * 中文照樣會失敗。
 */
const ASSET_PATH = /['"`]\/[^'"`]*\.(png|jpe?g|webp|svg|gif)['"`]/;

function isAssetPathOnly(line: string): boolean {
  return ASSET_PATH.test(line) && countHan(line.replace(new RegExp(ASSET_PATH, 'g'), '')) === 0;
}

/**
 * #37：全樹掃描下僅存的合法例外，一條一條列出來，各自附理由。
 *
 * 用「檔案 + 該行要包含的片段」比對，不用行號——行號會隨著檔案編輯漂移，
 * 例外會悄悄失效（漏放行別的中文）或跟丟原本要放行的那一行。新增例外前
 * 先確認真的沒有更好的做法：能搬進 catalog 的都該搬，這份清單只留給搬不動的。
 */
const LINE_EXCEPTIONS: { file: string; contains: string; reason: string }[] = [
  {
    file: 'src/pages/pepefi/X402DocsPage.tsx',
    contains: '只依賴 viem + x402-fetch',
    reason:
      '可複製貼上的 npx 範例裡的 shell 註解，逐字保留才能貼了就跑；是程式碼，不是顯示文字。',
  },
  {
    file: 'src/pages/pepefi/X402DocsPage.tsx',
    contains: '持 Circle USDC + 一點 ETH',
    reason: '同一段 npx 範例裡的第二個 shell 註解，理由同上。',
  },
];

function isLineException(file: string, text: string): boolean {
  const rel = path.relative(FRONTEND_ROOT, file).split(path.sep).join('/');
  return LINE_EXCEPTIONS.some((exc) => exc.file === rel && text.includes(exc.contains));
}

describe('migration ratchets', () => {
  it('keeps the whole source tree free of inline display strings', () => {
    const offenders = allSourceFiles().flatMap((file) =>
      findInlineDisplayStrings(fs.readFileSync(file, 'utf8'))
        .filter((hit) => !isAssetPathOnly(hit.text))
        .filter((hit) => !isLineException(file, hit.text))
        .map((hit) => `${path.relative(FRONTEND_ROOT, file)}:${hit.line}  ${hit.text.trim()}`)
    );

    expect(offenders).toEqual([]);
  });

  it('still flags a display string sitting next to an asset path', () => {
    const line = `  { image: '/skins/03_忍者蛙戰士.png', name: '暗影忍者蛙戰士' },`;
    expect(isAssetPathOnly(line)).toBe(false);
    expect(isAssetPathOnly(`  imagePath: '/skins/03_忍者蛙戰士.png',`)).toBe(true);
  });

  it('never lets the untranslated Chinese in any en catalog file grow', () => {
    const offenders = sourceFilesIn('src/locales/en').flatMap((file) => {
      const name = path.basename(file);
      const remaining = findInlineDisplayStrings(fs.readFileSync(file, 'utf8')).reduce(
        (sum, hit) => sum + countHan(hit.text),
        0
      );
      const baseline = EN_HAN_BASELINES[name] ?? 0;

      return remaining > baseline ? [`${name}: ${remaining} Han chars, baseline is ${baseline}`] : [];
    });

    expect(offenders).toEqual([]);
  });
});

describe('the html shell', () => {
  const html = fs.readFileSync(path.resolve(FRONTEND_ROOT, 'index.html'), 'utf8');

  it('takes its document language from the built locale', () => {
    expect(html).toContain('lang="__LOCALE_HTML_LANG__"');
  });

  it('takes its title and description from the catalog', () => {
    expect(html).toContain('__APP_TITLE__');
    expect(html).toContain('__APP_DESCRIPTION__');
  });

  it('holds no copy of the display strings itself', () => {
    expect(html).not.toContain('Agent-Native RWA Perpetuals');
    expect(html).not.toContain('鏈上永續');
  });
});
