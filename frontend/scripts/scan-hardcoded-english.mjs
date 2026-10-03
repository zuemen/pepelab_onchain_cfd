#!/usr/bin/env node
/**
 * 找出 JSX 裡直接寫死、沒有經過 i18n catalog 的英文顯示字串。
 *
 *   node scripts/scan-hardcoded-english.mjs [--json] [路徑前綴 ...]
 *
 * 掃的是「畫面上會被讀到的」三種位置：
 *   1. JSX 文字節點：<Button>Connect Wallet</Button>
 *   2. 顯示用屬性的字串字面值：label="…" title="…" placeholder="…" aria-label="…" alt="…"
 *   3. JSX 大括號裡直接寫的字串：{'Loading…'}、{cond ? 'Yes' : 'No'}
 *
 * 只抓含兩個以上連續英文字母的字串。純符號、數字、單一字母（x、×）、以及下面
 * ALLOW 列的協定／產品／代號（USDC、ERC-8126、x402…）不算漏翻——它們在中文介面
 * 本來就寫英文，見 frontend/docs/adr 的 ADR-0002。
 *
 * 這是給人看的清單，不是 lint 規則：靜態掃描分不出「顯示文字」與「刻意保留的英文
 * 標示」，所以結果要逐條判斷。只在開發時跑，不進 bundle、不進測試。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const prefixes = args.filter((a) => !a.startsWith('--'));

const DISPLAY_ATTRS = new Set([
  'label',
  'title',
  'placeholder',
  'aria-label',
  'alt',
  'helperText',
  'tooltip',
  'subheader',
  'primary',
  'secondary',
  'description',
  'emptyText',
]);

// 中文介面裡本來就寫英文的詞：代號、協定、單位、品牌。整串去掉這些詞後若已沒有
// 兩個以上連續的英文字母，就不列出來。
const ALLOW = [
  /\b0x[0-9a-fA-F]*\b/g,
  /\bs[A-Z]{2,6}\b/g, // sETH、sAAPL…（合成資產代號）
  /\b(USDC|USDT|USD|ETH|BTC|PEPE|APY|APR|TVL|PnL|PNL|OI|KYC|VC|DID|SSI|LP|AMM|RWA|ESG|ADL|RPC|API|URL|JSON|ID|NFT|EOA|TX|UTC|bps|BPS)\b/g,
  /\b(ERC-?\d+|EIP-?\d+|x402|X402|vLEI|MetaMask|Base Sepolia|Base|Sepolia|Ethereum|Coinbase|CoinGecko|Yahoo Finance|GitHub|BaseScan|Etherscan|Telegram|Agent|agent|Session|session|Oracle|oracle|Dashboard|Gas|gas|mark|index|PERP)\b/g,
  /\b(AAA|AA|A|BBB|BB|B|CCC)\b/g, // ESG 等級
  /\b\d+(\.\d+)?\s*(x|×|h|m|s|d|ms|bps|%)\b/g,
];

const isEnglishLeft = (text) => {
  let rest = text;
  for (const re of ALLOW) rest = rest.replace(re, ' ');
  return /[A-Za-z]{2,}/.test(rest);
};

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__fixtures__') continue;
      yield* walkFiles(full);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
      yield full;
    }
  }
}

const hits = [];

function report(sf, node, kind, text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || !isEnglishLeft(clean)) return;
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  hits.push({
    file: path.relative(ROOT, sf.fileName).split(path.sep).join('/'),
    line: line + 1,
    kind,
    text: clean,
  });
}

/** 一個運算式底下「會直接被 render 成文字」的字串字面值。 */
function collectRenderedStrings(expr, out) {
  if (!expr) return;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    out.push(expr);
  } else if (ts.isTemplateExpression(expr)) {
    out.push(expr);
  } else if (ts.isConditionalExpression(expr)) {
    collectRenderedStrings(expr.whenTrue, out);
    collectRenderedStrings(expr.whenFalse, out);
  } else if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    collectRenderedStrings(expr.right, out);
  } else if (ts.isParenthesizedExpression(expr)) {
    collectRenderedStrings(expr.expression, out);
  }
}

const literalText = (node) => {
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  }
  return node.text;
};

for (const file of walkFiles(SRC)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (prefixes.length && !prefixes.some((p) => rel.startsWith(p))) continue;

  const sf = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      report(sf, node, 'text', node.text);
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (DISPLAY_ATTRS.has(name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          report(sf, node, `attr:${name}`, node.initializer.text);
        } else if (ts.isJsxExpression(node.initializer)) {
          const lits = [];
          collectRenderedStrings(node.initializer.expression, lits);
          for (const lit of lits) report(sf, lit, `attr:${name}`, literalText(lit));
        }
      }
      return; // 其餘屬性（sx、className、href…）不是顯示文字
    } else if (
      ts.isJsxExpression(node) &&
      node.parent &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const lits = [];
      collectRenderedStrings(node.expression, lits);
      for (const lit of lits) report(sf, lit, 'expr', literalText(lit));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (asJson) {
  process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
} else {
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    process.stdout.write(`\n${file} (${list.length})\n`);
    for (const h of list) process.stdout.write(`  ${h.line}\t[${h.kind}]\t${h.text}\n`);
  }
  process.stdout.write(`\n共 ${hits.length} 處，${byFile.size} 個檔案\n`);
}
