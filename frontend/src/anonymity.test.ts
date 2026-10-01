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
 *  - `frontend/dist`（如果存在；CI 是先 build 再跑測試，所以 CI 上一定會掃到）
 *
 * 兩組樣式：
 *  - `SPECIFIC`：特定機構的名稱與縮寫。以 base64 存放，免得這個檔案自己變成來源。
 *    來源檔與 dist 都檢查。
 *  - `GENERIC`：泛稱（大學、學系、指導教授……）。只檢查我們自己的來源檔，不檢查 dist——
 *    打包進去的第三方套件的授權聲明裡會有這些字。
 *
 * 「Capstone project」這種不帶校名的寫法是允許的。
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const FRONTEND = path.resolve(SRC, '..');
const REPO = path.resolve(FRONTEND, '..');
const SELF = fileURLToPath(import.meta.url);

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

const SPECIFIC: RegExp[] = [
  'KD88IVtBLVphLXowLTkrLz1fLV0pbmNjdSg/IVtBLVphLXowLTkrLz1fLV0p',
  'Y2hlbmdbXHMtXT9jaGk=',
  '5pS/5rK75aSnW+WtuOWtpl0=',
  'KD88IVvosqHooYxdKeaUv+Wkpw==',
].map((b64) => new RegExp(decode(b64), 'i'));

const GENERIC: RegExp[] = [
  /\buniversity\b/i,
  /大學|大学/,
  /學系|系所/,
  /指導(?:教授|老師)/,
  /\bprofessor\b/i,
  /\.edu(?:\.[a-z]{2})?\b/i,
];

const TEXT_EXT = /\.(?:tsx?|jsx?|mjs|cjs|json|html?|css|svg|md|txt|xml|webmanifest|ya?ml|map)$/i;

function textFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => path.join(dir, rel))
    .filter((file) => TEXT_EXT.test(file) && file !== SELF)
    .filter((file) => fs.statSync(file).isFile());
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

function offenders(files: string[], patterns: RegExp[]): string[] {
  return files
    .filter((file) => patterns.some((re) => re.test(read(file))))
    .map((file) => path.relative(REPO, file));
}

describe('anonymous review: no institution identifiers in shipped content', () => {
  const sources = [
    ...textFilesUnder(SRC),
    ...textFilesUnder(path.join(FRONTEND, 'public')),
    path.join(FRONTEND, 'index.html'),
    ...textFilesUnder(path.join(REPO, 'web')),
    path.join(REPO, 'README.md'),
  ];
  const dist = textFilesUnder(path.join(FRONTEND, 'dist'));

  it('scans the app sources, the static site and the README', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain(path.join(REPO, 'web', 'index.html'));
    expect(sources).toContain(path.join(REPO, 'README.md'));
    for (const file of sources) expect(fs.existsSync(file), file).toBe(true);
  });

  it('the specific patterns catch the forms we care about', () => {
    const hit = (b64: string) => SPECIFIC.some((re) => re.test(decode(b64)));
    expect(hit('wqkgMjAyNiBQRVBFRkkgwrcgTkNDVSBDYXBzdG9uZQ==')).toBe(true);
    expect(hit('TmF0aW9uYWwgQ2hlbmdjaGkgVW5pdmVyc2l0eQ==')).toBe(true);
    expect(hit('bWFpbEBuY2N1LmVkdS50dw==')).toBe(true);
    expect(hit('5ZyL56uL5pS/5rK75aSn5a24')).toBe(true);
    expect(hit('5pS/5aSn5bCI6aGM')).toBe(true);

    const clean = (text: string) => !SPECIFIC.some((re) => re.test(text));
    expect(clean('© 2026 PEPEFI · Capstone project')).toBe(true);
    expect(clean('財政大臣、行政大樓')).toBe(true);
    expect(clean('const fnccuX = 1; "abnccu9"')).toBe(true);
  });

  it('the generic patterns catch the forms we care about', () => {
    const hit = (text: string) => GENERIC.some((re) => re.test(text));
    expect(hit('Some University Capstone')).toBe(true);
    expect(hit('某某大學資訊管理學系')).toBe(true);
    expect(hit('指導教授：某某')).toBe(true);
    expect(hit("the professor's requirement")).toBe(true);
    expect(hit('someone@example.edu.tw')).toBe(true);
    expect(hit('Capstone project, 2026')).toBe(false);
    expect(hit('education, reduce, credentials')).toBe(false);
  });

  it('no source file names a specific institution', () => {
    expect(offenders(sources, SPECIFIC)).toEqual([]);
  });

  it('no source file names a university, department or advisor', () => {
    expect(offenders(sources, GENERIC)).toEqual([]);
  });

  it('the built site (when present) names no specific institution', () => {
    expect(offenders(dist, SPECIFIC)).toEqual([]);
  });
});
