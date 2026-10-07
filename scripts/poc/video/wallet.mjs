// 注入式 EIP-1193 錢包：讓 Playwright 錄影時頁面有一個「像 MetaMask」的 window.ethereum，
// 但簽名與送交易全部在 Node 端用 ethers Wallet 完成。
//
// 安全邊界（改這支檔案前請先讀）：
//   - 私鑰只存在 Node 行程記憶體裡的 ethers Wallet 物件。
//   - 絕不 console.log Wallet / privateKey / keystore 內容，絕不寫檔，絕不傳進頁面。
//     頁面只拿得到：地址、chainId、RPC 結果、簽名結果、tx hash。
//   - keystore 解鎖失敗時，錯誤訊息只帶角色名稱，不帶原始例外（ethers 的例外可能
//     夾帶 JSON 片段）。
//   - 預設 allowSend=false：eth_sendTransaction 直接拒絕（code 4001），只有
//     呼叫端明確開啟（record.mjs --allow-tx / POC_ALLOW_TX=1）才會廣播。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcProvider, Wallet, getBytes, isHexString, toUtf8String } from 'ethers';

export const CHAIN_ID = 84532;
export const CHAIN_ID_HEX = '0x14a34';
export const DEFAULT_RPC = 'https://sepolia.base.org';

/** 頁面可以直接轉發到公開節點的唯讀方法。不在清單上的一律拒絕。 */
const READ_METHODS = new Set([
  'eth_call',
  'eth_getBalance',
  'eth_blockNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
]);

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * 唯讀方法原樣轉發到公開節點（不經 ethers），節點回的 error（含 revert data）原封
 * 不動交回頁面——前端靠 revert data 解析自訂錯誤，經 ethers 包一層會變成
 * "missing revert data"。
 */
let rpcId = 0;
const MAX_INFLIGHT = 4; // 公開節點對同一來源的並發很敏感，超過會回 429
let inflight = 0;
const waiting = [];
async function withSlot(fn) {
  if (inflight >= MAX_INFLIGHT) await new Promise((r) => waiting.push(r));
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    waiting.shift()?.();
  }
}

async function rawRpc(rpcUrl, method, params) {
  for (let attempt = 0; ; attempt++) {
    const res = await withSlot(() => fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }));
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new RpcError(-32603, `RPC HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.code ?? -32603, body.error.message ?? 'rpc error', body.error.data);
    return body.result;
  }
}

function keystorePaths(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new RpcError(-32602, `角色名稱不合法：${name}`);
  const foundry = path.join(os.homedir(), '.foundry');
  return {
    keystore: path.join(foundry, 'keystores', `pepelab-rwa-${name}`),
    password: path.join(foundry, `pepelab-rwa-${name}.password`),
  };
}

/**
 * 解開 foundry keystore。回傳的 Wallet 只能留在記憶體。
 * 錯誤訊息刻意不包含原始例外，避免 keystore 片段外洩到 log。
 */
async function unlock(name) {
  const p = keystorePaths(name);
  if (!fs.existsSync(p.keystore)) throw new Error(`找不到角色 ${name} 的 keystore（~/.foundry/keystores/pepelab-rwa-${name}）`);
  if (!fs.existsSync(p.password)) throw new Error(`找不到角色 ${name} 的密碼檔（~/.foundry/pepelab-rwa-${name}.password）`);
  try {
    return await Wallet.fromEncryptedJson(fs.readFileSync(p.keystore, 'utf8'), fs.readFileSync(p.password, 'utf8').replace(/\s+$/, ''));
  } catch {
    throw new Error(`角色 ${name} 的 keystore 解鎖失敗（密碼錯誤或檔案損毀）`);
  }
}

// 在頁面裡執行的 provider。這段字串會進頁面，所以裡面只能有公開資訊。
// 只注入到「主 frame 且 origin 等於受測前端」：iframe、外部網站都拿不到 window.ethereum。
// （真正的防線在 Node 端 binding 的來源檢查；這裡只是不讓其他來源看到 provider。）
function pageProvider(allowedOrigin) {
  if (window.top !== window || window.location.origin !== allowedOrigin) return;
  if (window.ethereum && window.ethereum.__pepePoc) return;
  const listeners = new Map();
  const emit = (event, ...args) => {
    for (const fn of listeners.get(event) ?? []) {
      try { fn(...args); } catch (e) { console.error('[poc-wallet] listener error', e); }
    }
  };
  const provider = {
    __pepePoc: true,
    isMetaMask: true,
    chainId: '0x14a34',
    async request({ method, params }) {
      const res = await window.__pepePocBridge(method, JSON.stringify(params ?? []));
      if (res.error) {
        const err = new Error(res.error.message);
        err.code = res.error.code;
        if (res.error.data !== undefined) err.data = res.error.data;
        throw err;
      }
      return res.result;
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return provider;
    },
    removeListener(event, fn) {
      listeners.get(event)?.delete(fn);
      return provider;
    },
    // 舊式 API，部分函式庫還會探測
    enable() { return provider.request({ method: 'eth_requestAccounts' }); },
  };
  provider.off = provider.removeListener;
  window.__pepePocEmit = emit;
  window.ethereum = provider;

  // EIP-6963：讓會列舉錢包的函式庫也看得到
  const info = { uuid: 'pepelab-poc-video', name: 'PepeLab PoC Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'tw.pepelab.poc' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

/**
 * 在 page 上安裝注入錢包。必須在第一次 page.goto 之前呼叫。
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   role: string,
 *   origin: string,              受測前端的 origin（例如 http://localhost:5173）；只有主 frame 且 origin 相符才能用錢包
 *   rpcUrl?: string,
 *   allowSend?: boolean,         false（預設）＝ eth_sendTransaction 一律拒絕
 *   allowSign?: boolean,         false ＝ personal_sign / eth_signTypedData_v4 也一律拒絕（--no-sign）
 *   onSign?: (entry: object) => void,  每個簽章請求（不論核准或拒絕）都回報，供寫進 JSON 紀錄
 *   log?: (msg: string) => void,
 * }} opts
 */
export async function installWallet(page, { role, origin, rpcUrl = DEFAULT_RPC, allowSend = false, allowSign = true, onSign = () => {}, log = () => {} }) {
  if (!origin) throw new Error('installWallet 需要 origin（受測前端的 origin）');
  const allowedOrigin = new URL(origin).origin;
  const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
  /** @type {Map<string, Wallet>} 角色 → 已解鎖 Wallet（只在記憶體） */
  const unlocked = new Map();
  let current = null; // { name, wallet }
  const txListeners = new Set();
  const sentTx = [];

  async function getWallet(name) {
    if (!unlocked.has(name)) unlocked.set(name, (await unlock(name)).connect(provider));
    return unlocked.get(name);
  }

  current = { name: role, wallet: await getWallet(role) };
  log(`錢包角色 ${role} → ${current.wallet.address}`);

  const sameAddr = (a) => typeof a === 'string' && a.toLowerCase() === current.wallet.address.toLowerCase();

  async function handle(method, params) {
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [current.wallet.address];
      case 'eth_chainId':
        return CHAIN_ID_HEX;
      case 'net_version':
        return String(CHAIN_ID);
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': {
        const want = params?.[0]?.chainId;
        if (want && BigInt(want) === BigInt(CHAIN_ID)) return null;
        throw new RpcError(4902, `PoC 錢包只支援 Base Sepolia (${CHAIN_ID})`);
      }
      case 'wallet_requestPermissions':
      case 'wallet_getPermissions':
        return [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [current.wallet.address] }] }];
      case 'personal_sign': {
        const [msg, addr] = params;
        if (!sameAddr(addr)) throw new RpcError(4100, '簽名地址不是目前角色');
        const payload = isHexString(msg) ? getBytes(msg) : msg;
        const text = typeof payload === 'string' ? payload : safeUtf8(payload);
        const entry = { method, role: current.name, address: current.wallet.address, message: text.slice(0, 300), timestamp: new Date().toISOString() };
        if (!allowSign) {
          onSign({ ...entry, approved: false, reason: '--no-sign' });
          throw new RpcError(4001, 'PoC 錄影 --no-sign：已拒絕簽章');
        }
        log(`personal_sign（${current.name}）：${entry.message}`);
        onSign({ ...entry, approved: true });
        return current.wallet.signMessage(payload);
      }
      case 'eth_signTypedData_v4': {
        const [addr, json] = params;
        if (!sameAddr(addr)) throw new RpcError(4100, '簽名地址不是目前角色');
        const typed = typeof json === 'string' ? JSON.parse(json) : json;
        const domain = typed.domain ?? {};
        const entry = {
          method,
          role: current.name,
          address: current.wallet.address,
          primaryType: typed.primaryType,
          domainName: domain.name ?? null,
          domainChainId: domain.chainId != null ? String(domain.chainId) : null,
          verifyingContract: domain.verifyingContract ?? null,
          timestamp: new Date().toISOString(),
        };
        // 只簽 Base Sepolia 或不綁鏈的 typed data：防止被誘導簽出能在其他鏈重放的授權
        if (domain.chainId != null && BigInt(domain.chainId) !== BigInt(CHAIN_ID)) {
          onSign({ ...entry, approved: false, reason: `domain.chainId ${domain.chainId} ≠ ${CHAIN_ID}` });
          throw new RpcError(4001, `PoC 錢包只簽 chainId ${CHAIN_ID} 的 typed data`);
        }
        if (!allowSign) {
          onSign({ ...entry, approved: false, reason: '--no-sign' });
          throw new RpcError(4001, 'PoC 錄影 --no-sign：已拒絕簽章');
        }
        const types = { ...typed.types };
        delete types.EIP712Domain; // ethers 自己從 domain 推導
        log(`eth_signTypedData_v4（${current.name}）：primaryType=${typed.primaryType} domain=${entry.domainName}`);
        onSign({ ...entry, approved: true });
        return current.wallet.signTypedData(domain, types, typed.message);
      }
      case 'eth_sendTransaction': {
        const [tx] = params;
        if (tx.from && !sameAddr(tx.from)) throw new RpcError(4100, '交易 from 不是目前角色');
        if (!allowSend) {
          log(`已攔下 eth_sendTransaction（唯讀模式，未廣播）to=${tx.to}`);
          throw new RpcError(4001, 'PoC 錄影唯讀模式：已拒絕送出交易（以 --allow-tx 開啟）');
        }
        const sent = await current.wallet.sendTransaction({
          to: tx.to,
          data: tx.data ?? tx.input,
          value: tx.value ? BigInt(tx.value) : undefined,
          gasLimit: tx.gas ? BigInt(tx.gas) : undefined,
        });
        log(`已送出交易（${current.name}）${sent.hash}`);
        sentTx.push({ hash: sent.hash, role: current.name, timestamp: new Date().toISOString() });
        for (const fn of txListeners) fn(sent.hash);
        return sent.hash;
      }
      case 'eth_sendRawTransaction':
        throw new RpcError(4200, 'PoC 錢包不接受頁面自備的 raw transaction');
      default:
        if (READ_METHODS.has(method)) return rawRpc(rpcUrl, method, params);
        throw new RpcError(4200, `PoC 錢包不支援 ${method}`);
    }
  }

  // exposeBinding 會裝進每個 frame（含跨來源 iframe 與導到外部網站後的頁面），
  // 所以每次呼叫都檢查來源：只接受主 frame 且 origin 等於受測前端。
  await page.exposeBinding('__pepePocBridge', async (source, method, paramsJson) => {
    let frameOrigin = null;
    try { frameOrigin = new URL(source.frame.url()).origin; } catch { /* about:blank 等 */ }
    if (source.frame !== page.mainFrame() || frameOrigin !== allowedOrigin) {
      log(`已拒絕來自非受測頁面的錢包請求：${method}（${frameOrigin ?? source.frame.url()}）`);
      return { error: { code: 4100, message: 'PoC 錢包只服務受測前端的主頁面' } };
    }
    try {
      return { result: await handle(method, JSON.parse(paramsJson)) };
    } catch (e) {
      // 只回傳 code + message；不回傳 stack 或原始物件
      const code = typeof e?.code === 'number' ? e.code : -32603;
      const message = e instanceof RpcError ? e.message : (e?.shortMessage ?? e?.message ?? 'internal error');
      if (process.env.POC_DEBUG === '1') log(`RPC ${method} 失敗（${code}）：${String(message).slice(0, 200)}`);
      const data = e instanceof RpcError ? e.data : undefined;
      return { error: { code, message: String(message).slice(0, 500), data } };
    }
  });
  await page.addInitScript(pageProvider, allowedOrigin);

  return {
    provider,
    get role() { return current.name; },
    get address() { return current.wallet.address; },
    sentTx,

    /** 錄影中途換角色（例如 issuer → investor），並對頁面發 accountsChanged。 */
    async switchRole(name) {
      current = { name, wallet: await getWallet(name) };
      log(`切換角色 → ${name}（${current.wallet.address}）`);
      await page.evaluate((addr) => window.__pepePocEmit?.('accountsChanged', [addr]), current.wallet.address);
      return current.wallet.address;
    },

    /** 等下一筆由頁面送出的交易，回傳 tx hash。 */
    nextTx({ timeout = 120_000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { txListeners.delete(fn); reject(new Error('等待交易逾時')); }, timeout);
        const fn = (hash) => { clearTimeout(timer); txListeners.delete(fn); resolve(hash); };
        txListeners.add(fn);
      });
    },

    /** 等交易上鏈，回傳 receipt。 */
    waitReceipt(hash, confirmations = 1) {
      return provider.waitForTransaction(hash, confirmations, 180_000);
    },
  };
}

function safeUtf8(bytes) {
  try { return toUtf8String(bytes); } catch { return `<${bytes.length} bytes>`; }
}
