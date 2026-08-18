import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { countHan, findInlineDisplayStrings } from './scanDisplayStrings';

// ----------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '../..');

/**
 * 已經搬完的目錄或單一檔案。每完成一批就加一行。
 *
 * 這份清單是遷移能不能收斂的關鍵：沒有它，最後那 20% 永遠不會有人回頭做完，
 * 而已經搬好的地方也會慢慢長回內嵌字串。
 *
 * 收單一檔案而不只收目錄，是因為批次是按功能切的、目錄不是：`src/layouts` 底下的
 * nav 設定搬完時，同目錄的 layout 元件還沒搬。只能寫目錄的話，這一批就得整個
 * `src/layouts` 一起動，或者乾等到最後才有任何東西受到保護。
 */
const MIGRATED_PATHS: string[] = [
  'src/layouts/nav-config-dashboard.tsx',
  'src/layouts/nav-config-account.tsx',
  'src/lib/pepefi/errorMessages.ts',
  'src/lib/pepefi/priceFreshness.ts',
  'src/components/pepefi/dashboard',
  'src/pages/pepefi/PortfolioPage.tsx',
  'src/lib/pepefi/openPositionColumns.ts',
  'src/sections/terminal',
  // 這三個不在 terminal 目錄底下，但它們產出的字只在終端機畫面上出現：
  // K 線 API 的錯誤、成交紀錄讀取失敗、模擬報價的價齡標籤。
  'src/lib/pepefi/candles.ts',
  'src/hooks/useUserFills.ts',
  'src/hooks/useLivePrices.ts',
  'src/pages/pepefi/AdminOraclePage.tsx',
  'src/pages/pepefi/AdminTreasuryPage.tsx',
  'src/pages/pepefi/AgentMonitorPage.tsx',
  'src/components/pepefi/pepeSkinsData.ts',
  'src/components/pepefi/pepeStageSkinsData.ts',
  'src/components/pepefi/pepeMountsData.ts',
  'src/lib/pepefi/achievements.ts',
  'src/lib/pepefi/whale.ts',
  'src/pages/pepefi/WhaleTrackerPage.tsx',
  // WhaleFeed 少一個：simple 模式把一筆交易寫成一句話，中間夾了三段標記，
  // 那一句留給 #36，所以這個檔案還不算搬完。
  'src/components/pepefi/whale/WhaleKpiRow.tsx',
  'src/components/pepefi/whale/WhaleTagChips.tsx',
  'src/components/pepefi/whale/MarketSentimentBar.tsx',
  'src/components/pepefi/whale/LargestOpenPositions.tsx',
  'src/pages/pepefi/RewardsPage.tsx',
  'src/pages/pepefi/ESGPage.tsx',
  'src/components/pepefi/WalletButton.tsx',
  'src/components/pepefi/ToastProvider.tsx',
  'src/components/pepefi/PaperTradingBadge.tsx',
  'src/components/pepefi/PepeAvatarPicker.tsx',
  'src/lib/pepefi/tokenLabel.ts',
  'src/utils/pepefi-assets.ts',
  'src/layouts/dashboard/layout.tsx',
  'src/layouts/components/account-drawer.tsx',
  'src/components/pepefi/KYCModal.tsx',
  'src/components/pepefi/PepeEvolution.tsx',
];

/**
 * `en` catalog 裡尚未翻譯的中文字數（不含註解）。
 *
 * 搬移階段兩份 catalog 寫入同一份原文，所以 `en` 一開始就帶著中文。這個數字**只能
 * 下降**：歸零代表英文版翻完了。
 *
 * 每批遷移都會把它推高——那是預期行為，不是退步：字串搬進 catalog 時 `en` 拿到的是
 * 中文原文。真正的退步是「翻譯過的字又變回中文」，而那會讓這條斷言失敗。
 * 目前：errors 1388、pepe 1386、terminal 685、exchange 643、admin 491、
 * pepeStageSkins 264、landing 215、sessions 207、x402 207、common 185、freshness 146、rewards 102、esg 42、nav 38、meta 12、portfolio 4。
 */
const EN_HAN_BASELINE = 6704;

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

describe('migration ratchets', () => {
  it('keeps everything already migrated free of inline display strings', () => {
    const offenders = MIGRATED_PATHS.flatMap((migrated) =>
      sourceFilesIn(migrated).flatMap((file) =>
        findInlineDisplayStrings(fs.readFileSync(file, 'utf8'))
          .filter((hit) => !isAssetPathOnly(hit.text))
          .map((hit) => `${path.relative(FRONTEND_ROOT, file)}:${hit.line}  ${hit.text.trim()}`)
      )
    );

    expect(offenders).toEqual([]);
  });

  it('still flags a display string sitting next to an asset path', () => {
    const line = `  { image: '/skins/03_忍者蛙戰士.png', name: '暗影忍者蛙戰士' },`;
    expect(isAssetPathOnly(line)).toBe(false);
    expect(isAssetPathOnly(`  imagePath: '/skins/03_忍者蛙戰士.png',`)).toBe(true);
  });

  it('never lets the untranslated Chinese in the en catalog grow', () => {
    const remaining = sourceFilesIn('src/locales/en')
      .flatMap((file) => findInlineDisplayStrings(fs.readFileSync(file, 'utf8')))
      .reduce((sum, hit) => sum + countHan(hit.text), 0);

    expect(remaining).toBeLessThanOrEqual(EN_HAN_BASELINE);
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
