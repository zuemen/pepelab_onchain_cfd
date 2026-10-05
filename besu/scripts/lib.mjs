// besu/scripts/lib.mjs
// Besu 本地網路腳本共用的工具：路徑、帳戶與部署檔讀取、ABI 載入、viem client、
// 可重播的 GBM 價格產生器、清算候選判斷。
//
// 這裡只放「純函式＋讀本機檔案」；所有送交易的流程在各自的腳本裡。
// 安全界線：本檔只會連到 BESU_RPC_URL（預設 http://127.0.0.1:8545），
// 並在建立 client 時用白名單確認對方是本機產生的 Besu 網路（見 assertLocalBesu）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── 路徑 ──────────────────────────────────────────────────────────────────────
export const BESU_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(BESU_DIR, '..');
export const NETWORK_DIR = join(BESU_DIR, 'network');
export const DEPLOYMENTS_DIR = join(BESU_DIR, 'deployments');
export const CONTRACTS_OUT = join(REPO_ROOT, 'contracts', 'out');

export const DEFAULT_RPC_URL = process.env.BESU_RPC_URL || 'http://127.0.0.1:8545';

// ── 連線白名單 ────────────────────────────────────────────────────────────────
/**
 * 連線守門（白名單）：只有同時滿足下列兩點才放行，否則拒絕連線、不送任何交易。
 *   1. 節點回報的 chainId 等於本機 network/accounts.json 的 chainId（gen-network.mjs 產生時寫入）
 *   2. web3_clientVersion 以 `besu/` 開頭
 * 用白名單而不是「公開鏈黑名單」：keeper／推價允許用環境變數覆寫 RPC 與私鑰，
 * 黑名單擋不住沒列到的鏈（或 anvil 等其他節點），白名單只認這台機器自己產生的 Besu 網路。
 */
export function assertLocalBesu({ chainId, clientVersion, expectedChainId }) {
  if (expectedChainId === undefined || expectedChainId === null) {
    throw new Error('沒有預期的 chainId（network/accounts.json 缺少 chainId），拒絕連線。');
  }
  if (Number(chainId) !== Number(expectedChainId)) {
    throw new Error(`節點 chainId=${chainId}，但本機網路是 chainId=${expectedChainId}；只允許連本機產生的 Besu 網路。`);
  }
  if (typeof clientVersion !== 'string' || !clientVersion.toLowerCase().startsWith('besu/')) {
    throw new Error(`節點不是 Besu（web3_clientVersion=${clientVersion}）；只允許連本機產生的 Besu 網路。`);
  }
}

/**
 * gen-network.mjs 選 genesis chainId 時的防呆：不要選到常見公開鏈的 chainId（避免錢包／工具混淆）。
 * 這不是連線守門——連線一律走上面的白名單 assertLocalBesu。
 */
export const PUBLIC_CHAIN_IDS = new Set([1, 11155111, 17000, 560048, 8453, 84532, 10, 42161, 137, 80002]);
export function rejectPublicChainIdForGenesis(chainId) {
  if (PUBLIC_CHAIN_IDS.has(Number(chainId))) {
    throw new Error(`chainId ${chainId} 是公開鏈使用中的 ID，本地網路請改用別的值。`);
  }
}

// ── 檔案讀取 ──────────────────────────────────────────────────────────────────
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 讀 gen-network.mjs 產生的本機開發帳戶（含私鑰，只存在被 gitignore 的 network/）。 */
export function loadAccounts() {
  const p = join(NETWORK_DIR, 'accounts.json');
  if (!existsSync(p)) {
    throw new Error(`找不到 ${p}。請先執行 \`npm run gen\` 產生本地網路。`);
  }
  return readJson(p);
}

/** 讀 deploy.sh 輸出的部署位址。 */
export function loadDeployment(chainId) {
  const p = join(DEPLOYMENTS_DIR, `${chainId}.json`);
  if (!existsSync(p)) {
    throw new Error(`找不到 ${p}。請先執行 \`npm run deploy\`。`);
  }
  return readJson(p);
}

/** 從 forge 編譯產物 contracts/out/<Name>.sol/<Name>.json 取 ABI。 */
export function loadAbi(name) {
  const p = join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) {
    throw new Error(`找不到 ${p}。請先在 contracts/ 執行 forge build（deploy.sh 會做）。`);
  }
  return readJson(p).abi;
}

// ── 資產 ──────────────────────────────────────────────────────────────────────
/** 與 Solidity `keccak256("sBTC")` 相同的資產 ID。 */
export function assetId(symbol) {
  return keccak256(toBytes(symbol));
}

/** Deploy.s.sol 註冊的 4 個資產與初始價（8 位小數）。 */
export const DEPLOY_ASSETS = {
  sBTC: 50_000n * 10n ** 8n,
  sETH: 3_000n * 10n ** 8n,
  sAAPL: 200n * 10n ** 8n,
  sTSLA: 250n * 10n ** 8n,
};

/** 8 位小數價格 → 便於閱讀的字串。 */
export function fmtPrice8(p) {
  const v = BigInt(p);
  const whole = v / 10n ** 8n;
  const frac = (v % 10n ** 8n).toString().padStart(8, '0').slice(0, 2);
  return `${whole}.${frac}`;
}

/** 18 位小數金額（MockUSDC 與 exchange 內部記帳都是 18 位）→ 字串，保留 4 位。 */
export function fmt18(x) {
  const v = BigInt(x);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** 18n;
  const frac = (a % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ── viem client ───────────────────────────────────────────────────────────────
/**
 * 建立連本地 Besu 的 public／wallet client。連線前先過白名單（assertLocalBesu）：
 * chainId 必須等於 network/accounts.json 的 chainId、client 必須是 Besu。privateKey 可省略（只讀）。
 * expectedChainId 預設讀 network/accounts.json；只有測試才需要傳。
 */
export async function makeClients({ rpcUrl = DEFAULT_RPC_URL, privateKey, expectedChainId } = {}) {
  const expected = expectedChainId ?? loadAccounts().chainId;
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, clientVersion] = await Promise.all([
    probe.getChainId(),
    probe.request({ method: 'web3_clientVersion', params: [] }),
  ]);
  assertLocalBesu({ chainId, clientVersion, expectedChainId: expected });
  const chain = defineChain({
    id: chainId,
    name: `besu-local-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  let walletClient = null;
  let account = null;
  if (privateKey) {
    account = privateKeyToAccount(privateKey);
    walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
  }
  return { chain, chainId, publicClient, walletClient, account };
}

/**
 * 送一筆合約交易並等收據。先 simulate（失敗時拿得到 revert 原因），
 * 收據 status 不是 success 就丟錯——不吞任何失敗。
 */
export async function sendTx(ctx, { address, abi, functionName, args = [], value }) {
  const { publicClient, walletClient, account } = ctx;
  const { request } = await publicClient.simulateContract({
    address, abi, functionName, args, value, account,
  });
  const hash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    throw new Error(`${functionName} 交易失敗：${hash}（block ${receipt.blockNumber}）`);
  }
  return receipt;
}

// ── 可重播的隨機價格（GBM）────────────────────────────────────────────────────
/** mulberry32：32-bit 種子 PRNG，同一個種子永遠產生同一串數字（可重播）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller：由均勻亂數產生標準常態亂數。 */
export function makeNormal(rand) {
  return function normal() {
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/**
 * 幾何布朗運動一步：S' = S · exp((μ − σ²/2)Δt + σ√Δt·Z)。
 * price8 是 8 位小數的 bigint；mu／sigma 為年化；dtSeconds 為推價間隔。
 * 回傳新的 8 位小數 bigint（至少 1，避免 MockOracle 的 InvalidPrice）。
 */
export function gbmStep(price8, { mu = 0, sigma = 0.6, dtSeconds = 5, z }) {
  const dt = dtSeconds / (365 * 24 * 3600);
  const factor = Math.exp((mu - (sigma * sigma) / 2) * dt + sigma * Math.sqrt(dt) * z);
  // 以 1e-8 為單位計算，再轉回 bigint；Number 對 1e13 等級的整數仍精確到個位。
  const next = Math.round(Number(price8) * factor);
  return BigInt(Math.max(1, next));
}

/**
 * 解析可重播的價格檔（CSV）：每行 `symbol,price`（price 是人類可讀的美元價，例如 41500.25），
 * 允許 `#` 註解與空行。回傳 [{ symbol, price8 }]，依檔案順序。
 */
export function parseReplay(text) {
  const out = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [symbol, price] = line.split(',').map((s) => s.trim());
    if (!symbol || !price || !/^\d+(\.\d{1,8})?$/.test(price)) {
      throw new Error(`價格檔第 ${i + 1} 行格式錯誤：「${raw}」（應為 symbol,price）`);
    }
    out.push({ symbol, price8: usdToPrice8(price) });
  }
  return out;
}

/** "41500.25" → 4150025000000n（8 位小數）。 */
export function usdToPrice8(s) {
  const [w, f = ''] = String(s).split('.');
  return BigInt(w) * 10n ** 8n + BigInt((f + '00000000').slice(0, 8));
}

// ── 清算候選 ──────────────────────────────────────────────────────────────────
/**
 * 與 PerpetualExchange.liquidatePosition 的門檻相同：
 *   closeAmount = margin + pnl − fees − funding（＝ getPositionValue，負值被夾成 0）
 *   可清算 ⇔ closeAmount ≤ notional × maintenanceMarginBps / 10000
 * 這只是「候選」過濾；真正送交易前一律再用 eth_call 模擬 liquidatePosition 確認。
 */
export function isLiquidationCandidate({ value, margin, leverage, maintenanceMarginBps }) {
  const notional = BigInt(margin) * BigInt(leverage);
  const mm = (notional * BigInt(maintenanceMarginBps)) / 10_000n;
  return BigInt(value) <= mm;
}
