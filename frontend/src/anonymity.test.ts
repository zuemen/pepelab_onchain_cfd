import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

// ----------------------------------------------------------------------

/**
 * 回歸護欄：會被部署或繳交的內容，不得出現能辨識所屬學校、系所或指導者的字樣。
 *
 * 展示站會被拿去參加匿名審查的競賽。這個測試掃：
 *  - `frontend/src`、`frontend/public`、`frontend/index.html`（展示站的來源）
 *  - `web/`（靜態介紹頁）
 *  - 根目錄 `README.md`
 *  - `docs/`（繳交資料會連到 repo；`docs/commercial` 與 `docs/review` 不在 repo 內，
 *    本機若有也整個跳過，不走訪、不讀取）
 *  - `frontend/dist`（本機不存在就略過；CI 是先 build 再跑測試，所以 CI 上必須掃得到檔案）
 *
 * **這個護欄不涵蓋 git 歷史與 commit metadata。** 它只看工作目錄裡的檔案內容；舊 commit 的
 * 內容、commit 的作者與提交者信箱、貢獻者的帳號名稱都不在掃描範圍內，要另外處理。
 *
 * 三組樣式：
 *  - `SPECIFIC_SOURCE`：特定機構的名稱與縮寫，用在來源檔與 `docs/`。縮寫前後只要不是英文字母
 *    就算命中（接底線、連字號、數字、斜線都抓）。
 *  - `SPECIFIC_DIST`：同一組，但縮寫前後另外排除 base64 與識別字會用到的字元——打包檔裡
 *    有壓縮後的識別字與內嵌資料，寬鬆版會誤擋。
 *  - `GENERIC`：泛稱（大學、學系、指導教授……）。只檢查展示站與介紹頁的來源檔。不檢查 dist
 *    （打包進去的第三方套件的授權聲明裡會有這些字），也不檢查 `docs/`（設計文件會引用
 *    學術來源，舊的計畫檔名也帶泛稱）。
 *
 * 特定機構的樣式與命中樣本都以 base64 存放，免得這個檔案自己變成來源。
 * 「Capstone project」這種不帶校名的寫法是允許的。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const FRONTEND = path.resolve(SRC, '..');
const REPO = path.resolve(FRONTEND, '..');
const SELF = fileURLToPath(import.meta.url);

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');
const pattern = (b64: string): RegExp => new RegExp(decode(b64), 'i');

/** 縮寫以外的樣式：羅馬拼音的完整校名、中文全名、中文簡稱（只在不屬於其他詞的位置）。 */
const SPECIFIC_COMMON: RegExp[] = [
  'Y2hlbmdjaGkoPyFbYS16XSl8Y2hlbmdbXHMtXWNoaVxzK3VuaXY=',
  '5pS/5rK7XHMq5aSnW+WtuOWtpl0=',
  'KD88IVvjkIAt6b+/XSnmlL/lpKd8KD88PeWci+eri3zlsLHoroB85L6G6IeqfFvlnKjmlrzmmK/oiIflkozlj4pdKeaUv+Wkpw==',
].map(pattern);

const SPECIFIC_SOURCE: RegExp[] = [
  pattern('KD88IVtBLVphLXpdKW5jY3UoPyFbQS1aYS16XSk='),
  ...SPECIFIC_COMMON,
];

const SPECIFIC_DIST: RegExp[] = [
  pattern('KD88IVtBLVphLXowLTkrLz1fLV0pbmNjdSg/IVtBLVphLXowLTkrLz1fLV0p'),
  ...SPECIFIC_COMMON,
];

/**
 * 特定機構樣式必含的字面片段（小寫），同樣以 base64 存放。先用 `includes` 篩一次，
 * 有片段的檔案才跑正規表示式——lookbehind 在幾 MB 的打包檔上很慢。
 */
const SPECIFIC_NEEDLES: string[] = ['bmNjdQ==', 'Y2hlbmc=', '5pS/5rK7', '5pS/5aSn'].map(decode);

const GENERIC: RegExp[] = [
  /\buniversity\b/i,
  /大學|大学/,
  /學系|系所/,
  /指導(?:教授|老師)/,
  /\bprofessor\b/i,
  /\.edu(?:\.[a-z]{2})?\b/i,
];

const TEXT_EXT = /\.(?:tsx?|jsx?|mjs|cjs|json|html?|css|svg|md|txt|csv|xml|webmanifest|ya?ml|map)$/i;

/** `docs/` 底下不走訪的目錄（相對於 `docs/`）。 */
const DOCS_SKIP = new Set(['commercial', 'review']);

function textFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(dir, rel))
    .filter((file) => TEXT_EXT.test(file) && file !== SELF)
    .filter((file) => fs.statSync(file).isFile());
}

/** 逐層走訪 `docs/`；`DOCS_SKIP` 的目錄在最上層就跳過，連目錄內容都不列。 */
function docsTextFiles(dir: string, top = true): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return top && DOCS_SKIP.has(entry.name) ? [] : docsTextFiles(full, false);
    }
    return entry.isFile() && TEXT_EXT.test(entry.name) ? [full] : [];
  });
}

const cache = new Map<string, string>();

function read(file: string): string {
  let text = cache.get(file);
  if (text === undefined) {
    text = fs.readFileSync(file, 'utf8');
    cache.set(file, text);
  }
  return text;
}

function matches(text: string, patterns: RegExp[]): boolean {
  if (patterns !== GENERIC) {
    const lower = text.toLowerCase();
    if (!SPECIFIC_NEEDLES.some((needle) => lower.includes(needle))) return false;
  }
  return patterns.some((re) => re.test(text));
}

function offenders(files: string[], patterns: RegExp[]): string[] {
  return files
    .filter((file) => matches(read(file), patterns))
    .map((file) => path.relative(REPO, file));
}

// 這組測試同步掃整個檔案樹，Windows 開發機在負載下要 3～17 秒。vitest 2 不對同步測試計時，
// vitest 4 會在同步測試結束後比對耗時、超過 testTimeout（預設 5 秒）就判失敗，所以在這裡明確給
// 60 秒上限：不讓機器負載決定結果，真正卡住時仍會失敗。
const SCAN = { timeout: 60_000 };
describe('anonymous review: no institution identifiers in shipped content', SCAN, () => {
  const sources = [
    ...textFilesUnder(SRC),
    ...textFilesUnder(path.join(FRONTEND, 'public')),
    path.join(FRONTEND, 'index.html'),
    ...textFilesUnder(path.join(REPO, 'web')),
    path.join(REPO, 'README.md'),
  ];
  const docs = docsTextFiles(path.join(REPO, 'docs'));
  const dist = textFilesUnder(path.join(FRONTEND, 'dist'));

  it('scans the app sources, the static site and the README', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain(path.join(REPO, 'web', 'index.html'));
    expect(sources).toContain(path.join(REPO, 'README.md'));
    for (const file of sources) expect(fs.existsSync(file), file).toBe(true);
  });

  it('the specific patterns catch the forms we care about', () => {
    const everywhere = [
      'wqkgMjAyNiBQRVBFRkkgwrcgTkNDVSBDYXBzdG9uZQ==',
      'TmF0aW9uYWwgQ2hlbmdjaGkgVW5pdmVyc2l0eQ==',
      'TmF0aW9uYWwgQ2hlbmctQ2hpIFVuaXZlcnNpdHk=',
      'Q2hlbmcgQ2hpIFVuaXZlcnNpdHk=',
      'bWFpbEBuY2N1LmVkdS50dw==',
      '5ZyL56uL5pS/5rK75aSn5a24',
      '5pS/5rK7IOWkp+WtuA==',
      '5pS/5aSn5bCI6aGM',
      '5bCx6K6A5pS/5aSn6LOH566h',
      '5ZyL56uL5pS/5aSn',
      '5L6G6Ieq5pS/5aSn55qE5ZyY6ZqK',
      'Q2Fwc3RvbmXvvIjmlL/lpKfvvIk=',
    ].map(decode);
    for (const text of everywhere) {
      expect(matches(text, SPECIFIC_SOURCE), text).toBe(true);
      expect(matches(text, SPECIFIC_DIST), text).toBe(true);
    }

    // 縮寫接底線、連字號、數字：來源檔與 docs 用的寬鬆版要抓得到。
    const looseOnly = [
      'TkNDVV9DYXBzdG9uZV8yMDI2',
      'TkNDVS1DYXBzdG9uZQ==',
      'TkNDVTIwMjY=',
      'Z2l0aHViLmNvbS9uY2N1LWxhYg==',
    ].map(decode);
    for (const text of looseOnly) expect(matches(text, SPECIFIC_SOURCE), text).toBe(true);
  });

  it('the specific patterns leave ordinary text alone', () => {
    const ordinary = [
      '© 2026 PEPEFI · Capstone project',
      '財政大臣、行政大樓、市政大樓、郵政大樓、施政大綱',
      '內政大、憲政大、執政大、攝政大臣、黨政大老',
      'Cheng chief', 'Cheng China', 'cheng-chih', 'chengchih',
      'accuracy, unccurled, Hanccuk',
    ];
    for (const text of ordinary) {
      expect(matches(text, SPECIFIC_SOURCE), text).toBe(false);
      expect(matches(text, SPECIFIC_DIST), text).toBe(false);
    }
    // 打包檔裡壓縮過的識別字與內嵌資料：只有嚴格版需要放行。
    expect(matches('const f_nccu9 = 1; "ab+nccu/9"', SPECIFIC_DIST)).toBe(false);
  });

  it('the generic patterns catch the forms we care about', () => {
    const hit = (text: string) => matches(text, GENERIC);
    expect(hit('Some University Capstone')).toBe(true);
    expect(hit('某某大學資訊管理學系')).toBe(true);
    expect(hit('指導教授：某某')).toBe(true);
    expect(hit("the professor's requirement")).toBe(true);
    expect(hit('someone@example.edu.tw')).toBe(true);
    expect(hit('Capstone project, 2026')).toBe(false);
    expect(hit('education, reduce, credentials')).toBe(false);
  });

  it('no source file names a specific institution', () => {
    expect(offenders(sources, SPECIFIC_SOURCE)).toEqual([]);
  });

  it('no source file names a university, department or advisor', () => {
    expect(offenders(sources, GENERIC)).toEqual([]);
  });

  it('scans docs/ but never the directories that are kept out of the repo', () => {
    expect(docs.length).toBeGreaterThan(30);
    const rel = docs.map((file) => path.relative(path.join(REPO, 'docs'), file).split(path.sep)[0]);
    expect(rel.filter((first) => DOCS_SKIP.has(first))).toEqual([]);
  });

  it('no file under docs/ names a specific institution', () => {
    expect(offenders(docs, SPECIFIC_SOURCE)).toEqual([]);
  });

  it('on CI the built site is there to be scanned', () => {
    // CI 是先 build 再跑測試。dist 掃不到檔案代表流程順序被改掉了，下一項會空過。
    if (process.env.CI) expect(dist.length).toBeGreaterThan(0);
  });

  it('the built site (when present) names no specific institution', () => {
    expect(offenders(dist, SPECIFIC_DIST)).toEqual([]);
  });
});
