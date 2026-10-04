#!/usr/bin/env node
// 部署狀態檢查器：鏈上跑的是不是 master 的原始碼？關鍵角色是不是還在已知外洩地址手上？
//
// 為什麼存在：這個 repo 過去三度把「完成」說錯——把「已合併」當成「已完成」、把計畫項目
// 標成已完成、對外文件的數字過期。合併只代表原始碼改了；鏈上合約不會因為 PR 合併而改變，
// 使用者碰到的永遠是鏈上那一版。這支腳本把「已合併」與「已部署、鏈上一致、展示驗收過」
// 分開量，產生 docs/RELEASE_STATUS.md 與 docs/release-status.json，不手寫任何數字。
//
// 比對方法（沿用 contracts/script/VerifyTenant.s.sol 的 _verifyRuntimeCode，不另外發明）：
//   - 鏈上 runtime code 必須與 contracts/out 產物的 deployedBytecode.object 等長；
//   - library 位置（linkReferences）：同一個 library 的所有位置必須是同一個位址，遮蔽後
//     再以同樣方法比對該 library 自己的產物（library 的 call guard immutable 釘成它自己的位址）；
//   - immutable（immutableReferences）：建構時才決定，遮蔽；但同一個 immutable 的每個位置
//     必須是同一個值；
//   - 結尾的 CBOR metadata（長度取自產物最後兩個 byte）：雜湊的是原始碼文字，只改註解也會變，
//     而且永遠不會被執行——只比它之前的部分，metadata 不同時另外註記。
//   UUPS proxy（EIP-1967 實作 slot）比對的是實作；元件可列多個候選產物（例如 AssetVaultV2_5…V2），
//   鏈上符合舊版候選就明確指出是哪一版。
//
// 三種結果：
//   equal   鏈上＝原始碼           遮蔽後與 master 的編譯產物一致
//   behind  原始碼較新（待部署）   與 master 的編譯產物不一致（舊版原始碼，或舊的編譯設定）
//   unknown 無法比對               沒有產物、鏈上沒有程式碼、proxy 沒有實作、RPC 失敗
// 以及 not-deployed（前端設定的位址是 0x0）與 same-as（與前一個元件同一個位址）。
//
// 外洩地址名單不在這裡維護：從 agent/shared/src/payoutSafety.ts 的 COMPROMISED_ADDRESSES 讀
// （x402 收款安全檢查用的同一份）。輸出裡外洩地址一律只寫縮寫。
//
// 只用 eth_chainId／eth_blockNumber／eth_getCode／eth_getStorageAt／eth_call，全部釘在同一個
// 區塊；不送交易、不需要任何金鑰。
//
// 用法：
//   node scripts/check-deployment-status.mjs              # 唯讀連網，寫 docs/RELEASE_STATUS.md 與 docs/release-status.json
//   node scripts/check-deployment-status.mjs --stdout     # 同上但只印 markdown，不寫檔
//   node scripts/check-deployment-status.mjs --chain 84532 --rpc 84532=https://…
//   node scripts/check-deployment-status.mjs --offline    # CI：只檢查設定一致性，不連網、不需要 forge build
//   node scripts/check-deployment-status.mjs --refresh-acceptance
//                                                         # 不連網：把 components.json 的展示驗收重新套進現有報告並重新渲染
//   需要先 `cd contracts && forge build`（產物在 contracts/out）。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseFrontendConfig } from "./check-addresses.mjs";
import { keccak256, selector } from "../ops/monitoring/keccak.mjs";

export const COMPONENTS_FILE = "ops/release-status/components.json";
export const DEPLOYED_SNAPSHOT = "ops/monitoring/deployed.json";
export const REPORT_MD = "docs/RELEASE_STATUS.md";
export const REPORT_JSON = "docs/release-status.json";
export const ADDRESSES_FILE = "frontend/src/contracts/addresses.ts";
export const SESSION_FILE = "frontend/src/contracts/sessionManager.ts";
export const X402_FILE = "frontend/src/contracts/x402.ts";
export const PRIMARY_CHAIN = "84532";
/** EIP-1967 implementation slot（與 ops/monitoring/engine.mjs 的 IMPL_SLOT 相同）。 */
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ZERO = "0x0000000000000000000000000000000000000000";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const FN_SIG = /^[A-Za-z_][A-Za-z0-9_]*\((?:[a-z0-9]+(?:,[a-z0-9]+)*)?\)$/;
const ROLE = /^[A-Z][A-Z0-9_]*_ROLE$/;
const ARTIFACT = /^[A-Za-z0-9_]+\.sol:[A-Za-z0-9_]+$/;

export const STATUS_TEXT = {
  equal: "鏈上＝原始碼",
  behind: "原始碼較新（待部署）",
  unknown: "無法比對",
  "not-deployed": "未部署",
  "same-as": "同一位址",
};
export const ACCEPTANCE_STATUSES = ["已驗收", "部分驗收", "未驗收"];

const lc = (s) => String(s).toLowerCase();
export const shortAddr = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;
const wordToAddr = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0").slice(-40);
const pad32 = (hex) => String(hex).replace(/^0x/, "").toLowerCase().padStart(64, "0");

// ── 設定解析 ─────────────────────────────────────────────────────────────────

/** 外洩地址名單：`export const COMPROMISED_ADDRESSES … = [ "0x…", … ]` 的位址（小寫）。 */
export function parseDenylist(src, exportName = "COMPROMISED_ADDRESSES") {
  const i = src.indexOf(`export const ${exportName}`);
  if (i < 0) throw new Error(`找不到 export const ${exportName}`);
  const open = src.indexOf("[", src.indexOf("=", i));
  const close = src.indexOf("]", open);
  if (open < 0 || close < 0) throw new Error(`${exportName} 不是陣列字面值`);
  const body = src.slice(open, close).replace(/\/\/.*$/gm, "");
  const out = [...body.matchAll(/["'](0x[0-9a-fA-F]{40})["']/g)].map((m) => lc(m[1]));
  if (out.length === 0) throw new Error(`${exportName} 是空的——名單讀錯會讓檢查無聲通過`);
  return [...new Set(out)];
}

/** `{` 起到對應 `}` 的內容（不含外層括號）。 */
function braceBody(src, open) {
  if (open < 0 || src[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

function chainBlock(body, chainId) {
  const j = body?.search(new RegExp(`\\b${chainId}\\s*:\\s*\\{`));
  if (j === undefined || j < 0) return null;
  return braceBody(body, body.indexOf("{", j));
}

const pairsOf = (block) =>
  Object.fromEntries([...(block ?? "").replace(/\/\/.*$/gm, "").matchAll(/([A-Za-z0-9_]+)\s*:\s*["'](0x[0-9a-fA-F]{40})["']/g)].map((m) => [m[1], m[2]]));

/** 代幣群組：{ [chainId]: { SYNTH_TOKENS: {sym: addr}, "V2_STACK.tokens": {sym: addr} } }。 */
export function parseTokenGroups(addressesSrc, chainIds) {
  const out = {};
  const valueBody = (marker) => {
    const i = addressesSrc.indexOf(marker);
    if (i < 0) return null;
    return braceBody(addressesSrc, addressesSrc.indexOf("{", addressesSrc.indexOf("= {", i)));
  };
  const synth = valueBody("export const SYNTH_TOKENS");
  const v2 = valueBody("export const V2_STACK");
  for (const id of chainIds) {
    const groups = {};
    groups.SYNTH_TOKENS = pairsOf(chainBlock(synth, id));
    const v2chain = chainBlock(v2, id);
    const t = v2chain?.search(/\btokens\s*:\s*\{/);
    groups["V2_STACK.tokens"] = t !== undefined && t >= 0 ? pairsOf(braceBody(v2chain, v2chain.indexOf("{", t))) : {};
    out[id] = groups;
  }
  return out;
}

export function loadSources(root) {
  const read = (f) => readFileSync(join(root, f), "utf8");
  const cfg = JSON.parse(read(COMPONENTS_FILE));
  const addressesSrc = read(ADDRESSES_FILE);
  const frontend = parseFrontendConfig(addressesSrc, read(SESSION_FILE), read(X402_FILE));
  const tokens = parseTokenGroups(addressesSrc, Object.keys(cfg.chains));
  const denylist = parseDenylist(read(cfg.denylist.file), cfg.denylist.export);
  const snapshotFile = join(root, DEPLOYED_SNAPSHOT);
  const snapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, "utf8")) : null;
  return { cfg, frontend, tokens, denylist, snapshot };
}

/**
 * 每條鏈上每個元件要檢查的位址。回傳 [{ chainId, id, addresses: [{ key, address }], status? }]。
 * ref 在該鏈的前端設定裡不存在 → 這條鏈沒有這個元件（不列）；值為 0x0 → not-deployed。
 */
export function resolveTargets({ cfg, frontend, tokens }, chainIds = Object.keys(cfg.chains)) {
  const out = [];
  for (const chainId of chainIds) {
    const seen = new Map(); // lc(addr) → component id
    for (const c of cfg.components) {
      if (c.group) {
        const g = tokens[chainId]?.[c.group] ?? {};
        const addresses = Object.entries(g)
          .filter(([, a]) => lc(a) !== ZERO)
          .map(([key, address]) => ({ key, address }));
        if (addresses.length === 0) continue;
        out.push({ chainId, id: c.id, addresses });
        continue;
      }
      const address = frontend[chainId]?.roles?.[c.ref];
      if (address === undefined) continue;
      if (lc(address) === ZERO) {
        out.push({ chainId, id: c.id, addresses: [], status: "not-deployed" });
        continue;
      }
      if (seen.has(lc(address))) {
        out.push({ chainId, id: c.id, addresses: [{ key: c.ref, address }], status: "same-as", sameAs: seen.get(lc(address)) });
        continue;
      }
      seen.set(lc(address), c.id);
      out.push({ chainId, id: c.id, addresses: [{ key: c.ref, address }] });
    }
  }
  return out;
}

const WALK_SKIP = new Set(["node_modules", ".wrangler", ".state", "dist", "out", "cache", ".dev.vars"]);

/** sources 的每一項可以是檔案或目錄；目錄只取 git 追蹤的檔案（沒有 git 時才走訪，略過產物與本機狀態）。 */
export function expandSources(root, sources, exec = execFileSync) {
  const out = new Set();
  for (const s of sources) {
    const full = join(root, s);
    if (!statSync(full).isDirectory()) {
      out.add(s);
      continue;
    }
    let files = null;
    try {
      files = exec("git", ["ls-files", "-z", "--", s], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    } catch {
      files = null;
    }
    if (!files || files.length === 0) {
      files = [];
      const walk = (rel) => {
        for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
          if (WALK_SKIP.has(e.name)) continue;
          const p = `${rel}/${e.name}`;
          if (e.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(s);
    }
    for (const f of files) out.add(f);
  }
  // Solidity：把 repo 內的相對 import 一路展開。合約的 bytecode 也取決於它 import 的檔案
  // （例如 AgentSessionManager 呼叫 PerpetualExchange），只看主檔會把「依賴改了」誤判成「沒改」。
  // @openzeppelin 等 remapping 指向 submodule，版本由 submodule commit 固定，不在這裡展開。
  const queue = [...out].filter((f) => f.endsWith(".sol"));
  while (queue.length) {
    const f = queue.shift();
    const text = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of text.matchAll(/\bimport\s+(?:[^"';]*?\bfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g)) {
      const dep = posixJoin(f.split("/").slice(0, -1).join("/"), m[1]);
      if (!out.has(dep) && existsSync(join(root, dep))) {
        out.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...out].sort();
}

/** "contracts/src/v2" + "../CarbonTiers.sol" → "contracts/src/CarbonTiers.sol"。 */
function posixJoin(dir, rel) {
  const parts = dir ? dir.split("/") : [];
  for (const p of rel.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** 元件原始碼的指紋（CRLF→LF）。原始碼改了，「鏈上＝原始碼」的結論就不再成立。 */
export function sourceDigest(root, sources, exec = execFileSync) {
  const h = createHash("sha256");
  for (const s of expandSources(root, sources, exec)) {
    h.update(s + "\0");
    const text = readFileSync(join(root, s), "utf8");
    h.update((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n"));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** 原始碼最後一次進 master 的 PR／commit（first-parent，所以 merge commit 會被算到）。 */
export function mergedInfo(root, sources, exec = execFileSync) {
  try {
    const line = exec("git", ["log", "-1", "--first-parent", "--format=%H%x09%cs%x09%s", "--", ...expandSources(root, sources, exec)], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (!line) return null;
    const [sha, date, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    const pr = subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)/)?.[1] ?? null;
    return { pr: pr ? Number(pr) : null, commit: sha.slice(0, 7), date };
  } catch {
    return null;
  }
}

// ── bytecode 比對（VerifyTenant._verifyRuntimeCode 的 JS 版）──────────────────

export function artifactPath(outDir, spec) {
  const [file, name] = spec.split(":");
  return join(outDir, file, `${name}.json`);
}

export function loadArtifact(outDir, spec) {
  const f = artifactPath(outDir, spec);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

const basename = (p) => p.split("/").pop();

/**
 * 遮蔽 library 與 immutable 後比對 CBOR metadata 之前的部分。
 * pinImmutable：每個 immutable 都必須等於這個 32-byte word（library 自己的 call guard）。
 * 回傳 { match, metadataOnly, reason, libraries: [{ spec, address }] }。
 */
export function compareRuntime(gotHex, artifact, { pinImmutable = null } = {}) {
  const fail = (reason) => ({ match: false, metadataOnly: false, reason, libraries: [] });
  let wantHex = String(artifact?.deployedBytecode?.object ?? "").replace(/^0x/, "");
  if (!wantHex) return fail("產物沒有 runtime code");
  const got = Buffer.from(String(gotHex).replace(/^0x/, ""), "hex");
  if (wantHex.length / 2 !== got.length) return fail(`長度不同（鏈上 ${got.length} B，原始碼 ${wantHex.length / 2} B）`);

  const libraries = [];
  for (const [source, libs] of Object.entries(artifact.deployedBytecode.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libs)) {
      let lib = null;
      for (const r of refs) {
        if (r.length !== 20 || got.length < r.start + 20) return fail(`library ${name} 的位置不合法`);
        const a = "0x" + got.subarray(r.start, r.start + 20).toString("hex");
        if (lib === null) lib = a;
        else if (a !== lib) return fail(`library ${name} 的兩個位置是不同位址`);
        got.fill(0, r.start, r.start + 20);
        wantHex = wantHex.slice(0, 2 * r.start) + "0".repeat(40) + wantHex.slice(2 * r.start + 40);
      }
      if (lib) libraries.push({ spec: `${basename(source)}:${name}`, address: lib });
    }
  }
  if (!/^([0-9a-fA-F]{2})*$/.test(wantHex)) return fail("產物含未處理的 library 佔位");
  const want = Buffer.from(wantHex, "hex");

  for (const [id, refs] of Object.entries(artifact.deployedBytecode.immutableReferences ?? {})) {
    let first = null;
    for (const r of refs) {
      if (r.length !== 32 || got.length < r.start + 32) return fail(`immutable ${id} 的位置不合法`);
      const w = got.subarray(r.start, r.start + 32).toString("hex");
      if (first === null) first = w;
      else if (w !== first) return fail(`immutable ${id} 有兩個不同的值`);
      if (pinImmutable && w !== pad32(pinImmutable)) return fail(`immutable ${id} 的值不是預期的 ${pinImmutable}`);
      got.fill(0, r.start, r.start + 32);
      want.fill(0, r.start, r.start + 32);
    }
  }

  const n = want.length;
  if (n <= 2) return fail("產物沒有 runtime code");
  const meta = ((want[n - 2] << 8) | want[n - 1]) + 2;
  if (meta >= n) return fail("產物沒有 CBOR metadata 結尾");
  const end = n - meta;
  if (!got.subarray(0, end).equals(want.subarray(0, end))) {
    let k = 0;
    while (k < end && got[k] === want[k]) k++;
    return fail(`遮蔽 immutable／library 後，第 ${k} byte 起不同`);
  }
  return { match: true, metadataOnly: !got.equals(want), reason: null, libraries };
}

/**
 * 依候選產物順序比對（第一個是 master 現行版本）。fetchCode(address) 給 library 用。
 * 回傳 { status, matched, detail }。
 */
export async function classifyCode(code, specs, { outDir, fetchCode }) {
  let firstReason = null;
  let anyArtifact = false;
  for (let i = 0; i < specs.length; i++) {
    const art = loadArtifact(outDir, specs[i]);
    if (!art) continue;
    anyArtifact = true;
    const r = compareRuntime(code, art);
    let ok = r.match;
    let reason = r.reason;
    let metadataOnly = r.metadataOnly;
    for (const lib of ok ? r.libraries : []) {
      const libArt = loadArtifact(outDir, lib.spec);
      if (!libArt) {
        ok = false;
        reason = `找不到 library 產物 ${lib.spec}`;
        break;
      }
      const libCode = await fetchCode(lib.address);
      const lr = compareRuntime(libCode, libArt, { pinImmutable: lib.address });
      if (!lr.match) {
        ok = false;
        reason = `library ${lib.spec}（${lib.address}）：${lr.reason}`;
        break;
      }
      metadataOnly ||= lr.metadataOnly;
    }
    if (ok) {
      const name = specs[i].split(":")[1];
      if (i === 0) {
        return { status: "equal", matched: specs[i], detail: metadataOnly ? "程式碼一致；只有 CBOR metadata（原始碼文字雜湊）不同" : "完全一致" };
      }
      return { status: "behind", matched: specs[i], detail: `鏈上是舊版 ${name}，原始碼現行版是 ${specs[0].split(":")[1]}` };
    }
    if (i === 0) firstReason = reason;
  }
  if (!anyArtifact) return { status: "unknown", matched: null, detail: "找不到編譯產物（先在 contracts/ 跑 forge build）" };
  return { status: "behind", matched: null, detail: `與原始碼現行版不一致：${firstReason ?? "也不符合任何舊版候選"}` };
}

// ── 鏈上讀取 ─────────────────────────────────────────────────────────────────

const RPC_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);

export function makeRpc(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), allowed = RPC_METHODS } = {}) {
  let id = 1;
  return async (method, params) => {
    if (!allowed.has(method) || /send|sign/i.test(method)) throw new Error(`不允許的 RPC 方法 ${method}（這支腳本只讀）`);
    let last = "";
    for (let attempt = 0; attempt < 6; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
        });
      } catch (e) {
        last = e.message;
        await sleep(1500);
        continue;
      }
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      const limited = res.status === 429 || j?.error?.code === -32007 || /limit|too many/i.test(j?.error?.message ?? "");
      if (limited || res.status >= 500) {
        last = `HTTP ${res.status}`;
        await sleep(1500);
        continue;
      }
      if (!res.ok || !j) throw new Error(`${method} HTTP ${res.status}：${text.slice(0, 160)}`);
      return j;
    }
    throw new Error(`${method} 連續失敗（${last}）`);
  };
}

const roleHash = (role) => (role === "DEFAULT_ADMIN_ROLE" ? "0x" + "0".repeat(64) : keccak256(role));

/** 一個位址的全部讀取：code、proxy 實作、getter、角色、denyChecks。 */
async function inspectAddress({ rpc, block, address, comp, denylist, outDir, snapshot }) {
  const must = async (method, params) => {
    const j = await rpc(method, params);
    if (j.error) throw new Error(`${method}：${j.error.message}`);
    return j.result;
  };
  const codeCache = new Map();
  const fetchCode = async (a) => {
    if (!codeCache.has(lc(a))) codeCache.set(lc(a), await must("eth_getCode", [a, block]));
    return codeCache.get(lc(a));
  };
  const result = { address, impl: null, code: null, reads: [], leaked: [], snapshot: null };
  try {
    const code = await fetchCode(address);
    if (code === "0x") {
      result.code = { status: "unknown", matched: null, detail: "這個位址在鏈上沒有程式碼" };
      return result;
    }
    let target = code;
    if (comp.proxy) {
      const slot = await must("eth_getStorageAt", [address, IMPL_SLOT, block]);
      if (BigInt(slot) === 0n) {
        result.code = { status: "unknown", matched: null, detail: "proxy 的 EIP-1967 實作 slot 是空的" };
      } else {
        result.impl = wordToAddr(slot);
        target = await fetchCode(result.impl);
      }
    }
    result.code ??= await classifyCode(target, comp.artifacts, { outDir, fetchCode });
    result.snapshot = snapshotCompare(snapshot, address, code, comp.proxy ? { impl: result.impl, code: target } : null);
  } catch (e) {
    result.code = { status: "unknown", matched: null, detail: `RPC 失敗：${e.message}` };
    return result;
  }

  const call = async (data) => {
    const j = await rpc("eth_call", [{ to: address, data }, block]);
    return j.error ? { error: j.error.message } : { value: j.result };
  };
  for (const fn of comp.reads ?? []) {
    const r = await call(selector(fn));
    if (r.error || !r.value || r.value.length < 66) {
      result.reads.push({ fn, error: "呼叫失敗（部署版沒有這個函式？）" });
      continue;
    }
    const value = wordToAddr(r.value);
    const leaked = denylist.includes(lc(value));
    result.reads.push({ fn, value: leaked ? shortAddr(value) : value, leaked });
    if (leaked) result.leaked.push({ what: fn, holder: shortAddr(value) });
  }
  for (const role of comp.roles ?? []) {
    for (const bad of denylist) {
      const r = await call(selector("hasRole(bytes32,address)") + pad32(roleHash(role)) + pad32(bad));
      if (r.error) {
        result.reads.push({ fn: `hasRole(${role}, ${shortAddr(bad)})`, error: "呼叫失敗" });
        continue;
      }
      const has = BigInt(r.value) !== 0n;
      result.reads.push({ fn: `hasRole(${role}, ${shortAddr(bad)})`, value: has, leaked: has });
      if (has) result.leaked.push({ what: role, holder: shortAddr(bad) });
    }
  }
  for (const fn of comp.denyChecks ?? []) {
    for (const bad of denylist) {
      const r = await call(selector(fn) + pad32(bad));
      const label = `${fn.split("(")[0]}(${shortAddr(bad)})`;
      if (r.error) {
        result.reads.push({ fn: label, error: "呼叫失敗" });
        continue;
      }
      const has = BigInt(r.value) !== 0n;
      result.reads.push({ fn: label, value: has, leaked: has });
      if (has) result.leaked.push({ what: label, holder: shortAddr(bad) });
    }
  }
  return result;
}

/** 與 ops/monitoring/deployed.json 的快照比：same／changed／absent。 */
export function snapshotCompare(snapshot, address, code, proxy) {
  const entry = snapshot?.contracts?.[lc(address)];
  if (!entry) return "absent";
  const own = snapshot.codes?.[entry.codeHash];
  if (lc(own ?? "") !== lc(code)) return "changed";
  if (proxy) {
    if (lc(entry.impl ?? "") !== lc(proxy.impl ?? "")) return "changed";
    if (lc(snapshot.codes?.[entry.implCodeHash] ?? "") !== lc(proxy.code)) return "changed";
  }
  return "same";
}

const STATUS_RANK = { behind: 3, unknown: 2, equal: 1 };

/** 一個元件（可能是代幣群組）的彙總。 */
export function aggregate(results) {
  let status = "equal";
  for (const r of results) if (STATUS_RANK[r.code.status] > STATUS_RANK[status]) status = r.code.status;
  const counts = {};
  for (const r of results) counts[r.code.status] = (counts[r.code.status] ?? 0) + 1;
  const details = [...new Set(results.map((r) => r.code.detail))];
  return { status, counts, details };
}

// ── 產生報告 ─────────────────────────────────────────────────────────────────

export function acceptanceOf(cfg, chainId, id) {
  const a = cfg.acceptance?.[`${chainId}:${id}`] ?? (chainId === PRIMARY_CHAIN ? cfg.acceptance?.[id] : undefined);
  if (!a) return { status: "未驗收", date: null, evidence: [], note: chainId === PRIMARY_CHAIN ? null : "legacy 展示鏈，不做展示驗收" };
  return { status: a.status, date: a.date ?? null, evidence: a.evidence ?? [], note: a.note ?? null };
}

export async function buildReport({ root, outDir, chainIds, rpcOverrides = {}, fetchImpl = fetch, sleep, today, exec, log = () => {} }) {
  const src = loadSources(root);
  const { cfg, denylist, snapshot } = src;
  const ids = chainIds ?? Object.keys(cfg.chains);
  const targets = resolveTargets(src, ids);
  const report = {
    $comment: `由 node scripts/check-deployment-status.mjs 產生（唯讀 RPC），不要手改；${REPORT_MD} 是這份 JSON 的渲染結果。`,
    generatedAt: today,
    denylistSize: denylist.length,
    chains: {},
    offchain: [],
  };
  for (const chainId of ids) {
    const chainCfg = cfg.chains[chainId];
    const rpc = makeRpc(rpcOverrides[chainId] ?? chainCfg.rpc, { fetchImpl, sleep });
    const chain = { name: chainCfg.name, role: chainCfg.role, rpc: rpcOverrides[chainId] ? "（自訂 RPC）" : chainCfg.rpc, block: null, components: [] };
    report.chains[chainId] = chain;
    try {
      const got = Number(BigInt((await rpc("eth_chainId", [])).result));
      if (String(got) !== chainId) throw new Error(`RPC 的 chainId ${got} 不是 ${chainId}`);
      chain.block = Number(BigInt((await rpc("eth_blockNumber", [])).result));
    } catch (e) {
      chain.error = e.message;
    }
    const block = chain.block === null ? null : "0x" + chain.block.toString(16);
    for (const t of targets.filter((x) => x.chainId === chainId)) {
      const comp = cfg.components.find((c) => c.id === t.id);
      const row = {
        id: comp.id,
        label: comp.label,
        merged: mergedInfo(root, comp.sources, exec),
        sourceDigest: sourceDigest(root, comp.sources),
        addresses: t.addresses.map((a) => ({ key: a.key, address: a.address })),
        status: t.status ?? null,
        detail: null,
        leaked: [],
        reads: [],
        snapshot: null,
        acceptance: acceptanceOf(cfg, chainId, comp.id),
      };
      if (t.status === "same-as") row.detail = `與 ${t.sameAs} 是同一個位址，比對結果見該列`;
      if (t.status === "not-deployed") row.detail = "前端設定的位址是 0x0";
      if (!t.status) {
        if (block === null) {
          row.status = "unknown";
          row.detail = `RPC 失敗：${chain.error}`;
        } else {
          const results = [];
          for (const a of t.addresses) {
            log(`  ${chainCfg.name} ${comp.id} ${a.key} ${a.address}`);
            results.push({ key: a.key, ...(await inspectAddress({ rpc, block, address: a.address, comp, denylist, outDir, snapshot: chainId === String(snapshot?.chainId) ? snapshot : null })) });
          }
          const agg = aggregate(results);
          row.status = agg.status;
          if (results.length === 1) {
            row.detail = results[0].code.detail;
            row.matched = results[0].code.matched;
            if (results[0].impl) row.impl = results[0].impl;
            row.reads = results[0].reads;
            row.snapshot = chainId === String(snapshot?.chainId) ? results[0].snapshot : null;
          } else {
            row.counts = agg.counts;
            row.detail = agg.details.join("；");
            row.perAddress = results.map((r) => ({ key: r.key, status: r.code.status, detail: r.code.detail }));
            row.reads = results.flatMap((r) => r.reads.filter((x) => x.leaked || x.error).map((x) => ({ ...x, fn: `${r.key}.${x.fn}` })));
            const snaps = [...new Set(results.map((r) => r.snapshot))];
            row.snapshot = chainId === String(snapshot?.chainId) ? (snaps.length === 1 ? snaps[0] : "mixed") : null;
          }
          for (const r of results) for (const l of r.leaked) row.leaked.push(results.length > 1 ? { ...l, what: `${r.key}.${l.what}` } : l);
        }
      }
      chain.components.push(row);
    }
  }
  for (const o of cfg.offchain ?? []) {
    report.offchain.push({
      id: o.id,
      label: o.label,
      merged: mergedInfo(root, o.sources, exec),
      sourceDigest: sourceDigest(root, o.sources),
      deployed: o.deployed,
      acceptance: acceptanceOf(cfg, PRIMARY_CHAIN, o.id),
    });
  }
  return report;
}

// ── markdown ────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const mergedText = (m) => (m ? `${m.pr ? `#${m.pr}` : "（無 PR 編號）"}／\`${m.commit}\`（${m.date}）` : "（查不到 git 紀錄）");
const acceptanceText = (a) => {
  if (a.status === "未驗收") return a.note ? `未驗收（${esc(a.note)}）` : "未驗收";
  const ev = a.evidence.map((p) => `\`${p}\``).join("、");
  return `${a.status}（${a.date ?? "日期不明"}）：${ev}${a.note ? `。${esc(a.note)}` : ""}`;
};

function deployedText(row) {
  if (row.status === "not-deployed") return "未部署";
  if (row.addresses.length === 1) {
    const a = row.addresses[0].address;
    return row.impl ? `\`${a}\`（實作 \`${row.impl}\`）` : `\`${a}\``;
  }
  return `${row.addresses.length} 顆（${row.addresses.map((a) => a.key).join("、")}）`;
}

function verifyText(row, chain, date) {
  if (row.status === "not-deployed") return "—";
  if (row.status === "same-as") return esc(row.detail);
  const head = `**${STATUS_TEXT[row.status]}**`;
  const counts = row.counts ? `（${Object.entries(row.counts).map(([k, v]) => `${STATUS_TEXT[k]} ${v}`).join("、")}）` : "";
  const when = chain.block ? `區塊 ${chain.block}，${date}` : date;
  return `${head}${counts}：${esc(row.detail)}（${when}）`;
}

export function renderMarkdown(report) {
  const L = [];
  const all = Object.entries(report.chains);
  L.push("# 發布狀態（RELEASE_STATUS）");
  L.push("");
  L.push("> **已合併不等於使用者受保護。** 合併只代表 repo 裡的原始碼改了；鏈上合約不會因為 PR 合併而改變，");
  L.push("> 使用者碰到的永遠是鏈上那一版。一個修正要等到「已部署」而且「鏈上＝原始碼」，才真的保護到使用者；");
  L.push("> 要等到「展示驗收」有證據，才能對外說它可以展示。");
  L.push("");
  L.push(`本文件由 \`node scripts/check-deployment-status.mjs\` 以唯讀 RPC 產生（${report.generatedAt}），**不要手改**；`);
  L.push(`機器可讀版是 [\`release-status.json\`](release-status.json)。CI 以 \`--offline\` 檢查本文件仍是那份 JSON 的渲染結果、`);
  L.push(`位址仍等於 \`frontend/src/contracts/**\`、標成「鏈上＝原始碼」的元件原始碼沒有在產生之後被改過。部署後重跑見`);
  L.push("[`OWNER_ACTIONS.md`](OWNER_ACTIONS.md) 第 7 步。");
  L.push("");
  L.push("## 摘要");
  L.push("");
  L.push("| 鏈 | 區塊 | 鏈上＝原始碼 | 原始碼較新（待部署） | 無法比對 | 未部署 | 仍指向外洩地址的元件 | 已驗收／部分驗收 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const [id, c] of all) {
    const n = (s) => c.components.filter((r) => r.status === s).length;
    const leaked = c.components.filter((r) => r.leaked.length).length;
    const acc = c.components.filter((r) => r.acceptance.status !== "未驗收").length;
    L.push(`| ${c.name}（${id}） | ${c.block ?? `RPC 失敗：${esc(c.error)}`} | ${n("equal")} | ${n("behind")} | ${n("unknown")} | ${n("not-deployed")} | ${leaked} | ${acc} |`);
  }
  L.push("");
  L.push(`外洩地址名單取自 \`agent/shared/src/payoutSafety.ts\` 的 \`COMPROMISED_ADDRESSES\`（${report.denylistSize} 個）；本文件只寫縮寫。`);
  L.push("");
  for (const [id, c] of all) {
    L.push(`## ${c.name}（${id}）— ${c.role}`);
    L.push("");
    L.push(`RPC：${c.rpc}；區塊 ${c.block ?? "—"}。`);
    L.push("");
    L.push("| 元件 | 已合併（PR／commit） | 已部署 | 鏈上驗證 | 展示驗收 |");
    L.push("|---|---|---|---|---|");
    for (const r of c.components) {
      L.push(`| ${r.id}<br>${esc(r.label)} | ${mergedText(r.merged)} | ${deployedText(r)} | ${verifyText(r, c, report.generatedAt)} | ${acceptanceText(r.acceptance)} |`);
    }
    L.push("");
    const leaks = c.components.flatMap((r) => r.leaked.map((l) => ({ id: r.id, ...l })));
    L.push(`### ${c.name}：仍指向已知外洩地址的項目`);
    L.push("");
    if (leaks.length === 0) L.push("無。");
    else {
      L.push("| 元件 | getter／角色 | 外洩地址（縮寫） |");
      L.push("|---|---|---|");
      for (const l of leaks) L.push(`| ${l.id} | \`${esc(l.what)}\` | \`${l.holder}\` |`);
    }
    L.push("");
    const failed = c.components.flatMap((r) => (r.reads ?? []).filter((x) => x.error).map((x) => ({ id: r.id, ...x })));
    if (failed.length) {
      L.push(`### ${c.name}：讀不到的 getter`);
      L.push("");
      L.push("部署版沒有這個函式，或呼叫 revert。不代表安全，只代表這支腳本無法判斷。");
      L.push("");
      for (const f of failed) L.push(`- ${f.id}：\`${esc(f.fn)}\` — ${esc(f.error)}`);
      L.push("");
    }
    const snaps = c.components.filter((r) => r.snapshot && r.snapshot !== "same");
    if (c.components.some((r) => r.snapshot)) {
      L.push(`### ${c.name}：與監控快照（\`ops/monitoring/deployed.json\`）的差異`);
      L.push("");
      if (snaps.length === 0) L.push("無：快照涵蓋的每個位址，鏈上 bytecode 都與快照相同。");
      else for (const r of snaps) L.push(`- ${r.id}：${r.snapshot === "absent" ? "快照沒有涵蓋這個位址（監控沒有規則在看它）" : r.snapshot === "mixed" ? "群組內有的在快照、有的不在或已改變" : "鏈上 bytecode 與快照不同——快照過期，重跑 `node scripts/check-monitoring.mjs --refresh-deployed`"}`);
      L.push("");
    }
  }
  if (report.offchain.length) {
    L.push("## 鏈下元件");
    L.push("");
    L.push("鏈下元件沒有 bytecode 可比對；「已部署」欄只寫有證據的狀態。");
    L.push("");
    L.push("| 元件 | 已合併（PR／commit） | 已部署 | 鏈上驗證 | 展示驗收 |");
    L.push("|---|---|---|---|---|");
    for (const o of report.offchain) {
      L.push(`| ${o.id}<br>${esc(o.label)} | ${mergedText(o.merged)} | ${esc(o.deployed)} | 不適用（鏈下） | ${acceptanceText(o.acceptance)} |`);
    }
    L.push("");
  }
  L.push("## 判讀方式");
  L.push("");
  L.push("- **鏈上＝原始碼**：鏈上 runtime code 與 master 以 `contracts/foundry.toml` 設定編譯的產物等長，遮蔽 immutable 與 library 位址後，");
  L.push("  CBOR metadata 之前的每個 byte 都相同（方法與 `contracts/script/VerifyTenant.s.sol` 的 `_verifyRuntimeCode` 相同）。只有 metadata 不同時另外註記——");
  L.push("  那是原始碼文字的雜湊，改註解也會變，不會被執行。");
  L.push("- **原始碼較新（待部署）**：與 master 的產物不一致。可能是鏈上跑的是舊版原始碼，也可能是舊的編譯設定；兩者的處置相同——");
  L.push("  要讓使用者拿到 master 的行為，就要重新部署。元件列了舊版候選（例如 AssetVaultV2 的各版實作）時，會指出鏈上是哪一版。");
  L.push("- **無法比對**：沒有編譯產物、鏈上沒有程式碼、proxy 沒有實作，或 RPC 失敗。不是「一致」。");
  L.push("- **已合併**：元件原始碼（含它在 repo 內 import 的 Solidity 檔）最後一次進 master 的 PR 與 commit（`git log --first-parent`）。");
  L.push("- **展示驗收**：只引用 repo 內存在的證據檔（`ops/release-status/components.json` 的 `acceptance`）；沒有證據就是「未驗收」。");
  L.push("- 外洩地址檢查：`owner()`、`platformTreasury()` 等 getter 的回傳值，以及 AccessControl 角色、`authorizedAgents`、`verifiers`");
  L.push("  對名單中每個位址的查詢。讀不到的 getter 另外列出，不算通過。");
  L.push("");
  return L.join("\n");
}

// ── --offline：設定一致性（CI）───────────────────────────────────────────────

export function checkConfig(root) {
  const problems = [];
  const warnings = [];
  let src;
  try {
    src = loadSources(root);
  } catch (e) {
    return { problems: [`讀設定失敗：${e.message}`], warnings };
  }
  const { cfg, frontend, tokens, snapshot } = src;
  if (!cfg.chains?.[PRIMARY_CHAIN]) problems.push(`components.json 沒有主鏈 ${PRIMARY_CHAIN}`);
  for (const [id, c] of Object.entries(cfg.chains ?? {})) {
    if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(c.rpc ?? "")) problems.push(`chains.${id}.rpc 必須是 https URL`);
    if (/[0-9a-f]{24,}|api[-_]?key|apikey/i.test(c.rpc ?? "")) problems.push(`chains.${id}.rpc 看起來含金鑰；這裡只能放公開端點`);
  }
  const ids = new Set();
  for (const c of cfg.components ?? []) {
    const where = `元件 ${c.id ?? "（沒有 id）"}`;
    if (!c.id || ids.has(c.id)) problems.push(`${where}：id 必填且不可重複`);
    ids.add(c.id);
    if (!c.label) problems.push(`${where}：label 必填`);
    if (!!c.ref === !!c.group) problems.push(`${where}：ref 與 group 必須恰好有一個`);
    if (!Array.isArray(c.artifacts) || c.artifacts.length === 0 || !c.artifacts.every((a) => ARTIFACT.test(a))) {
      problems.push(`${where}：artifacts 必須是非空的 <File>.sol:<Name> 陣列`);
    }
    if (!Array.isArray(c.sources) || c.sources.length === 0) problems.push(`${where}：sources 必填`);
    for (const s of c.sources ?? []) if (!existsSync(join(root, s))) problems.push(`${where}：原始碼 ${s} 不存在`);
    const main = (c.sources ?? []).find((s) => s.endsWith(".sol"));
    const text = main && existsSync(join(root, main)) ? readFileSync(join(root, main), "utf8") : "";
    const [file, name] = (c.artifacts?.[0] ?? ":").split(":");
    if (main && basename(main) !== file) problems.push(`${where}：artifacts[0] 的檔名 ${file} 不是 sources 第一個 .sol（${basename(main)}）`);
    if (text && !new RegExp(`\\bcontract\\s+${name}\\b`).test(text)) problems.push(`${where}：${main} 裡沒有 contract ${name}`);
    for (const fn of [...(c.reads ?? []), ...(c.denyChecks ?? [])]) if (!FN_SIG.test(fn)) problems.push(`${where}：${fn} 不是合法的函式簽章`);
    for (const fn of c.denyChecks ?? []) if (!/\(address\)$/.test(fn)) problems.push(`${where}：denyChecks 只能是單一 address 參數的查詢（${fn}）`);
    for (const r of c.roles ?? []) {
      if (!ROLE.test(r)) problems.push(`${where}：${r} 不是角色名稱`);
      else if (r !== "DEFAULT_ADMIN_ROLE" && text && !new RegExp(`\\b${r}\\s*=`).test(text)) problems.push(`${where}：${main} 沒有宣告 ${r}`);
    }
    if (c.ref && frontend[PRIMARY_CHAIN]?.roles?.[c.ref] === undefined && !Object.keys(cfg.chains).some((id) => frontend[id]?.roles?.[c.ref] !== undefined)) {
      problems.push(`${where}：ref ${c.ref} 在 frontend/src/contracts/** 的任何一條鏈都解析不到`);
    }
    if (c.group && !Object.values(tokens).some((g) => Object.keys(g[c.group] ?? {}).length)) problems.push(`${where}：group ${c.group} 在任何一條鏈都沒有位址`);
  }
  const accIds = new Set([...ids, ...(cfg.offchain ?? []).map((o) => o.id)]);
  for (const [key, a] of Object.entries(cfg.acceptance ?? {})) {
    const id = key.includes(":") ? key.split(":")[1] : key;
    if (!accIds.has(id)) problems.push(`acceptance.${key}：沒有這個元件`);
    if (!ACCEPTANCE_STATUSES.includes(a.status)) problems.push(`acceptance.${key}.status 必須是 ${ACCEPTANCE_STATUSES.join("／")}`);
    if (a.status !== "未驗收") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date ?? "")) problems.push(`acceptance.${key}：${a.status} 必須有日期 YYYY-MM-DD`);
      if (!Array.isArray(a.evidence) || a.evidence.length === 0) problems.push(`acceptance.${key}：${a.status} 必須至少引用一個證據檔`);
    }
    for (const p of a.evidence ?? []) {
      if (!existsSync(join(root, p.split("#")[0]))) problems.push(`acceptance.${key}：證據 ${p} 不存在於 repo`);
    }
  }
  for (const o of cfg.offchain ?? []) {
    if (!o.id || !o.label || !o.deployed) problems.push(`鏈下元件 ${o.id ?? "?"}：id、label、deployed 必填`);
    for (const s of o.sources ?? []) if (!existsSync(join(root, s))) problems.push(`鏈下元件 ${o.id}：${s} 不存在`);
  }

  // 監控快照：同一個角色名的位址必須等於現行前端設定（快照過期會讓兩邊說不同的話）。
  if (snapshot) {
    const roles = frontend[String(snapshot.chainId)]?.roles ?? {};
    for (const [addr, e] of Object.entries(snapshot.contracts ?? {})) {
      if (e.ref in roles && lc(roles[e.ref]) !== lc(addr)) {
        problems.push(`${DEPLOYED_SNAPSHOT}：${e.ref} 的快照位址 ${addr} 不等於前端設定 ${roles[e.ref]}——重跑 check-monitoring --refresh-deployed`);
      }
    }
  }

  // 已產生的報告：仍是 JSON 的渲染結果、位址仍是現行設定、原始碼沒有在「鏈上＝原始碼」之後被改。
  const jf = join(root, REPORT_JSON);
  const mf = join(root, REPORT_MD);
  if (!existsSync(jf) || !existsSync(mf)) {
    problems.push(`${REPORT_JSON} 或 ${REPORT_MD} 不存在——執行 node scripts/check-deployment-status.mjs（唯讀連網）`);
    return { problems, warnings };
  }
  const report = JSON.parse(readFileSync(jf, "utf8"));
  const md = readFileSync(mf, "utf8").replace(/\r\n/g, "\n");
  if (md !== renderMarkdown(report)) problems.push(`${REPORT_MD} 不是 ${REPORT_JSON} 的渲染結果（被手改？）——重跑 node scripts/check-deployment-status.mjs`);
  const targets = resolveTargets(src, Object.keys(report.chains ?? {}));
  for (const [chainId, chain] of Object.entries(report.chains ?? {})) {
    const want = targets.filter((t) => t.chainId === chainId);
    const have = new Map(chain.components.map((r) => [r.id, r]));
    for (const t of want) {
      const r = have.get(t.id);
      const label = `${REPORT_JSON} ${chain.name} ${t.id}`;
      if (!r) {
        problems.push(`${label}：報告裡沒有這個元件（components.json 或前端設定改了）——重跑`);
        continue;
      }
      const a = t.addresses.map((x) => lc(x.address)).join(",");
      const b = r.addresses.map((x) => lc(x.address)).join(",");
      if (a !== b) problems.push(`${label}：位址已變更（報告 ${b || "0x0"}，現行 ${a || "0x0"}）——部署後要重跑`);
      const comp = cfg.components.find((c) => c.id === t.id);
      const digest = sourceDigest(root, comp.sources);
      if (digest !== r.sourceDigest) {
        if (r.status === "equal") problems.push(`${label}：報告寫「鏈上＝原始碼」，但原始碼在產生之後改過——重跑（結果會變成「原始碼較新」）`);
        else warnings.push(`${label}：原始碼在產生報告之後改過（報告的「已合併」欄已過期）`);
      }
      const acc = acceptanceOf(cfg, chainId, t.id);
      if (JSON.stringify(acc) !== JSON.stringify(r.acceptance)) problems.push(`${label}：展示驗收與 components.json 不同——執行 --refresh-acceptance`);
    }
    for (const id of have.keys()) if (!want.some((t) => t.id === id)) problems.push(`${REPORT_JSON} ${chain.name}：多了現行設定沒有的元件 ${id}——重跑`);
  }
  for (const o of cfg.offchain ?? []) {
    const r = (report.offchain ?? []).find((x) => x.id === o.id);
    if (!r) problems.push(`${REPORT_JSON}：沒有鏈下元件 ${o.id}——重跑`);
    else if (r.deployed !== o.deployed || JSON.stringify(r.acceptance) !== JSON.stringify(acceptanceOf(cfg, PRIMARY_CHAIN, o.id))) {
      problems.push(`${REPORT_JSON}：鏈下元件 ${o.id} 與 components.json 不同——執行 --refresh-acceptance`);
    }
  }
  return { problems, warnings };
}

/** 不連網：把 components.json 的展示驗收與鏈下元件狀態套進現有報告，重新渲染。 */
export function refreshAcceptance(root) {
  const { cfg } = loadSources(root);
  const report = JSON.parse(readFileSync(join(root, REPORT_JSON), "utf8"));
  for (const [chainId, chain] of Object.entries(report.chains)) {
    for (const r of chain.components) r.acceptance = acceptanceOf(cfg, chainId, r.id);
  }
  report.offchain = report.offchain.filter((o) => (cfg.offchain ?? []).some((x) => x.id === o.id));
  for (const o of cfg.offchain ?? []) {
    let r = report.offchain.find((x) => x.id === o.id);
    if (!r) report.offchain.push((r = { id: o.id, label: o.label, merged: null, sourceDigest: null }));
    r.label = o.label;
    r.deployed = o.deployed;
    r.acceptance = acceptanceOf(cfg, PRIMARY_CHAIN, o.id);
  }
  return report;
}

function writeReport(root, report) {
  writeFileSync(join(root, REPORT_JSON), JSON.stringify(report, null, 1) + "\n");
  writeFileSync(join(root, REPORT_MD), renderMarkdown(report));
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const opt = (name) => {
    const k = args.indexOf(name);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const root = resolve(opt("--root") ?? join(here, ".."));
  if (args.includes("--offline")) {
    const { problems, warnings } = checkConfig(root);
    for (const w of warnings) console.log(`::warning::${w}`);
    if (problems.length) {
      for (const p of problems) console.error(`✗ ${p}`);
      process.exit(1);
    }
    console.log(`發布狀態設定一致（${COMPONENTS_FILE} ↔ frontend/src/contracts/** ↔ ${REPORT_JSON} ↔ ${REPORT_MD}）`);
    return;
  }
  if (args.includes("--refresh-acceptance")) {
    writeReport(root, refreshAcceptance(root));
    console.log(`已依 ${COMPONENTS_FILE} 更新 ${REPORT_JSON} 與 ${REPORT_MD} 的展示驗收（未連網）`);
    return;
  }
  const rpcOverrides = {};
  args.forEach((a, i) => {
    if (a === "--rpc") {
      const [id, ...url] = String(args[i + 1]).split("=");
      rpcOverrides[id] = url.join("=");
    }
  });
  const chainIds = args.includes("--chain") ? args.flatMap((a, i) => (a === "--chain" ? [args[i + 1]] : [])) : undefined;
  const outDir = resolve(opt("--out") ?? join(root, "contracts", "out"));
  if (!existsSync(outDir)) {
    console.error(`找不到編譯產物 ${outDir}：先在 contracts/ 跑 forge build`);
    process.exit(1);
  }
  const report = await buildReport({
    root,
    outDir,
    chainIds,
    rpcOverrides,
    today: new Date().toISOString().slice(0, 10),
    log: (m) => console.error(m),
  });
  if (args.includes("--stdout")) {
    process.stdout.write(renderMarkdown(report));
    return;
  }
  writeReport(root, report);
  for (const [id, c] of Object.entries(report.chains)) {
    const n = (s) => c.components.filter((r) => r.status === s).length;
    console.log(`${c.name}（${id}）區塊 ${c.block}：鏈上＝原始碼 ${n("equal")}、原始碼較新 ${n("behind")}、無法比對 ${n("unknown")}、未部署 ${n("not-deployed")}、指向外洩地址 ${c.components.filter((r) => r.leaked.length).length}`);
  }
  console.log(`已寫入 ${REPORT_MD} 與 ${REPORT_JSON}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.stack ?? e.message);
    process.exit(1);
  });
}
