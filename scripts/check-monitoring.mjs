#!/usr/bin/env node
// 監控設定一致性檢查（ops/monitoring/monitors.json ↔ 前端設定與 ABI）。
//
// 為什麼存在：監控最糟的失敗模式是「看起來在監控」——對一顆已經沒人用的合約、或一個
// 合約根本不會發出的事件設告警，永遠不會響，也永遠不會有人發現。2026-09-29 三支
// workflow 指向舊 exchange、CI 全綠（#178），就是同一類問題。這支腳本確保：
//
//   1. 每個 active 規則的合約位址 == frontend/src/contracts/**（addresses.ts、V2_STACK、
//      x402.ts、sessionManager.ts）解析出來的位址。位址不手抄，由 --write 產生。
//   2. 每個 active 事件簽章存在於該合約在 frontend/src/contracts/abi/*.json 的 ABI；
//      topic0 == keccak256(簽章)；inputs 與 ABI 相同。
//   3. pending-deploy 規則沒有位址、不會被 Worker 載入，但事件必須真的宣告在指定的
//      Solidity 原始碼裡（部署後改 active 時，ABI 檢查接手）。
//   4. state 規則呼叫的函式存在於 ABI；selector 正確；金額小數位依代幣原始碼推得。
//   5. 處置段落（runbook）真的是 docs/INCIDENT_RESPONSE.md 的標題；related 連結的標題存在。
//   6. rules.md 是 monitors.json 的渲染結果（人看的清單不會與機器設定脫鉤）。
//   7. 設定目錄裡沒有秘密：wrangler.toml [vars] 不含憑證鍵名，任何檔案不含 bot token／webhook URL。
//   8. 引擎用到的參數都有定義；SIGNAL_API_URL 預設值 == SDK 的 SIGNAL_API_TESTNET_URL。
//   9. **部署版真的會發這個事件、真的有這個函式**（審查 H2）：前端 ABI 來自 master 原始碼，
//      可能比鏈上的版本新。ops/monitoring/deployed.json 是以唯讀 RPC 抓下來的 runtime
//      bytecode（UUPS 讀實作位址）與幾個 getter 的鏈上快照；active 事件的 topic0、state 規則的
//      selector 必須出現在 bytecode 裡，接線規則的預期值必須等於鏈上快照。檢查本身不連網。
//  10. 涵蓋與下限（審查 M4）：受監控合約會發的每個事件都要有規則或明列理由的忽略（ignoredEvents）；
//      必要規則不可被刪、降級或改成 pending（REQUIRED_RULES）；每個參數有型別與範圍
//      （PARAM_SPECS 在 ops/monitoring/params.mjs，執行期共用同一張表）；全域設定（參數預設值、explorer、
//      repoBlobBase）釘雜湊、連結網域白名單；wrangler.toml 任何位置都不得出現秘密鍵名；
//      秘密掃描遞迴子目錄；.dev.vars／.wrangler/ 必須在 .gitignore。
//
// 零依賴。用法：
//   node scripts/check-monitoring.mjs            # 檢查，有問題非零結束（不連網）
//   node scripts/check-monitoring.mjs --write    # 依來源重新產生 monitors.json 的產生欄位與 rules.md
//   node scripts/check-monitoring.mjs --refresh-deployed [--rpc <url>]
//                                                # 以唯讀 RPC 重抓 deployed.json（合約重新部署、升級或加規則後）
//   node scripts/check-monitoring.mjs --verify-deployed [--rpc <url>]
//                                                # 以唯讀 RPC 比對 deployed.json 是否仍是鏈上實況（每週排程；不寫檔）
//   node scripts/check-monitoring.mjs --root <dir>
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFrontendConfig } from "./check-addresses.mjs";
import { keccak256, selector } from "../ops/monitoring/keccak.mjs";
import { _internal as engineInternal, IMPL_SLOT } from "../ops/monitoring/engine.mjs";
import {
  ENV_SETTINGS,
  PARAM_SPECS,
  SECRET_ENV,
  SEVERITIES,
  checkParamValue as checkParamSpec,
  paramComboProblems,
} from "../ops/monitoring/params.mjs";
import { parseMuteKeys } from "../ops/monitoring/notify.mjs";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const KINDS = ["event", "state", "http"];
const STATUSES = ["active", "pending-deploy"];
const IR_DOC = "docs/INCIDENT_RESPONSE.md";
const DEPLOYED_FILE = "ops/monitoring/deployed.json";
/**
 * 代幣：小數位、位址來源，以及「持有它的合約用哪個 getter 回報它」（鏈上快照比對標籤用）。
 * MockUSDC 沒有覆寫 decimals()（OZ ERC20 預設 18）；Circle 官方 USDC 是 6；PepeToken 預設 18。
 */
const TOKENS = {
  MockUSDC: { file: "contracts/src/MockUSDC.sol", default: 18, ref: "MockUSDC", getter: "usdc()" },
  // Circle 官方 Base Sepolia USDC；位址的單一來源是 agent/shared/src/env.ts。
  USDC: { fixed: 6, constant: { file: "agent/shared/src/env.ts", name: "OFFICIAL_BASE_SEPOLIA_USDC" }, getter: "usdc()" },
  PepeToken: { file: "contracts/src/PepeToken.sol", default: 18, ref: "PepeToken", getter: "pepe()" },
};
const tokenGetter = (token) => TOKENS[token]?.getter ?? "usdc()";
/** 這些名稱只能用 `wrangler secret put` 設定，出現在 [vars] 就是把秘密寫進 repo。清單的來源是 params.mjs。 */
export const SECRET_NAMES = [...SECRET_ENV, "GITHUB_TOKEN"];
/** [vars] 允許的非參數鍵（公開資訊）與它們的格式：與執行期同一個解析器（params.mjs 的 ENV_SETTINGS）。 */
const EXTRA_VARS = Object.fromEntries(
  Object.entries(ENV_SETTINGS).map(([name, spec]) => [name, (v) => (spec.parse(String(v).trim()).problem ? `格式不對：${spec.doc}` : null)]),
);
/** network.publicRpc 只能是不需要金鑰的公開端點；含金鑰的 RPC 一律用 Worker secret RPC_URL。 */
export const PUBLIC_RPC_ALLOW = ["https://sepolia.base.org"];
/** 秘密掃描略過的本機目錄／檔案（必須同時列在 .gitignore，否則會被 commit 卻沒被掃到）。 */
const LOCAL_ONLY = [".dev.vars", ".wrangler"];
const GITIGNORE_REQUIRED = [".dev.vars", ".wrangler/"];

/**
 * 必要規則（審查 M4、複審 M-B）：每一條規則都登記在這裡，值是 [最低嚴重度, 必須的狀態, 定義的 sha256]。
 *   • 刪掉整條規則、改成 pending-deploy、調低嚴重度 → 紅。
 *   • **改了規則的任何內容 → 紅**：sha256 是「手寫欄位」（去掉 --write 產生的位址、topic0、selector、
 *     預期值…）排序鍵後序列化的雜湊。只鎖嚴重度與狀態時，把 insurance-wiring 的 exchange() 讀取刪掉、
 *     把 exchange-balance-drop 的 holder 換成別的合約、拿掉相對門檻，CI 都是綠的（複審 N1d、N2d、N5f–h）。
 *     產生欄位不在雜湊裡，因為它們已經逐一對照來源（addresses.ts、ABI、deployed.json）驗證。
 * 要改：改 monitors.json → --write → 檢查器印出新雜湊 → **人工審過改動**後把新雜湊貼到這裡。
 * 新增規則時一併登記。
 */
export const REQUIRED_RULES = {
  "owner-transferred": ["SEV-1", "active", "b4179173a5c8b87d675ad353fe1d9da0c970f66405fd5d29e396966432b57bd1"],
  "access-role-changed": ["SEV-1", "active", "d679eab5c775a27b1ee4ee03187b1b316f5b915e9250ebff731f5f9f6a7d449c"],
  "vault-upgraded": ["SEV-1", "active", "5a6c261e65b05b0b4ccca2d06f2bebe82285638a042936840ae5999be4d74d7b"],
  "exchange-agent-authorization": ["SEV-1", "active", "7cf697df61737e236db237b1a55114a3c1eed52196fe2d8c2cdaa2335cd5ad24"],
  "traderstake-copytracker-set": ["SEV-1", "active", "8f70b24fecc090ad1a51c8947fedb4ca7027a371d0637bfc6f55f199452bf562"],
  "kyc-verifier-changed": ["SEV-2", "pending-deploy", "a0699690843f2dac33afdfd940dcf336151409ca2484fce32f746559a9b59856"],
  "exchange-wiring-changed": ["SEV-1", "active", "ccb08201fca6ece947c84dc10cec73596dbd2ff0c62ce18d5513913b596e4922"],
  "insurance-wiring-changed": ["SEV-1", "pending-deploy", "e19d5e91e842124fca33ea1c953fea7ad088744739c69d9de80be9ada5181356"],
  "feerouter-config-changed": ["SEV-2", "pending-deploy", "90d2109a7b733053c95f50f73f74b1e289df5d9f80162bada77a8efc3fb80c4a"],
  "insurance-wiring": ["SEV-1", "active", "25b90b1bacb9f7824292a324f30b0e38acc31f0804c5f0844c8e0d003837394f"],
  "feerouter-wiring": ["SEV-1", "active", "eeaff5fa6b357e09352609a40f8cbba8ae5819b9a54871861f24e96d0aef739b"],
  "core-wiring": ["SEV-1", "active", "9ca3f119fdb8ce10197000521708eb733b19ced04930976daba48a22d5f96100"],
  "proxy-implementation": ["SEV-1", "active", "4dac4c95cf758408e8876bd33cfa59fb8b5ca54197de199039cd54b50e93198f"],
  "pepe-incentives-wiring": ["SEV-2", "active", "9d1100819a86f3d49729e3f030b2c9cddd3e00ba0fd1b4a0a570df753741a5d8"],
  "x402-payto": ["SEV-1", "active", "120e8c0092751a13807a6f7fdd0f9043bc87c37b46e4901609151770c0e73452"],
  "exchange-risk-params": ["SEV-3", "active", "1c9a902b822a3af688e97329971d71f2da2b0b29597a81136580eb5c6c434259"],
  "exchange-funding-clamped": ["SEV-3", "active", "f3a7f769cf509be28ac4e2ed86a0a704c36776522e58f8123dd6aeb5fc6b1b5b"],
  "vault-pause-changed": ["SEV-2", "active", "05614cf07553c73bd6ce64b24d07206ce694c25d8ad0c6df1ad4cc209088bb8b"],
  "pepe-incentives-pause": ["SEV-3", "active", "bfda7e66b8d8eb2fbc4178e6f46d17f72603bd7557a0c655865950bc1e46c015"],
  "vault-risk-params": ["SEV-3", "active", "4afe7d0da970af2385aa6cf532c57b84ed438e202d1a907a7d23dda3865e3268"],
  "asset-vault-v1-assets": ["SEV-3", "active", "1f00b8b650e483fef612e373af5703b9d681067a27cb14ef30865822d7dc3168"],
  "esg-registry-params": ["SEV-3", "active", "e4f654fb13c948bdf802cd8900ed88aaec8ccad614375238cf311f4d3a737984"],
  "esg-reward-params": ["SEV-3", "active", "ea78a3a7bbd0d6483908ede203c66556e8e8eec9dafb8a80a3b6201d3e350b66"],
  "pepe-claim-admin": ["SEV-3", "active", "af1d202129ed24619d95faaf4e9256badbbccbc257234df48b0feb877de7f333"],
  "vault-reserve-breached": ["SEV-2", "active", "e0ba958e802b3bc7ab8df2e4e60c37e15403c2b7af938028de60b721c0c01a25"],
  "guarded-oracle-guardian": ["SEV-2", "active", "340ca6fefe24812ee025f9759ff00c1bbd3883bb784b351c5c95f7ee76c1a94e"],
  "guarded-oracle-price-rejected": ["SEV-3", "active", "10732cf9d712ec8cad72ef7cbc9637b818ef1da52617537b32ecc496215f3ee9"],
  "mock-oracle-config": ["SEV-2", "active", "bb07e053e4e3873ff1b9a8b273b6fc6fb59b8c3881c3cb5b121d36b8deeb6be3"],
  "aggregator-oracle-config": ["SEV-2", "active", "91adce9f3f2e8a2a99f8ac3598a2de56795ef36b02785c293cf1de57bf740564"],
  "chainlink-adapter-config": ["SEV-2", "active", "63847006c9712ee3e438b513c914242836e845a7642dcfd4e2fd073d3908cb61"],
  "pyth-adapter-config": ["SEV-2", "active", "9a29c35fc92f3b560e62c60bae0a9ed29b16cc6ce528d618f6e06b56282f53ed"],
  "exchange-bad-debt": ["SEV-2", "active", "70972c507a17f743b923ea598a412d32b8cc664b2743869337f34b4e117e41f5"],
  "large-margin-withdrawal": ["SEV-2", "active", "fc9b3b0a4649918d4791b8424efdc79382a0415f26004dccd63016b6a8db94d8"],
  "insurance-withdrawal": ["SEV-2", "active", "928d488d08becea1c8377a336f3d27dea6b24dcaf512b514d1080d31242025ff"],
  "insurance-bailout": ["SEV-2", "active", "e3f5da0f28ea2293e366bfa61a353d63169c1abaa823df61a288461b2a8231f0"],
  "vault-large-redeem": ["SEV-2", "active", "1588a799c70a17cd5751e4fb110d8624362d828daf718455912fdce2fd481f2c"],
  "fee-withdrawals": ["SEV-3", "active", "4820fd911dcf975ffeb705409271c906f2b9fb9c79b9ce75a41bb77b90fe51cc"],
  "x402-fee-withdrawals": ["SEV-3", "active", "d188cbf8044cdebe08e9d8d7a7f9d9b75f531026fc03b4cecb43dfb6b3e4e130"],
  "vault-fees-withdrawn": ["SEV-3", "active", "0cec594f66b68246fb158181d88c1cc1201197dea6a90e5cfeda2002e3fd8320"],
  "oracle-stale": ["SEV-2", "active", "3d4268f0295b67690356d66cd6b11ea9ad96788d05a2e3b3cd40576928ebd613"],
  "oracle-deviation": ["SEV-2", "active", "162bb27b521d3775d6dbb6ea50176bbdd23ef206d57c99a4d863db7ca8eae7b1"],
  "guarded-oracle-paused": ["SEV-3", "active", "d291520ceab8de75f5330c19b6159e9d8f47a00e2f8af704d64ffe8da10e4b5b"],
  "exchange-balance-drop": ["SEV-2", "active", "e6afd7a9311f4014f737f1ea84a6bc45379bcfbf98ce3b836880e3648169624f"],
  "pepe-incentives-balance-drop": ["SEV-2", "active", "92941bfbb135f1ad50472b0b084dbd30c3a2984ebc6deca04af41ed596e99410"],
  "insurance-fund": ["SEV-2", "active", "8b485cfb1a22b5f9837934d8aaf89fb01fbe20738ede1a7e70032e80d789bba0"],
  "vault-reserve": ["SEV-2", "active", "4bb5187ed6df9d7a5341cf371968a80bf7067e0bfe34b435baff954ab8c823a8"],
  "keeper-gas": ["SEV-3", "active", "6c1973e862837b5e5e232da2931436b599276e949ad7dc024563dfc1320d30e8"],
  "signal-api-health": ["SEV-3", "active", "1ec853ee2afd0cf3ee8bd6a9232ffb27e107bc0464f0d96d0cbdff9d0151ec69"],
  "exchange-pause": ["SEV-1", "pending-deploy", "5fe895a21c13de8449c5f91bfaca597b67cc9d3042161da199f2023df9121afd"],
  "exchange-asset-mode": ["SEV-2", "pending-deploy", "ed30b8f122a0263551e930d18c7204655d447f4c4131df694e4eef510116cff7"],
  "exchange-guardian-roles": ["SEV-1", "pending-deploy", "1d91732b5d90fcfe2311ce4014517a81079034aae6117fd3ecedee03cc0e84bb"],
  "exchange-exposure-caps": ["SEV-3", "pending-deploy", "d9b49399d08536d08944c5f32dcf84aaac2ea521f6d5835c89c17aafc613e63e"],
  "timelock-operations": ["SEV-2", "pending-deploy", "0d275c5eae13b8ef21b4ad53512fb53b32cdff4af23b46be91298d3463107ee1"],
  "vault-unpriced-exemption": ["SEV-2", "pending-deploy", "9e6b3f9ddbb957cc04d6ed0f0be608d1220e7a98df1290f63df0c1c525893505"],
  "guarded-oracle-window": ["SEV-3", "pending-deploy", "3cb1cb7086d1f110bad42185a852f2676206856c8e653836297a0ca159c72b4e"],
  "copytracker-slash-reserve": ["SEV-2", "pending-deploy", "d28fa46a7e82c7224d01f9545d83008dce38ded17d9056e91b10744155e30bec"],
  "guarded-oracle-halt-window": ["SEV-2", "pending-deploy", "7a7a5276534fe0a7f217266ab0b16f84a9894b4f62ccf99c41a894d3b29917d4"],
  "guarded-oracle-halt-takeover": ["SEV-1", "pending-deploy", "e0e0c332c4162fa39ac63b1e98a63c2fd25c4b6cc9a878beabc089151c78b6f2"],
  "pepe-incentives-daily-params": ["SEV-3", "pending-deploy", "eebc20b3321d42ec0a142221791d336c658bbcbbf1a7c95b6c12c6c30a243b92"],
};

/**
 * 參數的型別與範圍（審查 M4、複審 M-1）：單一來源是 ops/monitoring/params.mjs，Worker 執行期 import
 * 同一張表夾值。這裡 re-export 給測試與其他工具用。
 */
export { PARAM_SPECS, paramComboProblems };

/**
 * 全域設定的釘選雜湊（複審 L-3）：參數預設值、network（explorer、區塊時間…）、repoBlobBase、deployment。
 * 規則雜湊（REQUIRED_RULES）只釘「參照哪個參數名」，不釘參數值；把 ORACLE_DEVIATION_CRIT_BPS 預設值
 * 調到 10000、把 explorer 換成別人的網域，原本 CI 都是綠的。改了這些 → 紅，並印出新雜湊；
 * **人工審過改動**後把新雜湊貼到這裡。
 */
export const GLOBAL_CONFIG_HASH = "019835e593e922c4581583f41e2d881965787b21953f4f5ea817fa6bf5cc6594";
/** 告警訊息裡 tx 連結的網域（白名單）。 */
export const EXPLORER_ALLOW = ["https://sepolia.basescan.org"];
/** 告警訊息裡「處置」連結的前綴：只能指向本 repo。 */
export const REPO_BLOB_PREFIX = "https://github.com/zuemen/pepelab_onchain_cfd/blob/";
/** 全域設定裡納入雜湊的部分。 */
export function globalConfigView(cfg) {
  return {
    version: cfg.version,
    deployment: cfg.deployment,
    network: cfg.network,
    repoBlobBase: cfg.repoBlobBase,
    params: Object.fromEntries(Object.entries(cfg.params ?? {}).map(([k, v]) => [k, v?.default])),
  };
}
export const globalConfigHash = (cfg) => createHash("sha256").update(canonicalJson(globalConfigView(cfg))).digest("hex");
/** 全域設定：雜湊、explorer／repo 網域白名單、區塊時間範圍。 */
export function checkGlobalConfig(cfg) {
  const out = [];
  const h = globalConfigHash(cfg);
  if (h !== GLOBAL_CONFIG_HASH) {
    out.push(
      `(全域)：全域設定（參數預設值、network、repoBlobBase、deployment）與 scripts/check-monitoring.mjs 的 GLOBAL_CONFIG_HASH 不同（現在 ${h}，釘的是 ${GLOBAL_CONFIG_HASH}）—— ` +
        "人工審過改動（門檻有沒有被調到等於關掉告警、連結網域對不對）後，再把新雜湊更新到 GLOBAL_CONFIG_HASH",
    );
  }
  if (!EXPLORER_ALLOW.includes(cfg.network?.explorer)) out.push(`(全域)：network.explorer 必須是 ${EXPLORER_ALLOW.join("、")}（告警裡每個 tx 連結都用它）`);
  if (typeof cfg.repoBlobBase !== "string" || !cfg.repoBlobBase.startsWith(REPO_BLOB_PREFIX) || !/^[A-Za-z0-9._/-]+$/.test(cfg.repoBlobBase.slice(REPO_BLOB_PREFIX.length))) {
    out.push(`(全域)：repoBlobBase 必須以 ${REPO_BLOB_PREFIX} 開頭（告警裡的「處置」連結）`);
  }
  const bt = cfg.network?.blockTimeSec;
  if (!Number.isInteger(bt) || bt < 1 || bt > 12) out.push(`(全域)：network.blockTimeSec 必須是 1–12 的整數，現在是 ${JSON.stringify(bt)}`);
  if (cfg.deployment?.chainId !== cfg.network?.chainId) out.push("(全域)：deployment.chainId 必須等於 network.chainId");
  return out;
}

/**
 * 可以被 MUTE_KEYS 靜音的告警 key（複審 M-A）。執行期只認 monitors.json 的 mutableKeys；這裡再釘一次，
 * 讓「把 x402-payto:changed 加進白名單」也要改檢查器（人工審過）。每一項必須是某條規則的子 key、
 * 不可以是 SEV-1 的輸出、不可以是 monitor-self。
 */
export const MUTABLE_KEYS = ["x402-payto:unsafe"];

// ── 小工具 ───────────────────────────────────────────────────────────────────

const read = (root, p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const lc = (s) => String(s).toLowerCase();

/** GitHub 標題錨點（github-slugger 的規則：去標點、小寫、空白換成 -）。 */
export function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Markdown 標題（略過 code fence 裡的）。 */
export function headingsOf(md) {
  const out = new Set();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (m) out.add(m[1]);
  }
  return out;
}

function braceBlock(src, start) {
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

// ── ABI 與 Solidity ──────────────────────────────────────────────────────────

const canonicalType = (inp) => {
  if (inp.type.startsWith("tuple")) return `(${inp.components.map(canonicalType).join(",")})${inp.type.slice(5)}`;
  return inp.type;
};
export const abiSig = (item) => `${item.name}(${item.inputs.map(canonicalType).join(",")})`;

/** 掃 contracts/src 收集 enum 與 contract/interface/library 名稱（事件參數型別正規化用）。 */
function solTypeNames(root) {
  const enums = new Set();
  const contracts = new Set(["IERC20", "IERC20Metadata"]);
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".sol")) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\benum\s+(\w+)/g)) enums.add(m[1]);
        for (const m of src.matchAll(/\b(?:contract|interface|library)\s+(\w+)/g)) contracts.add(m[1]);
      }
    }
  };
  walk(join(root, "contracts/src"));
  return { enums, contracts };
}

/** 解析 Solidity 原始碼裡的 event 宣告 → [{ sig, inputs:[{name,type,indexed}] }]。 */
export function parseSolEvents(src, { enums = new Set(), contracts = new Set() } = {}) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const local = solTypeNamesFrom(clean);
  const isEnum = (t) => enums.has(t) || local.enums.has(t);
  // 介面慣例 I + 大寫開頭（IERC20 等，宣告在 lib 裡）也視為 address。
  const isContract = (t) => contracts.has(t) || local.contracts.has(t) || /^I[A-Z]\w*$/.test(t);
  const norm = (t) => {
    const m = t.match(/^([\w.]+)((?:\[\d*\])*)$/);
    if (!m) throw new Error(`無法解析的型別 ${t}`);
    let base = m[1].split(".").pop();
    if (base === "uint") base = "uint256";
    else if (base === "int") base = "int256";
    else if (isEnum(base)) base = "uint8";
    else if (isContract(base)) base = "address";
    return base + m[2];
  };
  const out = [];
  for (const m of clean.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*(anonymous\s*)?;/g)) {
    const inputs = m[2]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => {
        const parts = p.split(/\s+/);
        const indexed = parts.includes("indexed");
        const rest = parts.filter((x) => x !== "indexed");
        return { name: rest.length > 1 ? rest[rest.length - 1] : "", type: norm(rest[0]), indexed };
      });
    out.push({ name: m[1], sig: `${m[1]}(${inputs.map((i) => i.type).join(",")})`, inputs });
  }
  return out;
}
function solTypeNamesFrom(src) {
  return {
    enums: new Set([...src.matchAll(/\benum\s+(\w+)/g)].map((m) => m[1])),
    contracts: new Set([...src.matchAll(/\b(?:contract|interface|library)\s+(\w+)/g)].map((m) => m[1])),
  };
}

// ── 來源載入 ─────────────────────────────────────────────────────────────────

/**
 * 讀 repo 的所有來源。回傳 ctx：位址解析、ABI、原始碼事件、文件標題、角色、資產 ID…
 */
export function loadContext(root) {
  const addressesSrc = read(root, "frontend/src/contracts/addresses.ts");
  const chains = parseFrontendConfig(
    addressesSrc,
    read(root, "frontend/src/contracts/sessionManager.ts"),
    read(root, "frontend/src/contracts/x402.ts"),
  );

  // V2_STACK[84532].tokens：parseFrontendConfig 只取最外層鍵，代幣在巢狀區塊裡，這裡另外取。
  const v2Tokens = {};
  {
    const i = addressesSrc.indexOf("export const V2_STACK");
    const body = braceBlock(addressesSrc, addressesSrc.indexOf("= {", i));
    const j = body?.search(/\b84532\s*:\s*\{/) ?? -1;
    const chainBlock = j >= 0 ? braceBlock(body, j) : null;
    const t = chainBlock?.indexOf("tokens") ?? -1;
    const tokBlock = t >= 0 ? braceBlock(chainBlock, t) : "";
    for (const m of (tokBlock ?? "").matchAll(/(\w+)\s*:\s*["'](0x[0-9a-fA-F]{40})["']/g)) v2Tokens[m[1]] = m[2];
  }

  // ASSET_IDS
  const assetIds = {};
  {
    const block = braceBlock(addressesSrc, addressesSrc.indexOf("export const ASSET_IDS"));
    for (const m of (block ?? "").matchAll(/(\w+)\s*:\s*["'](0x[0-9a-fA-F]{64})["']/g)) assetIds[m[1]] = m[2];
  }

  // 位址來源的說明文字（給 rules.md）。
  const showcase = new Set(["ChainlinkAdapter", "PythAdapter", "AggregatorOracle"]);
  const v2Keys = new Set(["GuardedOracle", "AssetVaultV2", "ESGRegistryV2", "SustainabilityBadge"]);
  const resolveRef = (ref, chainId = "84532") => {
    if (ref.startsWith("V2_STACK.tokens.")) {
      const sym = ref.slice("V2_STACK.tokens.".length);
      return { address: v2Tokens[sym] ?? null, source: `addresses.ts V2_STACK[${chainId}].tokens.${sym}` };
    }
    const address = chains[chainId]?.roles[ref] ?? null;
    let source = `addresses.ts BASE_SEPOLIA.${ref}`;
    if (showcase.has(ref)) source = `addresses.ts BASE_SEPOLIA_ORACLE_SHOWCASE.${ref}`;
    else if (v2Keys.has(ref)) source = `addresses.ts V2_STACK[${chainId}].${ref}`;
    else if (ref === "X402FeeRouter") source = `x402.ts X402_FEE_ROUTER[${chainId}]`;
    else if (ref === "AgentSessionManager") source = `sessionManager.ts SESSION_MANAGER_ADDRESS[${chainId}]`;
    return { address, source };
  };

  const abiDir = join(root, "frontend/src/contracts/abi");
  const abis = {};
  for (const f of readdirSync(abiDir).filter((f) => f.endsWith(".json"))) {
    const j = JSON.parse(readFileSync(join(abiDir, f), "utf8"));
    abis[f.replace(/\.json$/, "")] = Array.isArray(j) ? j : j.abi;
  }

  const typeNames = solTypeNames(root);
  // contracts/src 裡宣告過的所有事件簽章（涵蓋檢查用：找出「部署版會發、但前端 ABI 沒有」的事件）。
  const solSigs = new Set();
  {
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f);
        if (statSync(fp).isDirectory()) walk(fp);
        else if (f.endsWith(".sol")) {
          try {
            for (const e of parseSolEvents(readFileSync(fp, "utf8"), typeNames)) solSigs.add(e.sig);
          } catch {
            /* 解析不了的型別（struct 參數等）：略過那個檔案的事件 */
          }
        }
      }
    };
    walk(join(root, "contracts/src"));
  }
  const solCache = {};
  const solEvents = (path) => {
    if (!(path in solCache)) {
      const full = join(root, path);
      solCache[path] = existsSync(full) ? parseSolEvents(readFileSync(full, "utf8"), typeNames) : null;
    }
    return solCache[path];
  };

  // 角色雜湊 → 名稱：從 contracts/src 的 `X_ROLE = keccak256("X_ROLE")` 收集，加上 DEFAULT_ADMIN_ROLE。
  const roleNames = { ["0x" + "0".repeat(64)]: "DEFAULT_ADMIN_ROLE" };
  {
    const walk = (dir) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".sol")) {
          for (const m of readFileSync(p, "utf8").matchAll(/constant\s+(\w+_ROLE)\s*=\s*keccak256\("(\w+)"\)/g)) {
            roleNames[keccak256(m[2])] = m[1];
          }
        }
      }
    };
    walk(join(root, "contracts/src"));
  }

  const docHeadings = {};
  const headings = (doc) => {
    if (!(doc in docHeadings)) docHeadings[doc] = existsSync(join(root, doc)) ? headingsOf(read(root, doc)) : null;
    return docHeadings[doc];
  };

  const tokenDecimals = (token) => {
    const t = TOKENS[token];
    if (!t) throw new Error(`未知的代幣 ${token}（只認得 ${Object.keys(TOKENS).join("/")}）`);
    if (t.fixed !== undefined) return t.fixed;
    const src = read(root, t.file);
    if (/function\s+decimals\s*\(/.test(src)) {
      throw new Error(`${t.file} 覆寫了 decimals()，請更新 check-monitoring.mjs 的 TOKENS`);
    }
    return t.default;
  };

  /** 代幣標籤 → 位址（MockUSDC 來自 addresses.ts；官方 USDC 來自 agent/shared/src/env.ts 的常數）。 */
  const tokenAddress = (token) => {
    const t = TOKENS[token];
    if (!t) throw new Error(`未知的代幣 ${token}（只認得 ${Object.keys(TOKENS).join("/")}）`);
    if (t.ref) return resolveRef(t.ref).address;
    const m = read(root, t.constant.file).match(new RegExp(`${t.constant.name}\\s*=\\s*["'](0x[0-9a-fA-F]{40})["']`));
    if (!m) throw new Error(`${t.constant.file} 找不到 ${t.constant.name}`);
    return m[1];
  };

  const sdkUrl = read(root, "agent/sdk/src/signalApi.ts").match(/SIGNAL_API_TESTNET_URL\s*=\s*"([^"]+)"/)?.[1] ?? null;

  const deployed = loadDeployed(root);
  return { root, chains, v2Tokens, assetIds, resolveRef, abis, solEvents, roleNames, headings, tokenDecimals, tokenAddress, sdkUrl, deployed, solSigs };
}

// ── 已部署 bytecode 與鏈上快照（deployed.json）────────────────────────────────

const hexToBytes = (hex) => {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const readKey = (address, fn) => `${lc(address)}|${fn}`;
const wordToAddr = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0").slice(24);

/**
 * 讀 deployed.json，回傳查詢介面（檔案不存在時每個查詢都回 null，由呼叫端報「需要 --refresh-deployed」）。
 *   codeOf(addr)          → 該位址的 runtime bytecode（proxy 則接上實作的 bytecode），沒有記錄回 null
 *   hasTopic(addr, sig)   → 事件 topic0 是否出現在 bytecode；沒有記錄回 null
 *   hasSelector(addr, fn) → 函式 selector 是否出現在 bytecode；沒有記錄回 null
 *   read(addr, fn)        → 該 getter 的鏈上快照（位址或數值的 32 bytes hex）；沒有記錄回 null
 *
 * 為什麼存完整 bytecode 而不是「PUSH32 常數清單」：線性反組譯會被資料段帶偏，實測 2026-10-01
 * 在 PerpetualExchange.PositionClosed 與 AssetVaultV2.RoleGranted 上漏判；子字串比對沒有這個問題。
 */
export function loadDeployed(root) {
  const file = join(root, DEPLOYED_FILE);
  const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  const cache = new Map();
  const codeOf = (address) => {
    const k = lc(address ?? "");
    if (cache.has(k)) return cache.get(k);
    const c = data?.contracts?.[k];
    let code = null;
    if (c) {
      const own = data.codes?.[c.codeHash];
      const impl = c.implCodeHash ? data.codes?.[c.implCodeHash] : "";
      if (typeof own === "string" && typeof impl === "string") code = (own + impl.replace(/^0x/, "")).toLowerCase();
    }
    cache.set(k, code);
    return code;
  };
  const hashes = new Map(); // 簽章 → keccak256（BigInt 實作慢，同一個簽章會被問很多次）
  const hashOf = (sig) => {
    if (!hashes.has(sig)) hashes.set(sig, keccak256(sig));
    return hashes.get(sig);
  };
  const hasHex = (address, hex) => {
    const code = codeOf(address);
    return code === null ? null : code.includes(hex.replace(/^0x/, "").toLowerCase());
  };
  return {
    data,
    codeOf,
    hasTopic: (address, sig) => (codeOf(address) === null ? null : hasHex(address, hashOf(sig))),
    hasSelector: (address, fn) => (codeOf(address) === null ? null : hasHex(address, hashOf(fn).slice(0, 10))),
    read: (address, fn) => data?.reads?.[readKey(address, fn)] ?? null,
    implOf: (address) => data?.contracts?.[lc(address ?? "")]?.impl ?? null,
  };
}

/**
 * deployed.json 應該涵蓋什麼：每條規則的合約位址（pending-deploy 規則的合約若已有位址也算，
 * 用來確認「部署版真的不發這個事件」）、接線規則的每個 getter、金額規則的代幣與小數位。
 */
export function deployedTargets(cfg, ctx) {
  const addresses = new Map(); // lc(addr) → ref（僅供訊息用）
  const reads = new Map(); // readKey → { to, fn }
  const tokenHolders = new Map(); // lc(addr) → ref：要讀 usdc() 再讀該代幣 decimals() 的合約
  const addrOf = (ref) => {
    const a = ctx.resolveRef(ref).address;
    return a && ADDR.test(a) && lc(a) !== ZERO ? a : null;
  };
  for (const rule of cfg.rules ?? []) {
    for (const c of rule.contracts ?? []) {
      const a = addrOf(c.ref);
      if (!a) continue;
      if (!addresses.has(lc(a))) addresses.set(lc(a), c.ref);
      if (rule.status === "active" && (rule.amount || rule.token)) {
        const abi = ctx.abis[c.abi];
        const getter = tokenGetter(rule.amount?.token ?? rule.token);
        if (abi?.some((x) => x.type === "function" && abiSig(x) === getter)) tokenHolders.set(`${lc(a)}|${getter}`, { address: lc(a), ref: c.ref, getter });
      }
    }
    if (rule.status === "active" && rule.check === "wiring") {
      for (const call of rule.calls ?? []) {
        const c = (rule.contracts ?? []).find((x) => x.as === call.on);
        const a = c && addrOf(c.ref);
        if (a) reads.set(readKey(a, call.fn), { to: a, fn: call.fn });
      }
    }
  }
  return { addresses, reads, tokenHolders };
}

/** deployed.json 自身的完整性：雜湊對得上內容、沒有缺也沒有多。回傳 problems。 */
export function checkDeployed(cfg, ctx) {
  const problems = [];
  const d = ctx.deployed.data;
  const hint = "執行 node scripts/check-monitoring.mjs --refresh-deployed（唯讀 RPC）後再 --write";
  if (!d) return [`${DEPLOYED_FILE} 不存在 —— ${hint}`];
  if (d.chainId !== cfg.network?.chainId) problems.push(`${DEPLOYED_FILE} 的 chainId ${d.chainId} 不等於 network.chainId ${cfg.network?.chainId}`);
  for (const [hash, code] of Object.entries(d.codes ?? {})) {
    if (!/^0x([0-9a-f]{2})+$/.test(code)) problems.push(`${DEPLOYED_FILE} codes[${hash}] 不是合法的 hex bytecode`);
    else if (keccak256(hexToBytes(code)) !== hash) problems.push(`${DEPLOYED_FILE} codes[${hash}] 的內容與雜湊不符（被手改？）—— ${hint}`);
  }
  const { addresses, reads, tokenHolders } = deployedTargets(cfg, ctx);
  for (const [a, ref] of addresses) {
    if (ctx.deployed.codeOf(a) === null) problems.push(`${DEPLOYED_FILE} 沒有 ${ref}（${a}）的 bytecode：位址換了或 fixture 過期 —— ${hint}`);
  }
  for (const a of Object.keys(d.contracts ?? {})) {
    if (!addresses.has(a)) problems.push(`${DEPLOYED_FILE} 多了沒有規則在用的位址 ${a} —— ${hint}`);
  }
  for (const [k, r] of reads) {
    if (d.reads?.[k] === undefined) problems.push(`${DEPLOYED_FILE} 沒有 ${r.to} ${r.fn} 的鏈上快照 —— ${hint}`);
  }
  for (const { address: a, ref, getter } of tokenHolders.values()) {
    const tok = d.reads?.[readKey(a, getter)];
    if (!tok) problems.push(`${DEPLOYED_FILE} 沒有 ${ref}.${getter} 的鏈上快照 —— ${hint}`);
    else if (d.reads?.[readKey(wordToAddr(tok), "decimals()")] === undefined) problems.push(`${DEPLOYED_FILE} 沒有代幣 ${wordToAddr(tok)} 的 decimals() 快照 —— ${hint}`);
  }
  return problems;
}

/**
 * 以唯讀 RPC 重抓 deployed.json。只用 eth_chainId／eth_blockNumber／eth_getCode／eth_getStorageAt／
 * eth_call，全部釘在同一個區塊；不送交易、不需要任何金鑰。CI 不跑這個（CI 不連網）。
 */
export async function refreshDeployed({ root, rpcUrl, fetchImpl = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), today = new Date().toISOString().slice(0, 10), write = true }) {
  const ctx = loadContext(root);
  const cfg = JSON.parse(readFileSync(join(root, "ops/monitoring/monitors.json"), "utf8"));
  const url = rpcUrl ?? cfg.network.publicRpc;
  const ALLOWED = new Set(["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);
  let id = 1;
  const rpc = async (method, params) => {
    if (!ALLOWED.has(method)) throw new Error(`refresh 不允許的 RPC 方法 ${method}`);
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
      const text = await res.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* 非 JSON */
      }
      const limited = res.status === 429 || j?.error?.code === -32007 || /limit reached|rate limit/i.test(j?.error?.message ?? "");
      if (limited || res.status >= 500) {
        await sleep(1500);
        continue;
      }
      if (!res.ok || !j) throw new Error(`${method} HTTP ${res.status}：${text.slice(0, 160)}`);
      return j; // { result } 或 { error }（eth_call revert）
    }
    throw new Error(`${method} 連續被限流或 5xx`);
  };
  const must = async (method, params) => {
    const j = await rpc(method, params);
    if (j.error) throw new Error(`${method} ${JSON.stringify(params[0]).slice(0, 80)}：${j.error.message}`);
    return j.result;
  };

  const chainId = Number(BigInt(await must("eth_chainId", [])));
  if (chainId !== cfg.network.chainId) throw new Error(`RPC 的 chainId ${chainId} 不是 ${cfg.network.chainId}`);
  const block = await must("eth_blockNumber", []);
  const out = { chainId, block: Number(BigInt(block)), fetchedAt: today, contracts: {}, reads: {}, codes: {} };
  const addCode = (code) => {
    const hash = keccak256(hexToBytes(code));
    out.codes[hash] = code.toLowerCase();
    return hash;
  };
  const { addresses, reads, tokenHolders } = deployedTargets(cfg, ctx);
  for (const [a, ref] of [...addresses].sort()) {
    const code = await must("eth_getCode", [a, block]);
    if (code === "0x") throw new Error(`${ref}（${a}）在鏈上沒有程式碼`);
    const slot = await must("eth_getStorageAt", [a, IMPL_SLOT, block]);
    const entry = { ref, codeHash: addCode(code), impl: null, implCodeHash: null };
    if (BigInt(slot) !== 0n) {
      entry.impl = wordToAddr(slot);
      entry.implCodeHash = addCode(await must("eth_getCode", [entry.impl, block]));
    }
    out.contracts[a] = entry;
    log(`  ${ref} ${a} ${(code.length - 2) / 2} bytes${entry.impl ? `（實作 ${entry.impl}）` : ""}`);
  }
  const call = async (to, fn) => {
    const j = await rpc("eth_call", [{ to, data: selector(fn) }, block]);
    if (j.error) throw new Error(`eth_call ${to} ${fn} 失敗：${j.error.message}（部署版沒有這個函式？）`);
    out.reads[readKey(to, fn)] = j.result;
    return j.result;
  };
  for (const [, r] of [...reads].sort()) await call(r.to, r.fn);
  for (const [, { address: a, getter }] of [...tokenHolders].sort()) {
    const tok = wordToAddr(await call(a, getter));
    if (out.reads[readKey(tok, "decimals()")] === undefined) await call(tok, "decimals()");
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  const file = {
    $comment:
      "已部署合約的 runtime bytecode 與幾個 getter 的鏈上快照。由 node scripts/check-monitoring.mjs --refresh-deployed 以唯讀 RPC 產生，不要手改（CI 會驗 codes 的 keccak256）。用途：確認 active 事件的 topic0 與 state 規則的 selector 真的在部署版 bytecode 裡、接線規則的預期值等於鏈上實況、金額小數位等於代幣的 decimals()。合約重新部署、UUPS 升級或新增規則後要重抓。",
    chainId: out.chainId,
    block: out.block,
    fetchedAt: out.fetchedAt,
    contracts: sorted(out.contracts),
    reads: sorted(out.reads),
    codes: sorted(out.codes),
  };
  if (write) {
    writeFileSync(join(root, DEPLOYED_FILE), JSON.stringify(file, null, 1) + "\n");
    log(`已寫入 ${DEPLOYED_FILE}：區塊 ${out.block}，${Object.keys(out.contracts).length} 個位址、${Object.keys(out.codes).length} 份 bytecode、${Object.keys(out.reads).length} 個快照`);
  }
  return file;
}

/**
 * 每週排程用（.github/workflows/monitoring-fixture.yml，複審 L-c）：以唯讀 RPC 重抓一份到記憶體，
 * 與 repo 內的 deployed.json 比對（不比區塊號與日期）。回傳差異文字陣列；空陣列＝fixture 仍是鏈上實況。
 * 不寫檔、不 commit：有差異時由人重抓、審過、走 PR。
 */
export async function verifyDeployed(opts) {
  const { root } = opts;
  const file = join(root, DEPLOYED_FILE);
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  if (!cur) return [`${DEPLOYED_FILE} 不存在`];
  const fresh = await refreshDeployed({ ...opts, write: false });
  const diffs = [];
  if (cur.chainId !== fresh.chainId) diffs.push(`chainId ${cur.chainId} → ${fresh.chainId}`);
  for (const a of new Set([...Object.keys(cur.contracts ?? {}), ...Object.keys(fresh.contracts ?? {})])) {
    const x = cur.contracts?.[a];
    const y = fresh.contracts?.[a];
    if (!x || !y) diffs.push(`${a}：${x ? "規則已不再監控這個位址（fixture 多了）" : "fixture 沒有這個位址"}`);
    else {
      if (x.codeHash !== y.codeHash) diffs.push(`${y.ref} ${a}：runtime bytecode 變了（${x.codeHash.slice(0, 10)}… → ${y.codeHash.slice(0, 10)}…）`);
      if ((x.impl ?? null) !== (y.impl ?? null)) diffs.push(`${y.ref} ${a}：EIP-1967 實作 ${x.impl} → ${y.impl}（升級了）`);
      else if ((x.implCodeHash ?? null) !== (y.implCodeHash ?? null)) diffs.push(`${y.ref} ${a}：實作 bytecode 變了`);
    }
  }
  for (const k of new Set([...Object.keys(cur.reads ?? {}), ...Object.keys(fresh.reads ?? {})])) {
    if (cur.reads?.[k] !== fresh.reads?.[k]) diffs.push(`快照 ${k}：${cur.reads?.[k] ?? "（無）"} → ${fresh.reads?.[k] ?? "（無）"}`);
  }
  return diffs;
}

// ── 產生 ─────────────────────────────────────────────────────────────────────

/** 去掉一條規則裡由 --write 產生的欄位（就地修改），剩下的是手寫的定義。 */
function stripRule(r) {
  delete r.runbookUrl;
  delete r.decimals;
  if (r.amount) {
    delete r.amount.decimals;
    delete r.amount.balanceOf;
  }
  for (const k of r.contracts ?? []) {
    delete k.address;
    delete k.impl;
  }
  for (const e of r.events ?? []) {
    delete e.topic0;
    delete e.inputs;
  }
  for (const call of r.calls ?? []) {
    delete call.selector;
    delete call.expected;
  }
  return r;
}
const strip = (cfg) => {
  const c = structuredClone(cfg);
  delete c.assets;
  delete c.assetLabels;
  delete c.roleNames;
  for (const r of c.rules ?? []) stripRule(r);
  return c;
};

/** 排序鍵後序列化（canonical JSON）：鍵的順序、縮排不影響結果。 */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
/** 規則定義（手寫欄位）的 sha256。 */
export const ruleHash = (rule) => createHash("sha256").update(canonicalJson(stripRule(structuredClone(rule)))).digest("hex");

/**
 * 從手寫欄位與 repo 來源算出完整設定。回傳 { config, problems }：problems 是
 * 無法產生的錯（未知合約、ABI 裡沒有的事件…），這些用 --write 也修不好。
 */
export function generate(input, ctx) {
  const problems = [];
  const cfg = strip(input);
  const p = (rule, msg) => problems.push(`${rule?.id ?? "(全域)"}：${msg}`);

  const ids = new Set();
  for (const rule of cfg.rules ?? []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(rule.id ?? "")) p(rule, "id 必須是小寫 kebab-case");
    if (ids.has(rule.id)) p(rule, "id 重複");
    ids.add(rule.id);
    if (!KINDS.includes(rule.kind)) p(rule, `kind 必須是 ${KINDS.join("/")}`);
    if (!STATUSES.includes(rule.status)) p(rule, `status 必須是 ${STATUSES.join("/")}`);
    if (!SEVERITIES.includes(rule.severity)) p(rule, `severity 必須是 ${SEVERITIES.join("/")}`);
    for (const f of ["title", "description", "category"]) if (!rule[f]) p(rule, `缺少 ${f}`);
    const active = rule.status === "active";

    // 合約位址
    for (const c of rule.contracts ?? []) {
      if (active) {
        if (!c.abi) p(rule, `${c.ref}：active 規則必須指定 abi`);
        else if (!ctx.abis[c.abi]) p(rule, `${c.ref}：frontend/src/contracts/abi/${c.abi}.json 不存在`);
        const { address } = ctx.resolveRef(c.ref);
        if (!address || !ADDR.test(address) || lc(address) === ZERO) {
          p(rule, `${c.ref}：前端設定裡解析不到 chain 84532 的位址（或為零位址）`);
          c.address = null;
        } else c.address = address;
      } else {
        if (!c.source) p(rule, `${c.ref}：pending-deploy 規則必須指定 source（Solidity 原始碼路徑）`);
        else if (!ctx.solEvents(c.source)) p(rule, `${c.ref}：原始碼 ${c.source} 不存在（CI 需要 submodules）`);
        c.address = null; // 未部署：不給位址，Worker 也不載入
      }
    }

    // 事件
    if (rule.kind === "event") {
      if (!rule.events?.length) p(rule, "event 規則至少要有一個事件");
      for (const ev of rule.events ?? []) {
        ev.topic0 = keccak256(ev.sig);
        let inputs = null;
        for (const c of rule.contracts ?? []) {
          let found;
          if (active) {
            const abi = ctx.abis[c.abi];
            if (!abi) continue;
            found = abi.find((x) => x.type === "event" && abiSig(x) === ev.sig);
            if (!found) {
              p(rule, `${ev.sig} 不在 ${c.abi}.json 的 ABI 裡（${c.ref}）——監控一個不存在的事件永遠不會響`);
              continue;
            }
            found = { inputs: found.inputs.map((i) => ({ name: i.name, type: canonicalType(i), indexed: !!i.indexed })) };
          } else {
            const evs = c.source ? ctx.solEvents(c.source) : null;
            if (!evs) continue;
            found = evs.find((x) => x.sig === ev.sig);
            if (!found) {
              p(rule, `${ev.sig} 沒有宣告在 ${c.source}`);
              continue;
            }
          }
          if (!inputs) inputs = found.inputs;
          else if (JSON.stringify(inputs) !== JSON.stringify(found.inputs)) {
            p(rule, `${ev.sig} 在不同合約的參數名稱或 indexed 不一致（${c.ref}），解碼會錯`);
          }
        }
        ev.inputs = inputs ?? [];
        checkEventDeployed(rule, ev, ctx, p);
      }
      if (active && (rule.events ?? []).length && (rule.contracts ?? []).length && ctx.deployed.data) {
        const live = rule.events.some((ev) => rule.contracts.some((c) => c.address && ctx.deployed.hasTopic(c.address, ev.sig) !== false));
        if (!live) p(rule, "沒有任何一個事件出現在已部署的 bytecode 裡：這條規則永遠不會響，必須改成 pending-deploy（並補一條狀態規則）");
      }
      if (rule.amount) {
        const a = rule.amount;
        if ((rule.events ?? []).length !== 1) p(rule, "amount 規則只能有一個事件");
        const inp = rule.events?.[0]?.inputs?.find((i) => i.name === a.param);
        if (!inp) p(rule, `amount.param ${a.param} 不是事件參數`);
        else if (inp.indexed || !/^uint\d*$/.test(inp.type)) p(rule, `amount.param ${a.param} 必須是非 indexed 的 uint`);
        for (const k of ["threshold", "windowThreshold", "windowSec", "relativeBps"]) {
          if (a[k] && !cfg.params?.[a[k]]) p(rule, `amount.${k} 參照未定義的參數 ${a[k]}`);
        }
        if (!a.threshold) p(rule, "amount 規則必須有 threshold");
        if (!!a.windowThreshold !== !!a.windowSec) p(rule, "windowThreshold 與 windowSec 必須同時設定");
        try {
          a.decimals = ctx.tokenDecimals(a.token);
          if (active) checkTokenOnChain(rule, a.token, a.decimals, ctx, p);
          // 相對門檻：讀「該代幣在發出事件的合約裡的餘額」。
          if (a.relativeBps) a.balanceOf = { token: ctx.tokenAddress(a.token), selector: selector("balanceOf(address)") };
        } catch (e) {
          p(rule, e.message);
        }
      }
    } else if (rule.events) p(rule, "只有 event 規則可以有 events");

    // state：函式與 selector
    if (rule.kind === "state") {
      if (!engineInternal.checks[rule.check]) p(rule, `未知的 state 檢查 ${rule.check}`);
      for (const call of rule.calls ?? []) {
        const c = (rule.contracts ?? []).find((x) => x.as === call.on);
        if (!c) {
          p(rule, `calls.on=${call.on} 沒有對應的 contracts[].as`);
          continue;
        }
        const abi = ctx.abis[c.abi];
        const fnAbi = abi?.find((x) => x.type === "function" && abiSig(x) === call.fn);
        if (abi && !fnAbi) p(rule, `${call.fn} 不在 ${c.abi}.json 的 ABI 裡`);
        call.selector = selector(call.fn);
        if (active && c.address && ctx.deployed.hasSelector(c.address, call.fn) === false) {
          p(rule, `${call.fn} 的 selector 不在 ${c.ref} 已部署的 bytecode 裡 —— 部署版沒有這個函式，讀取只會 revert`);
        }
        if (rule.check === "wiring") checkWiringCall(rule, c, call, fnAbi, ctx, p);
        else if (call.expect) p(rule, `只有 wiring 檢查的 calls 可以有 expect（${call.fn}）`);
      }
      if (rule.check === "wiring" && !(rule.calls ?? []).length) p(rule, "wiring 規則至少要有一個 calls");
      if (rule.check === "implementation") {
        if ((rule.calls ?? []).length) p(rule, "implementation 規則不呼叫函式（讀 EIP-1967 slot）");
        for (const c of rule.contracts ?? []) {
          if (c.as !== "proxy") p(rule, `${c.ref}：implementation 規則的合約必須是 as: "proxy"`);
          if (!active || !c.address) continue;
          const impl = ctx.deployed.implOf(c.address);
          if (ctx.deployed.data && !impl) p(rule, `${c.ref}（${c.address}）在 deployed.json 沒有 EIP-1967 實作：不是 proxy，或 fixture 過期`);
          c.impl = impl;
        }
      }
      if (rule.token) {
        try {
          rule.decimals = ctx.tokenDecimals(rule.token);
          if (active) checkTokenOnChain(rule, rule.token, rule.decimals, ctx, p);
        } catch (e) {
          p(rule, e.message);
        }
      }
      if (rule.check === "balanceDrop") {
        if (!cfg.params?.[rule.dropBps]) p(rule, `dropBps 參照未定義的參數 ${rule.dropBps}`);
        for (const as of ["token", "holder"]) if (!(rule.contracts ?? []).some((c) => c.as === as)) p(rule, `balanceDrop 規則需要 contracts[].as = "${as}"`);
        // 持有者必須有回報這個代幣的 getter（快照比對代幣標籤；沒有就無從驗證讀的是不是對的代幣）。
        const holder = (rule.contracts ?? []).find((c) => c.as === "holder");
        const getter = tokenGetter(rule.token);
        if (holder && !ctx.abis[holder.abi]?.some((x) => x.type === "function" && abiSig(x) === getter)) {
          p(rule, `holder ${holder.ref} 沒有 ${getter}：無法以鏈上快照確認它持有的是 ${rule.token}`);
        }
        const tok = (rule.contracts ?? []).find((c) => c.as === "token");
        if (tok?.address && rule.token && lc(tok.address) !== lc(ctx.tokenAddress(rule.token) ?? "")) p(rule, `token 合約 ${tok.ref} 不是 ${rule.token}`);
      }
      for (const s of [...(rule.assets ?? []), ...(rule.cryptoAssets ?? [])]) {
        if (!ctx.assetIds[s]) p(rule, `資產 ${s} 不在 addresses.ts 的 ASSET_IDS`);
      }
    }
    if (rule.kind === "http" && !engineInternal.httpChecks[rule.check]) p(rule, `未知的 http 檢查 ${rule.check}`);

    // 處置段落
    if (!rule.runbook?.length) p(rule, `至少要對應一個 ${IR_DOC} 的處置段落`);
    const irHeads = ctx.headings(IR_DOC);
    for (const h of rule.runbook ?? []) {
      if (!irHeads?.has(h)) p(rule, `runbook「${h}」不是 ${IR_DOC} 的標題`);
    }
    if (rule.runbook?.[0]) rule.runbookUrl = `${cfg.repoBlobBase}/${IR_DOC}#${slug(rule.runbook[0])}`;
    for (const r of rule.related ?? []) {
      const [doc, head] = r.split("#");
      const hs = ctx.headings(doc);
      if (!hs) p(rule, `related 文件 ${doc} 不存在`);
      else if (!hs.has(head)) p(rule, `related「${head}」不是 ${doc} 的標題`);
    }
  }

  // 全域產生欄位
  cfg.assets = {};
  cfg.assetLabels = {};
  for (const [sym, id] of Object.entries(ctx.assetIds)) {
    if (keccak256(sym) !== lc(id)) problems.push(`(全域)：addresses.ts ASSET_IDS.${sym} 不等於 keccak256("${sym}")`);
    cfg.assets[sym] = lc(id);
    cfg.assetLabels[lc(id)] = sym;
  }
  cfg.roleNames = ctx.roleNames;

  // 參數
  const used = new Set();
  for (const src of [engineSource(ctx.root), read(ctx.root, "ops/monitoring/tick.mjs")]) {
    for (const m of src.matchAll(/(?:numParam|param)\(config, env, "([A-Z0-9_]+)"\)/g)) used.add(m[1]);
  }
  for (const name of used) if (!cfg.params?.[name]) problems.push(`(全域)：engine.mjs／tick.mjs 用到參數 ${name}，但 monitors.json 沒有定義`);
  problems.push(...checkParams(cfg));
  problems.push(...checkGlobalConfig(cfg));
  problems.push(...checkRequired(cfg));
  problems.push(...eventCoverage(cfg, ctx));
  problems.push(...adminFunctionCoverage(cfg, ctx));
  problems.push(...proxyCoverage(cfg, ctx));
  if (!PUBLIC_RPC_ALLOW.includes(cfg.network?.publicRpc)) {
    problems.push(`(全域)：network.publicRpc 必須是不需要金鑰的公開端點（${PUBLIC_RPC_ALLOW.join("、")}）；含金鑰的 RPC 請用 Worker secret RPC_URL`);
  }
  if (cfg.params?.SIGNAL_API_URL?.default !== ctx.sdkUrl) {
    problems.push(`(全域)：SIGNAL_API_URL 預設值必須等於 agent/sdk/src/signalApi.ts 的 SIGNAL_API_TESTNET_URL（${ctx.sdkUrl}）`);
  }
  return { config: cfg, problems };
}
const engineSource = (root) => read(root, "ops/monitoring/engine.mjs");

/** 一個參數值是否合法；回傳錯誤文字或 null。範圍來自 params.mjs；keys 型別另外對照白名單（cfg）。 */
export function checkParamValue(name, value, cfg = null) {
  const err = checkParamSpec(name, value);
  if (err) return err;
  if (PARAM_SPECS[name].type === "keys") {
    const bad = checkMuteKeys(String(value ?? "").trim(), cfg ?? { mutableKeys: MUTABLE_KEYS.map((key) => ({ key })) });
    if (bad.length) return bad.join("；");
  }
  return null;
}

/** 參數：每個都有型別、預設值合法、成對的門檻順序正確、沒有多餘或缺少的型別定義。 */
function checkParams(cfg) {
  const out = [];
  const params = cfg.params ?? {};
  for (const [name, def] of Object.entries(params)) {
    if (typeof def?.default !== "string") out.push(`(全域)：params.${name}.default 必須是字串`);
    for (const f of ["unit", "doc"]) if (!def?.[f]) out.push(`(全域)：params.${name} 缺少 ${f}`);
    const err = checkParamValue(name, def?.default, cfg);
    if (err) out.push(`(全域)：params.${name}.default ${err}`);
  }
  for (const name of Object.keys(PARAM_SPECS)) if (!params[name]) out.push(`(全域)：PARAM_SPECS 有 ${name}，但 monitors.json 沒有這個參數`);
  for (const m of paramComboProblems(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v?.default])))) out.push(`(全域)：params 預設值 ${m}`);
  out.push(...checkMutableKeys(cfg));
  return out;
}

/** monitors.json 的 mutableKeys：與 MUTABLE_KEYS 相同、每項有理由、指向存在的規則的子 key。 */
function checkMutableKeys(cfg) {
  const out = [];
  const list = cfg.mutableKeys ?? [];
  const keys = list.map((m) => m.key);
  if (JSON.stringify([...keys].sort()) !== JSON.stringify([...MUTABLE_KEYS].sort())) {
    out.push(`(全域)：mutableKeys（${keys.join(", ") || "空"}）與 scripts/check-monitoring.mjs 的 MUTABLE_KEYS（${MUTABLE_KEYS.join(", ")}）不同 —— 可靜音的 key 要人工審過後兩邊一起改`);
  }
  for (const m of list) {
    if (!String(m.reason ?? "").trim()) out.push(`(全域)：mutableKeys 的 ${m.key} 沒有寫 reason`);
    const [id, sub] = String(m.key ?? "").split(/:(.*)/s);
    const rule = (cfg.rules ?? []).find((r) => r.id === id);
    if (String(m.key).startsWith("monitor-self")) out.push(`(全域)：mutableKeys 不可以有 monitor-self（${m.key}）`);
    else if (!rule) out.push(`(全域)：mutableKeys 的 ${m.key} 不是任何規則的 key`);
    else if (!sub) out.push(`(全域)：mutableKeys 的 ${m.key} 是整條規則；只能列出單一子 key`);
  }
  return out;
}

/** 必要規則：存在、狀態、嚴重度下限；每條規則都要在表裡（新增規則時一併登記）。 */
function checkRequired(cfg) {
  const out = [];
  const rank = (s) => SEVERITIES.indexOf(s);
  const byId = new Map((cfg.rules ?? []).map((r) => [r.id, r]));
  for (const [id, [minSev, status, pinned]] of Object.entries(REQUIRED_RULES)) {
    const r = byId.get(id);
    if (!r) {
      out.push(`${id}：必要規則不存在（被刪除？）—— 要移除必須同時改 scripts/check-monitoring.mjs 的 REQUIRED_RULES`);
      continue;
    }
    if (status === "active" && r.status !== "active") out.push(`${id}：必要規則必須是 active，現在是 ${r.status} —— 要停用必須同時改 REQUIRED_RULES`);
    if (rank(r.severity) < 0 || rank(r.severity) > rank(minSev)) out.push(`${id}：嚴重度 ${r.severity} 低於下限 ${minSev} —— 要降級必須同時改 REQUIRED_RULES`);
    const h = ruleHash(r);
    if (h !== pinned) {
      out.push(
        `${id}：規則定義與 scripts/check-monitoring.mjs 的 REQUIRED_RULES 釘住的 sha256 不同（現在 ${h}，釘的是 ${pinned}）—— ` +
          "任何改動（合約、讀取、預期值來源、門檻參數、事件、嚴重度、文字）都要人工審過，確認沒有削弱監控後，再把新雜湊更新到 REQUIRED_RULES",
      );
    }
  }
  for (const id of byId.keys()) if (!REQUIRED_RULES[id]) out.push(`${id}：新規則還沒登記到 scripts/check-monitoring.mjs 的 REQUIRED_RULES（嚴重度下限與狀態）`);
  return out;
}

/**
 * 事件涵蓋（審查 M4）：受監控合約（出現在 active 規則裡的合約）的每個事件——前端 ABI 裡的，
 * 加上「原始碼有宣告、部署版 bytecode 裡也有、但前端 ABI 沒有」的——都必須屬於下列之一：
 *   • 某條 active 規則監控它（或在該規則裡標 notDeployed）
 *   • 某條 pending-deploy 規則等它部署
 *   • ignoredEvents 明列並寫理由（notDeployed: true 的項目另外要求「部署版真的沒有」，
 *     合約換版後事件出現就會被擋下來重新分類）
 * 這樣 ABI 新增一個 admin 事件卻沒有人決定要不要監控，CI 會紅。
 */
export function eventCoverage(cfg, ctx) {
  const out = [];
  const monitored = new Map(); // ref → { abi, address }
  for (const r of cfg.rules ?? []) {
    if (r.status !== "active") continue;
    for (const c of r.contracts ?? []) if (c.abi && ctx.abis[c.abi] && !monitored.has(c.ref)) monitored.set(c.ref, { abi: c.abi, address: c.address });
  }
  const inRule = new Set(); // `${ref}|${sig}`
  for (const r of cfg.rules ?? []) for (const c of r.contracts ?? []) for (const e of r.events ?? []) inRule.add(`${c.ref}|${e.sig}`);

  const ignored = new Map(); // `${abi}|${sig}` → entry
  const abisInUse = new Set([...monitored.values()].map((m) => m.abi));
  (cfg.ignoredEvents ?? []).forEach((g, i) => {
    const where = `ignoredEvents[${i}]（${g.abi}）`;
    if (!String(g.reason ?? "").trim()) out.push(`(全域)：${where} 沒有寫 reason`);
    if (!ctx.abis[g.abi]) return void out.push(`(全域)：${where} 的 ABI 不存在`);
    if (!abisInUse.has(g.abi)) out.push(`(全域)：${where} 沒有任何 active 規則在監控這個合約，忽略清單過期`);
    const sigs = new Set(ctx.abis[g.abi].filter((x) => x.type === "event").map(abiSig));
    for (const sig of g.events ?? []) {
      const k = `${g.abi}|${sig}`;
      if (ignored.has(k)) out.push(`(全域)：${where} 的 ${sig} 重複`);
      ignored.set(k, g);
      if (!sigs.has(sig) && !ctx.solSigs.has(sig)) out.push(`(全域)：${where} 的 ${sig} 不在 ${g.abi}.json 的 ABI 也不在原始碼裡，忽略清單過期`);
    }
  });

  const seenIgnored = new Set(); // 沒標 notDeployed 的忽略項目
  const liveIgnored = new Set(); // …其中至少有一顆合約的部署版真的會發
  for (const [ref, { abi, address }] of monitored) {
    const abiSigs = new Set(ctx.abis[abi].filter((x) => x.type === "event").map(abiSig));
    // 原始碼有宣告、部署版也有、但前端 ABI 沒有的事件（部署版比 ABI 舊或新時會出現）。
    const extra = address ? [...ctx.solSigs].filter((sig) => !abiSigs.has(sig) && ctx.deployed.hasTopic(address, sig) === true) : [];
    for (const sig of [...abiSigs, ...extra]) {
      const g = ignored.get(`${abi}|${sig}`);
      const ruled = inRule.has(`${ref}|${sig}`);
      if (g && ruled) out.push(`(全域)：${sig}（${ref}）同時在規則與 ignoredEvents 裡`);
      else if (g) {
        const k = `${abi}|${sig}`;
        if (!g.notDeployed && address && ctx.deployed.hasTopic(address, sig) !== false) liveIgnored.add(k);
        if (!g.notDeployed) seenIgnored.add(k);
        if (g.notDeployed && address && ctx.deployed.hasTopic(address, sig) === true) {
          out.push(`(全域)：ignoredEvents 說 ${sig} 不在 ${ref} 的部署版，但已部署的 bytecode 裡有 —— 合約換版了：加規則，或改寫忽略理由`);
        }
      } else if (!ruled) {
        const src = abiSigs.has(sig) ? `${abi}.json` : "部署版 bytecode（前端 ABI 沒有）";
        out.push(`(全域)：${ref} 的事件 ${sig}（${src}）沒有任何規則、也不在 ignoredEvents —— 加一條規則，或在 monitors.json 的 ignoredEvents 寫明為什麼不監控`);
      }
    }
  }
  // 忽略理由寫的是「例行事件」，但沒有任何一顆合約的部署版會發 → 理由不對，要標 notDeployed（rules.md 才不會寫錯）。
  for (const k of seenIgnored) {
    if (!liveIgnored.has(k)) out.push(`(全域)：ignoredEvents 的 ${k.split("|")[1]}（${k.split("|")[0]}）不在任何部署版 bytecode 裡 —— 那一組要標 notDeployed: true`);
  }
  return out;
}

/**
 * 部署版 bytecode 裡的管理函式（複審 L-d）。事件涵蓋從「ABI 裡的事件」出發，看不到**不發事件的 setter**
 * （PepeIncentives.withdraw／setEsgRegistry…）。這裡反過來從函式出發：受監控合約的 ABI 裡、名稱像管理
 * 操作（ADMIN_FN）、且 selector 真的在部署版 bytecode 裡的函式，都必須在 monitors.json 的 adminFunctions
 * 裡分類——
 *   { "rule": "<id>" | ["<id>", …] }  由這（幾）條 active 規則涵蓋。事件規則必須有至少一個事件真的在該合約的部署版裡
 *                         （部署版不發事件的 setter 只能由狀態規則涵蓋）；規則必須包含這個合約。
 *   { "reason": "…" }     明列不監控的理由（使用者自己的操作、一次性設定…）。
 * 多出來的分類（ABI 沒有或部署版沒有的函式）也算錯——合約換版後要重新分類。
 */
export const ADMIN_FN = /^(set|update|register|unregister|add|remove|grant|revoke|transferOwnership|renounce|pause|unpause|upgrade|withdraw|configure|enable|disable|freeze|takeOver)/i;
export function adminFunctionCoverage(cfg, ctx) {
  const out = [];
  if (!ctx.deployed.data) return out;
  const byAbi = new Map(); // abi → Set(address)
  for (const r of cfg.rules ?? []) {
    if (r.status !== "active") continue;
    for (const c of r.contracts ?? []) {
      if (!c.abi || !c.address || !ctx.abis[c.abi]) continue;
      if (!byAbi.has(c.abi)) byAbi.set(c.abi, new Set());
      byAbi.get(c.abi).add(c.address);
    }
  }
  const table = cfg.adminFunctions ?? {};
  const rules = new Map((cfg.rules ?? []).map((r) => [r.id, r]));
  for (const [abi, addrs] of [...byAbi].sort()) {
    const fns = ctx.abis[abi].filter((x) => x.type === "function" && x.stateMutability !== "view" && x.stateMutability !== "pure" && ADMIN_FN.test(x.name));
    const live = new Set(fns.map(abiSig).filter((sig) => [...addrs].some((a) => ctx.deployed.hasSelector(a, sig) === true)));
    const entries = table[abi] ?? {};
    for (const sig of [...live].sort()) {
      const e = entries[sig];
      if (!e) {
        out.push(`(全域)：${abi}.${sig} 在部署版 bytecode 裡，但 adminFunctions 沒有分類 —— 指定涵蓋它的規則（{ "rule": … }），或寫明不監控的理由（{ "reason": … }）`);
        continue;
      }
      if (!!e.rule === !!e.reason) {
        out.push(`(全域)：adminFunctions ${abi}.${sig} 必須恰好有 rule 或 reason 其中之一`);
        continue;
      }
      if (e.reason) {
        if (!String(e.reason).trim()) out.push(`(全域)：adminFunctions ${abi}.${sig} 的 reason 是空的`);
        continue;
      }
      for (const id of [e.rule].flat()) {
        const r = rules.get(id);
        if (!r || r.status !== "active") {
          out.push(`(全域)：adminFunctions ${abi}.${sig} 指向 ${id}，但它不是 active 規則`);
          continue;
        }
        const mine = (r.contracts ?? []).filter((c) => c.abi === abi && c.address);
        if (!mine.length) {
          out.push(`(全域)：adminFunctions ${abi}.${sig} 指向 ${id}，但那條規則沒有監控 ${abi}`);
          continue;
        }
        if (r.kind === "event" && !mine.some((c) => (r.events ?? []).some((ev) => ctx.deployed.hasTopic(c.address, ev.sig) === true))) {
          out.push(`(全域)：adminFunctions ${abi}.${sig} 指向事件規則 ${id}，但它的事件都不在 ${abi} 的部署版裡 —— 不發事件的 setter 要由狀態規則涵蓋`);
        }
      }
    }
    for (const sig of Object.keys(entries)) {
      if (!live.has(sig)) out.push(`(全域)：adminFunctions ${abi}.${sig} 不在 ABI 或不在部署版 bytecode 裡 —— 分類過期`);
    }
  }
  for (const abi of Object.keys(table)) if (!byAbi.has(abi)) out.push(`(全域)：adminFunctions 的 ${abi} 沒有任何 active 規則在監控，分類過期`);
  return out;
}

/** 每個受監控的 EIP-1967 proxy 都要在 implementation 規則裡（實作被換掉時 deployed.json 就過期了）。 */
export function proxyCoverage(cfg, ctx) {
  const out = [];
  if (!ctx.deployed.data) return out;
  const covered = new Set();
  for (const r of cfg.rules ?? []) {
    if (r.status === "active" && r.check === "implementation") for (const c of r.contracts ?? []) if (c.address) covered.add(lc(c.address));
  }
  const seen = new Set();
  for (const r of cfg.rules ?? []) {
    if (r.status !== "active") continue;
    for (const c of r.contracts ?? []) {
      if (!c.address || seen.has(lc(c.address))) continue;
      seen.add(lc(c.address));
      if (ctx.deployed.implOf(c.address) && !covered.has(lc(c.address))) {
        out.push(`(全域)：${c.ref}（${c.address}）是 EIP-1967 proxy，但沒有 implementation 規則在讀它的實作 slot —— 實作被換掉時 CI 依據的 bytecode 會過期而不自知`);
      }
    }
  }
  return out;
}

/**
 * MUTE_KEYS 的值（monitors.json 預設與 wrangler.toml 的覆寫）：每一項都必須在 mutableKeys 白名單裡
 * （複審 M-A：原本允許任何 SEV-1 規則的子 key，而 x402-payto:changed、insurance-wiring:… 這些子 key
 * 就是該規則全部的 SEV-1 輸出）。執行期也只認白名單，這裡讓錯誤在 PR 就被看到。回傳錯誤訊息陣列。
 */
export function checkMuteKeys(value, cfg) {
  const out = [];
  const allowed = (cfg?.mutableKeys ?? []).map((m) => m.key);
  const { rejected, ignored } = parseMuteKeys(value, allowed);
  for (const k of ignored) out.push(k.startsWith("monitor-self") ? `含 ${k}：監控自身的告警不可靜音` : `含格式不對的項目 ${JSON.stringify(k)}`);
  for (const k of rejected) out.push(`的 ${k} 不在 mutableKeys 白名單（${allowed.join(", ") || "空"}）：不可靜音`);
  return out;
}

/** 事件簽章的 notDeployed 宣告（true = 這條規則的所有合約；陣列 = 指定的 ref）。 */
const notDeployedRefs = (rule, ev) =>
  ev.notDeployed === true ? (rule.contracts ?? []).map((c) => c.ref) : Array.isArray(ev.notDeployed) ? ev.notDeployed : [];

/**
 * 事件 × 已部署 bytecode（審查 H2）。
 *   active：topic0 不在 bytecode ⇒ 這個事件永遠不會響。必須由人明確標 notDeployed（並寫 note 說明
 *           由什麼替代），rules.md 會標「部署版不發此事件」；標了卻其實會發也是錯（標記過期）。
 *   pending-deploy：合約若已有位址，topic0 出現在 bytecode ⇒ 已經部署了，規則該改 active。
 */
function checkEventDeployed(rule, ev, ctx, p) {
  if (ev.notDeployed !== undefined && ev.notDeployed !== true && !Array.isArray(ev.notDeployed)) {
    p(rule, `${ev.sig} 的 notDeployed 必須是 true 或合約 ref 的陣列`);
  }
  const declared = notDeployedRefs(rule, ev);
  const refs = (rule.contracts ?? []).map((c) => c.ref);
  for (const r of declared) if (!refs.includes(r)) p(rule, `${ev.sig} 的 notDeployed 含不在這條規則裡的合約 ${r}`);
  if (rule.status !== "active") {
    if (ev.notDeployed !== undefined) p(rule, `${ev.sig}：pending-deploy 規則不需要 notDeployed`);
    for (const c of rule.contracts ?? []) {
      const a = ctx.resolveRef(c.ref).address;
      if (a && ADDR.test(a) && lc(a) !== ZERO && ctx.deployed.hasTopic(a, ev.sig) === true) {
        p(rule, `${ev.sig} 已出現在 ${c.ref} 已部署的 bytecode 裡 —— 合約已經會發這個事件，規則該改成 active`);
      }
    }
    return;
  }
  if (declared.length && !String(ev.note ?? "").trim()) p(rule, `${ev.sig} 標了 notDeployed，必須寫 note 說明（部署版為什麼不發、由什麼替代）`);
  for (const c of rule.contracts ?? []) {
    if (!c.address) continue;
    const has = ctx.deployed.hasTopic(c.address, ev.sig);
    if (has === null) continue; // deployed.json 沒有這個位址：checkDeployed 會報
    const marked = declared.includes(c.ref);
    if (!has && !marked) {
      p(rule, `${ev.sig} 的 topic0 不在 ${c.ref} 已部署的 bytecode 裡 —— 部署版不發此事件，這個告警永遠不會響。改用狀態規則，並把事件標 notDeployed 或移到 pending-deploy 規則`);
    } else if (has && marked) {
      p(rule, `${ev.sig} 標了 notDeployed（${c.ref}），但部署版其實會發 —— 移除標記`);
    }
  }
}

/** wiring 規則的每個讀取：零參數、回傳 address；預期值來自 addresses.ts、零位址或鏈上快照。 */
function checkWiringCall(rule, c, call, fnAbi, ctx, p) {
  if (fnAbi && (fnAbi.inputs.length !== 0 || fnAbi.outputs?.length !== 1 || fnAbi.outputs[0].type !== "address")) {
    p(rule, `wiring 的 ${call.fn} 必須是零參數、回傳單一 address 的函式`);
  }
  const e = call.expect ?? {};
  const kinds = ["ref", "zero", "snapshot"].filter((k) => e[k] !== undefined && e[k] !== false);
  if (kinds.length !== 1) {
    p(rule, `${call.on}.${call.fn} 的 expect 必須恰好指定 ref／zero／snapshot 其中之一`);
    return;
  }
  const snap = c.address ? ctx.deployed.read(c.address, call.fn) : null;
  const snapAddr = snap ? wordToAddr(snap) : null;
  let expected = null;
  if (e.ref !== undefined) {
    const a = ctx.resolveRef(e.ref).address;
    if (!a || !ADDR.test(a) || lc(a) === ZERO) p(rule, `${call.on}.${call.fn} 的 expect.ref ${e.ref} 在前端設定裡解析不到位址`);
    else expected = a;
  } else if (e.zero) expected = ZERO;
  else {
    if (!String(call.note ?? "").trim()) p(rule, `${call.on}.${call.fn} 用鏈上快照當預期值，必須寫 note 說明為什麼前端設定沒有這個位址`);
    expected = snapAddr;
  }
  if (snapAddr && expected && lc(snapAddr) !== lc(expected)) {
    p(rule, `${c.ref}.${call.fn} 的鏈上快照是 ${snapAddr}，但預期 ${expected}（${e.ref ?? "零位址"}）—— 鏈上接線與前端設定不一致`);
  }
  call.expected = expected;
}

/** 金額規則的代幣標籤必須等於合約 usdc() 的鏈上快照；小數位必須等於該代幣 decimals() 的快照。 */
function checkTokenOnChain(rule, token, decimals, ctx, p) {
  const want = ctx.tokenAddress(token);
  for (const c of rule.contracts ?? []) {
    if (!c.address) continue;
    const abi = ctx.abis[c.abi];
    const getter = tokenGetter(token);
    if (!abi?.some((x) => x.type === "function" && abiSig(x) === getter)) continue;
    const snap = ctx.deployed.read(c.address, getter);
    if (!snap) continue; // checkDeployed 會報
    const tok = wordToAddr(snap);
    if (!want || lc(tok) !== lc(want)) {
      p(rule, `token 標成 ${token}（${want}），但 ${c.ref}.${getter} 的鏈上快照是 ${tok} —— 標籤錯了（小數位或代幣都可能不同）`);
      continue;
    }
    const d = ctx.deployed.read(tok, "decimals()");
    if (d && Number(BigInt(d)) !== decimals) p(rule, `${token} 的 decimals() 鏈上快照是 ${Number(BigInt(d))}，設定推得 ${decimals}`);
  }
}

// ── rules.md ─────────────────────────────────────────────────────────────────

const KIND_TEXT = { event: "事件", state: "狀態", http: "HTTP" };
/**
 * 規則狀態的人讀文字。pending-deploy 有兩種：合約還沒部署（待部署），或合約已部署、
 * 但鏈上的版本不發這個事件（部署版不發此事件）——後者不可以被讀成「運作中」。
 */
const isLiveContract = (ctx, ref) => {
  const a = ctx.resolveRef(ref).address;
  return !!a && ADDR.test(a) && lc(a) !== ZERO;
};
const dormant = (rule, ctx) => rule.status !== "active" && (rule.contracts ?? []).length > 0 && rule.contracts.every((c) => isLiveContract(ctx, c.ref));
const statusText = (rule, ctx) => (rule.status === "active" ? "運作中" : dormant(rule, ctx) ? "部署版不發此事件" : "待部署");
const eventText = (rule, e) => {
  const nd = notDeployedRefs(rule, e);
  if (!nd.length) return `\`${e.sig}\``;
  const who = nd.length === (rule.contracts ?? []).length ? "" : `：${nd.join("、")}`;
  return `\`${e.sig}\`（**部署版不發此事件**${who}；${e.note}）`;
};
const expectText = (call) => {
  const e = call.expect ?? {};
  if (e.ref !== undefined) return `\`${e.ref}\`（\`${call.expected}\`）`;
  if (e.zero) return "零位址";
  return `鏈上快照 \`${call.expected}\`（${call.note}）`;
};
const pv = (cfg, name) => `\`${name}\`（預設 ${cfg.params[name]?.default} ${cfg.params[name]?.unit ?? ""}）`.replace(/ ）/, "）");
const THRESHOLD = {
  oracleStaleness: (c) => `加密資產：≥ ${pv(c, "ORACLE_STALE_WARN_SEC")} → SEV-3；≥ 鏈上 \`maxPriceAge()\` → SEV-2。其他資產：≥ ${pv(c, "NONCRYPTO_STALE_SEC")} → SEV-3`,
  oracleDeviation: (c) => `偏離 ≥ ${pv(c, "ORACLE_DEVIATION_BPS")} → SEV-2；≥ ${pv(c, "ORACLE_DEVIATION_CRIT_BPS")} → SEV-1；參考價超過 ${pv(c, "REFERENCE_MAX_AGE_SEC")} 不比對；**一檔都比不到 → SEV-3「沒有可用的參考價」**`,
  guardedOraclePaused: () => "`paused() == true`",
  insuranceFund: (c) => `\`totalAssets()\` < ${pv(c, "INSURANCE_MIN_USDC")}，或較 24 小時高點下降 ≥ ${pv(c, "INSURANCE_DROP_BPS")} → SEV-2`,
  vaultReserve: (c) => `儲備率 < \`minReserveRatioBps()\` → SEV-2；< 下限 + ${pv(c, "RESERVE_WARN_MARGIN_BPS")} → SEV-3；mint 自動停止 → SEV-2；無法定價或暫停 → SEV-3`,
  gasBalance: (c) => `< ${pv(c, "GAS_MIN_ETH")} → SEV-3；< ${pv(c, "GAS_CRIT_ETH")} → SEV-2`,
  httpHealth: (c) => `非 200 或內容不是 \`ok\`，連續 ${pv(c, "HTTP_FAILS_BEFORE_ALERT")}`,
  x402PayTo: () => "`payTo` ≠ `EXPECTED_PAY_TO`（未設時為首次觀察值）→ SEV-1；`payToSafety.safe == false` → SEV-3",
  wiring: () => "任一 getter 的讀值 ≠ 預期位址",
  balanceDrop: (c, r) => `餘額較 24 小時高點下降 ≥ ${pv(c, r.dropBps)} → ${r.severity}`,
  implementation: () => "EIP-1967 實作 slot ≠ deployed.json 的實作 → SEV-1（同一個新實作已由 Upgraded 事件通報時 SEV-3「deployed.json 過期」）",
};
function thresholdText(cfg, rule) {
  if (rule.kind === "event") {
    if (!rule.amount) return "每一筆";
    const a = rule.amount;
    let t = Number(cfg.params[a.threshold]?.default) === 0 ? `每一筆（${pv(cfg, a.threshold)}）` : `單筆 ≥ ${pv(cfg, a.threshold)}`;
    if (a.relativeBps) t += `，或 ≥ 合約提領前餘額的 ${pv(cfg, a.relativeBps)}`;
    if (a.windowThreshold) t += `；${pv(cfg, a.windowSec)} 內累計 ≥ ${pv(cfg, a.windowThreshold)}`;
    return `${t}；金額 ${a.decimals} 位小數（${a.token}）`;
  }
  return THRESHOLD[rule.check]?.(cfg, rule) ?? "—";
}
const anchor = (h) => `../../${IR_DOC}#${slug(h)}`;
const rangeText = (spec) => {
  if (!spec) return "—";
  if (spec.type === "int" || spec.type === "decimal") return `${spec.min.toLocaleString("en-US")}–${spec.max.toLocaleString("en-US")}`;
  if (spec.type === "severity") return spec.allowed.join("／");
  if (spec.type === "url") return "https URL";
  return "白名單（mutableKeys）";
};
const relLink = (r) => {
  const [doc, head] = r.split("#");
  return `[${doc.replace(/^docs\//, "")}「${head}」](../../${doc}#${slug(head)})`;
};

export function renderRulesMd(cfg, ctx) {
  const L = [];
  const rules = cfg.rules;
  const active = rules.filter((r) => r.status === "active");
  L.push("# 監控規則清單");
  L.push("");
  L.push("> **由 `node scripts/check-monitoring.mjs --write` 從 [`monitors.json`](monitors.json) 產生，不要手改。**");
  L.push("> CI（`consistency.yml` 的 `monitoring` job）會檢查本檔、`monitors.json` 與前端設定／ABI 三者一致。");
  L.push(">");
  L.push("> - 位址一律由 `frontend/src/contracts/**` 解析（下表「位址來源」），不手抄。");
  L.push("> - 嚴重度定義與處置見 [`docs/INCIDENT_RESPONSE.md`](../../docs/INCIDENT_RESPONSE.md)。");
  L.push("> - 決策與方案比較見 [`docs/ADR-009-monitoring.md`](../../docs/ADR-009-monitoring.md)；部署步驟見 [`README.md`](README.md)。");
  L.push("> - 「待部署」規則的事件只存在於 master 原始碼，對應合約尚未部署；Worker 不載入，部署後改為 `active`。");
  L.push("> - 「**部署版不發此事件**」：合約已部署，但鏈上那一版不發這個事件（前端 ABI 來自 master 原始碼，比部署版新）。");
  L.push(">   這些事件**現在不會響**；有對應 setter 的由「狀態」規則每輪讀 getter 比對。依據是 [`deployed.json`](deployed.json)（唯讀 RPC 抓的 runtime bytecode，CI 離線比對 topic0）。");
  L.push("");
  const dormantCount = rules.filter((r) => dormant(r, ctx)).length;
  L.push(`共 **${rules.length}** 條規則：運作中 ${active.length} 條（事件 ${active.filter((r) => r.kind === "event").length}、狀態 ${active.filter((r) => r.kind === "state").length}、HTTP ${active.filter((r) => r.kind === "http").length}），部署版不發此事件 ${dormantCount} 條，待部署 ${rules.length - active.length - dormantCount} 條。鏈：${cfg.network.name}（${cfg.network.chainId}）。`);
  if (ctx.deployed.data) L.push(`已部署 bytecode 快照：區塊 ${ctx.deployed.data.block}（${ctx.deployed.data.fetchedAt}）。`);
  L.push("");
  L.push("## 總表");
  L.push("");
  L.push("| 規則 | 分類 | 類型 | 嚴重度 | 狀態 | 門檻 | 處置 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const r of rules) {
    L.push(`| [\`${r.id}\`](#${slug(r.id)}) ${r.title} | ${r.category} | ${KIND_TEXT[r.kind]} | ${r.severity} | ${statusText(r, ctx)} | ${thresholdText(cfg, r).replace(/\|/g, "\\|")} | ${r.runbook.map((h) => `[§${h.split(".")[0]}](${anchor(h)})`).join(" ")} |`);
  }
  L.push("");
  L.push("「嚴重度」是規則的預設等級；狀態規則依門檻在 SEV-1～SEV-3 之間升降（見各規則）。恢復通知固定標為 SEV-4，但依原嚴重度決定是否送出。");
  L.push("");
  L.push("## 參數（門檻）");
  L.push("");
  L.push("預設值在 `monitors.json`；可用 Worker 的 `[vars]` 覆寫（見 README）。標「待使用者決定」的是佔位值。");
  L.push("「範圍」來自 `ops/monitoring/params.mjs`：CI 擋範圍外的預設值與 `[vars]`；Cloudflare dashboard／`--var` 設的值不經 CI，Worker 執行期照同一張表夾值並發 `monitor-self:config`。");
  L.push("");
  L.push("| 參數 | 預設 | 範圍 | 單位 | 說明 |");
  L.push("|---|---|---|---|---|");
  for (const [k, v] of Object.entries(cfg.params)) L.push(`| \`${k}\` | ${v.default === "" ? "（空）" : `\`${v.default}\``} | ${rangeText(PARAM_SPECS[k])} | ${v.unit} | ${v.doc} |`);
  L.push("");
  L.push("## 規則明細");
  for (const r of rules) {
    L.push("");
    L.push(`### ${r.id}`);
    L.push("");
    L.push(`**${r.title}**｜${r.category}｜${KIND_TEXT[r.kind]}｜${r.severity}｜${statusText(r, ctx)}`);
    L.push("");
    L.push(r.description);
    L.push("");
    if (r.contracts?.length) {
      L.push("| 合約 | 位址來源 | 位址 |");
      L.push("|---|---|---|");
      for (const c of r.contracts) {
        const src = r.status === "active" ? ctx.resolveRef(c.ref).source : isLiveContract(ctx, c.ref) ? `${ctx.resolveRef(c.ref).source}（\`${ctx.resolveRef(c.ref).address}\`）；部署版不發此事件，事件宣告於 \`${c.source}\`` : `尚未部署；事件宣告於 \`${c.source}\``;
        L.push(`| ${c.ref}${c.abi ? `（ABI \`${c.abi}\`）` : ""} | ${src} | ${c.address ? `\`${c.address}\`` : "—"} |`);
      }
      L.push("");
    }
    if (r.events?.length) L.push(`- 事件：${r.events.map((e) => eventText(r, e)).join("、")}`);
    if (r.check === "implementation") {
      for (const c of r.contracts ?? []) L.push(`- 預期實作：\`${c.ref}\` = \`${c.impl}\`（deployed.json）`);
    }
    if (r.check === "wiring") {
      for (const c of r.calls ?? []) L.push(`- 預期：\`${r.contracts.find((x) => x.as === c.on)?.ref}.${c.fn}\` = ${expectText(c)}`);
    } else if (r.calls?.length) L.push(`- 讀取：${r.calls.map((c) => `\`${c.on}.${c.fn}\``).join("、")}`);
    if (r.assets?.length) L.push(`- 資產：${r.assets.join("、")}${r.cryptoAssets ? `（加密：${r.cryptoAssets.join("、")}）` : ""}`);
    if (r.kind === "http") L.push(`- 端點：\`{SIGNAL_API_URL}${r.path ?? "/"}\``);
    L.push(`- 門檻：${thresholdText(cfg, r)}`);
    L.push(`- 處置：${r.runbook.map((h) => `[INCIDENT_RESPONSE「${h}」](${anchor(h)})`).join("、")}`);
    if (r.related?.length) L.push(`- 相關：${r.related.map(relLink).join("、")}`);
  }
  L.push("");
  L.push("## 可靜音的告警");
  L.push("");
  L.push("`MUTE_KEYS` 只接受這張表裡的 key（完全相同，沒有前綴比對）。表以外的值在執行期被忽略，並發一則不可靜音的 `monitor-self:config`；SEV-1、`monitor-self` 與「基準已設定」在任何設定下都會送出。");
  L.push("");
  L.push("| key | 理由 |");
  L.push("|---|---|");
  for (const m of cfg.mutableKeys ?? []) L.push(`| \`${m.key}\` | ${m.reason} |`);
  if (Object.keys(cfg.adminFunctions ?? {}).length) {
    L.push("");
    L.push("## 管理函式的涵蓋");
    L.push("");
    L.push("受監控合約的部署版 bytecode 裡、名稱像管理操作的函式（set／update／withdraw／grant…），每一個都要由某條規則涵蓋或寫明理由；CI 從部署版的 selector 出發檢查，不發事件的 setter 也看得到。由事件規則涵蓋的，該事件必須真的在部署版裡。");
    L.push("");
    L.push("| 合約（ABI） | 函式 | 涵蓋 |");
    L.push("|---|---|---|");
    for (const [abi, fns] of Object.entries(cfg.adminFunctions)) {
      for (const [sig, e] of Object.entries(fns)) L.push(`| ${abi} | \`${sig}\` | ${e.rule ? [e.rule].flat().map((id) => `[\`${id}\`](#${slug(id)})`).join("、") : `不監控：${e.reason}`} |`);
    }
  }
  if (cfg.ignoredEvents?.length) {
    L.push("");
    L.push("## 刻意不監控的事件");
    L.push("");
    L.push("受監控合約會發、但沒有規則的事件。每一組都要寫理由；CI 會擋下「ABI 有、卻既沒有規則也不在這張表」的事件。");
    L.push("");
    L.push("| 合約（ABI） | 事件 | 理由 |");
    L.push("|---|---|---|");
    for (const g of cfg.ignoredEvents) {
      L.push(`| ${g.abi} | ${g.events.map((e) => `\`${e.split("(")[0]}\``).join("、")} | ${g.notDeployed ? "**部署版不發此事件**：" : ""}${g.reason} |`);
    }
  }
  L.push("");
  return L.join("\n");
}

// ── 秘密掃描 ─────────────────────────────────────────────────────────────────

/**
 * 這一行有沒有「路徑或查詢字串裡夾著長 token」的 URL。不認廠商樣式（QuickNode、Ankr、自架 proxy…
 * 各有各的），只看形狀：24 個字元以上、同時含字母與數字的一段。區塊瀏覽器的 tx／address
 * （0x 開頭的 40／64 hex）與 Markdown 錨點不算。
 */
export function keyedUrl(line) {
  for (const m of line.matchAll(/https?:\/\/[^\s"'`<>)\]]+/g)) {
    const [base, query = ""] = m[0].split("#")[0].split("?");
    const segs = base.split("/").slice(3);
    for (const kv of query.split("&")) {
      const [k, v = ""] = kv.split("=");
      if (/key|token|secret|auth/i.test(k) && v.length >= 8) return true;
      segs.push(v);
    }
    for (const seg of segs) {
      if (/^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/.test(seg)) continue;
      if (/^[A-Za-z0-9_-]{24,}$/.test(seg) && /[A-Za-z]/.test(seg) && /\d/.test(seg)) return true;
    }
  }
  return false;
}

export function scanSecrets(files) {
  const problems = [];
  const pats = [
    [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/, "疑似 Telegram bot token"],
    [/https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/, "疑似 Discord webhook URL（含 token）"],
    [/https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/, "疑似 Slack webhook URL"],
    [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, "疑似 GitHub token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "私鑰"],
    [/(?:alchemy\.com\/v2|infura\.io\/v3)\/[A-Za-z0-9]{16,}/, "含 API key 的 RPC URL"],
  ];
  for (const { name, text } of files) {
    text.split("\n").forEach((line, i) => {
      for (const [re, what] of pats) if (re.test(line)) problems.push(`${name}:${i + 1} ${what}`);
      if (line.includes("://") && keyedUrl(line)) problems.push(`${name}:${i + 1} URL 含疑似 API key／token 的長字串（含金鑰的 RPC 與 webhook 一律用 wrangler secret）`);
      if (/wrangler\.toml$/.test(name) && /\b0x[0-9a-fA-F]{64}\b/.test(line)) problems.push(`${name}:${i + 1} 疑似私鑰（32 bytes hex）`);
    });
  }
  return problems;
}

// 夠用的 TOML 走訪：只為了找出每個「鍵 = 值」葉節點與它的完整路徑（section + dotted key + inline table）。
const stripTomlComment = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === "\\" && q === '"') i++;
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
};
const splitTop = (text) => {
  const out = [];
  let depth = 0;
  let q = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === "\\" && q === '"') cur += text[i++];
      else if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += text[i] ?? "";
  }
  if (cur.trim()) out.push(cur);
  return out;
};
const tomlKeyPath = (k) => k.split(".").map((x) => x.trim().replace(/^["']|["']$/g, ""));
const tomlScalar = (v) => {
  const t = v.trim();
  return /^".*"$|^'.*'$/s.test(t) ? t.slice(1, -1) : t;
};
/** 回傳 [{ path: [..], value, line }]：所有葉節點（值是 inline table 時往裡走）。 */
export function tomlLeaves(text) {
  const leaves = [];
  let section = [];
  const walk = (path, raw, line) => {
    const t = raw.trim();
    if (t.startsWith("{")) {
      for (const part of splitTop(t.slice(1, t.lastIndexOf("}")))) {
        const m = part.match(/^\s*([A-Za-z0-9_."'-]+)\s*=\s*([\s\S]*)$/);
        if (m) walk(path.concat(tomlKeyPath(m[1])), m[2], line);
      }
    } else leaves.push({ path, value: tomlScalar(t), line });
  };
  text.split("\n").forEach((rawLine, i) => {
    const line = stripTomlComment(rawLine).trim();
    if (!line) return;
    const h = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (h) {
      section = tomlKeyPath(h[1]);
      return;
    }
    const m = line.match(/^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/);
    if (m) walk(section.concat(tomlKeyPath(m[1])), m[2], i + 1);
  });
  return leaves;
}

/**
 * wrangler.toml：
 *   • 秘密鍵名不得出現在**任何位置**——[vars]、[env.<name>.vars]、inline table、dotted key 都算
 *     （審查 M4：只看 [vars] 時，[env.production.vars] 與 `x = { ALERT_WEBHOOK_URL = … }` 都漏掉）。
 *   • 任何 vars 表（路徑倒數第二段是 vars）的鍵必須是已知參數或允許的公開設定，值必須通過型別與範圍。
 */
export function checkWranglerVars(toml, params, cfg = null) {
  const problems = [];
  const sections = new Map(); // vars 表 → { 參數名: 值 }（組合限制用）
  for (const { path, value, line } of tomlLeaves(toml)) {
    const name = path[path.length - 1];
    const where = path.slice(0, -1).join(".") || "頂層";
    const inVars = path.length >= 2 && path[path.length - 2] === "vars";
    if (SECRET_NAMES.includes(name)) {
      problems.push(`wrangler.toml:${line} ${name} 是秘密，必須用 \`wrangler secret put\`，不能寫在 ${inVars ? `[${where}]` : `設定檔（${where}）`}`);
      continue;
    }
    if (!inVars) continue;
    if (EXTRA_VARS[name]) {
      const err = EXTRA_VARS[name](value);
      if (err) problems.push(`wrangler.toml:${line} [${where}] 的 ${name} ${err}`);
    } else if (!params[name]) problems.push(`wrangler.toml:${line} [${where}] 的 ${name} 不是已知參數`);
    else if (PARAM_SPECS[name]) {
      const err = checkParamValue(name, value, cfg);
      if (err) problems.push(`wrangler.toml:${line} [${where}] 的 ${name} ${err}`);
      if (!sections.has(where)) sections.set(where, {});
      sections.get(where)[name] = value;
    }
  }
  const defaults = Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, v?.default]));
  for (const [where, vals] of sections) for (const m of paramComboProblems({ ...defaults, ...vals })) problems.push(`wrangler.toml [${where}]：${m}`);
  return problems;
}

/** 設定目錄底下的所有檔案（遞迴；略過只存在本機、已列入 .gitignore 的項目）。 */
export function listFiles(dir, rel = "") {
  const out = [];
  for (const f of readdirSync(join(dir, rel)).sort()) {
    if (LOCAL_ONLY.includes(f) || f === "node_modules") continue;
    const r = rel ? `${rel}/${f}` : f;
    if (statSync(join(dir, r)).isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/** .gitignore 必須擋住 wrangler 的本機秘密檔與狀態目錄（秘密掃描略過它們的前提）。 */
export function checkGitignore(text) {
  const lines = new Set(text.split("\n").map((l) => l.trim()));
  return GITIGNORE_REQUIRED.filter((g) => !lines.has(g) && !lines.has(`**/${g}`)).map(
    (g) => `.gitignore 沒有 ${g} —— wrangler 的本機秘密／狀態可能被 commit（秘密掃描也略過它們）`,
  );
}

// ── 主程式 ───────────────────────────────────────────────────────────────────

function diffPaths(a, b, path = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}${Array.isArray(a) ? `[${k}]` : `.${k}`}`, out);
  } else out.push({ path, file: a, expected: b });
  return out;
}
const describe = (cfg, path) => {
  const m = path.match(/^\.rules\[(\d+)\]/);
  return m ? path.replace(/^\.rules\[\d+\]/, `rules[${cfg.rules[Number(m[1])]?.id}]`) : path;
};

/**
 * 比對檔案裡的設定與「從來源推得的設定」。回傳 { config, problems, rulesMd }。
 * rulesMd 傳 null 代表不比對 rules.md（--write 時）。
 */
export function checkConfig({ current, ctx, rulesMd }) {
  const { config, problems } = generate(current, ctx);
  const expectedMd = renderRulesMd(config, ctx);
  for (const d of diffPaths(current, config)) {
    const fmt = (v) => (v === undefined ? "（缺）" : JSON.stringify(v)?.slice(0, 90));
    problems.push(`monitors.json ${describe(config, d.path)} = ${fmt(d.file)}，來源推得 ${fmt(d.expected)} —— 執行 node scripts/check-monitoring.mjs --write`);
  }
  if (rulesMd !== null && rulesMd?.replace(/\r\n/g, "\n") !== expectedMd) {
    problems.push("ops/monitoring/rules.md 與 monitors.json 不一致 —— 執行 node scripts/check-monitoring.mjs --write");
  }
  return { config, problems, rulesMd: expectedMd };
}

export function run({ root, write = false, log = console.log }) {
  const dir = join(root, "ops/monitoring");
  const file = join(dir, "monitors.json");
  const current = JSON.parse(readFileSync(file, "utf8"));
  const ctx = loadContext(root);
  const mdPath = join(dir, "rules.md");
  let config;
  let problems;
  if (write) {
    const g = generate(current, ctx);
    ({ config, problems } = g);
    writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    writeFileSync(mdPath, renderRulesMd(config, ctx));
    log(`已寫入 ${relative(root, file)} 與 ops/monitoring/rules.md`);
  } else {
    const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : undefined;
    ({ config, problems } = checkConfig({ current, ctx, rulesMd: md }));
  }

  // 秘密（遞迴子目錄）、wrangler.toml、.gitignore
  const files = listFiles(dir).map((f) => ({ name: `ops/monitoring/${f}`, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n") }));
  problems.push(...scanSecrets(files));
  const toml = files.find((f) => f.name === "ops/monitoring/wrangler.toml");
  if (!toml) problems.push("ops/monitoring/wrangler.toml 不存在");
  else problems.push(...checkWranglerVars(toml.text, config.params, config));
  problems.push(...checkGitignore(existsSync(join(root, ".gitignore")) ? read(root, ".gitignore") : ""));

  // 已部署 bytecode 快照本身的完整性（雜湊、涵蓋範圍）。pending 規則「事件其實已部署」由 generate 報錯。
  problems.push(...checkDeployed(config, ctx));

  const active = config.rules.filter((r) => r.status === "active");
  log(`規則 ${config.rules.length} 條（運作中 ${active.length}、待部署 ${config.rules.length - active.length}），監控合約位址 ${new Set(active.flatMap((r) => r.contracts.map((c) => lc(c.address)))).size} 個`);
  if (problems.length) {
    for (const p of problems) log(`::error::${p}`);
    log(`\n${problems.length} 個問題`);
  } else {
    log("監控設定與前端設定、ABI、處置文件一致 ✓");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const root = i >= 0 ? resolve(args[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (args.includes("--verify-deployed")) {
      const k = args.indexOf("--rpc");
      const diffs = await verifyDeployed({ root, rpcUrl: k >= 0 ? args[k + 1] : undefined });
      if (diffs.length) {
        for (const d of diffs) console.log(`::error::deployed.json 與鏈上不一致：${d}`);
        console.log(`\n${diffs.length} 處不一致 —— 確認是預期的變更後執行 --refresh-deployed、--write，審過 diff 再走 PR`);
        process.exit(1);
      }
      console.log("deployed.json 與鏈上一致 ✓");
      process.exit(0);
    }
    if (args.includes("--refresh-deployed")) {
      const k = args.indexOf("--rpc");
      await refreshDeployed({ root, rpcUrl: k >= 0 ? args[k + 1] : undefined });
      console.log("接著執行：node scripts/check-monitoring.mjs --write && node scripts/check-monitoring.mjs");
      process.exit(0);
    }
    const problems = run({ root, write: args.includes("--write") });
    process.exit(problems.length ? 1 : 0);
  } catch (e) {
    console.error(`::error::check-monitoring 中止：${e.message}`);
    process.exit(2);
  }
}
