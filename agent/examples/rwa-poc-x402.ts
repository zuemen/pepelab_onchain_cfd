// RWA PoC（Base Sepolia 84532）× x402 KYA —— 真鏈、真 facilitator、真 USDC 的驅動程式。
// 由 scripts/poc/rwa-poc-x402.sh 呼叫；流程與結果見 docs/tenants/rwa-poc/X402_KYA.md。
//
//   tsx examples/rwa-poc-x402.ts setup <label> <maxPerPeriod> <maxTotal>
//       投資人（session.user）在 AgentSessionManager 開 session 給代理人 → 簽發 v3 委託憑證
//       （x402 上限以 atomic USDC 表示，6 位小數）→ 在 SessionCredentialAnchor 錨定。
//       每筆交易先 staticCall 模擬、通過才送出。憑證存到 agent/.state/rwa-poc/x402/<label>.json（gitignore）。
//   tsx examples/rwa-poc-x402.ts call <label> <vp|novp> [次數]
//       代理人對本機 signal-api 的 GET /signals/<trader> 付費呼叫（x402 v1，EIP-3009 付款人＝代理人）；
//       vp＝附 X-Agent-Presentation（kyaFetch），novp＝只付款不附憑證。印出 HTTP 狀態、錯誤碼、
//       結算 tx hash（X-PAYMENT-RESPONSE）與 KYA 花費累計。
//   tsx examples/rwa-poc-x402.ts balance
//
// 位址一律不寫死：session manager 讀 deploy/tenants/rwa-poc.deployed.json，錨定合約讀
// docs/tenants/rwa-poc/DEPLOYMENT.md，錢包位址由 keystore 解出，USDC 用 @pepelab/shared 的官方 Base Sepolia USDC。
// 金鑰：Foundry 加密 keystore（~/.foundry/keystores/pepelab-rwa-<名稱>），只在本 process 記憶體裡用
// ethers.Wallet.fromEncryptedJson 解開；不印出、不寫檔、不放進環境變數。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const STATE = path.join(REPO, "agent", ".state", "rwa-poc", "x402");
const RPC = process.env.RWA_POC_RPC_URL?.trim() || "https://sepolia.base.org";
const API = (process.env.RWA_POC_SIGNAL_API?.trim() || "http://localhost:4021").replace(/\/$/, "");
const EXPLORER = "https://sepolia.basescan.org/tx/";

process.env.AGENT_CHAIN_ID ??= "84532";
process.env.BASE_SEPOLIA_RPC_URL ??= RPC;

const { ethers } = await import("ethers");
const shared = await import("@pepelab/shared");
const {
  issueDelegationCredential, readOnchainSession, termsFromOnchain, kyaFetch, SESSION_ANCHOR_ABI,
  AGENT_KYA_SPEND_HEADER, formatUsdcAtomic, resolveX402MaxValue, assetIdOf, AGENT_SESSION_MANAGER_ABI,
  OFFICIAL_BASE_SEPOLIA_USDC, ADDRESSES, isCompromisedAddress,
} = shared as typeof shared & { OFFICIAL_BASE_SEPOLIA_USDC: string; isCompromisedAddress: (a: string) => boolean };

const provider = new ethers.JsonRpcProvider(RPC, 84532, { batchMaxCount: 1, staticNetwork: true, cacheTimeout: -1 });

// ── 位址（從部署紀錄讀）──────────────────────────────────────────────────────────
function tenantAddresses(): { manager: string; anchor: string } {
  const dep = JSON.parse(fs.readFileSync(path.join(REPO, "deploy", "tenants", "rwa-poc.deployed.json"), "utf8"));
  if (dep.chainId !== 84532) throw new Error("rwa-poc.deployed.json 不是 Base Sepolia");
  const manager = ethers.getAddress(dep.contracts.AgentSessionManager);
  const doc = fs.readFileSync(path.join(REPO, "docs", "tenants", "rwa-poc", "DEPLOYMENT.md"), "utf8");
  const line = doc.split("\n").find((l) => l.startsWith("| SessionCredentialAnchor |"));
  const m = line && /0x[0-9a-fA-F]{40}/.exec(line);
  if (!m) throw new Error("DEPLOYMENT.md 找不到 SessionCredentialAnchor 位址");
  return { manager, anchor: ethers.getAddress(m[0]) };
}

async function unlock(name: string) {
  if (!/^[a-z]+$/.test(name)) throw new Error("錢包名稱格式不對");
  const ks = fs.readFileSync(path.join(os.homedir(), ".foundry", "keystores", `pepelab-rwa-${name}`), "utf8");
  const pw = fs.readFileSync(path.join(os.homedir(), ".foundry", `pepelab-rwa-${name}.password`), "utf8").replace(/\r?\n$/, "");
  const w = await ethers.Wallet.fromEncryptedJson(ks, pw);
  return new ethers.Wallet(w.privateKey, provider); // 只在記憶體
}

/** 公開 RPC 會讀到舊狀態：重試直到條件成立。 */
async function until<T>(label: string, f: () => Promise<T>, ok: (v: T) => boolean, tries = 15): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await f();
      if (ok(v)) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label}：等不到預期狀態（最後：${String(last)}）`);
}

/** 先模擬再送；回傳收據。 */
async function simulateThenSend(c: any, fn: string, args: unknown[], label: string) {
  await c[fn].staticCall(...args);
  console.log(`  模擬通過：${label}`);
  const tx = await c[fn](...args);
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`${label} 失敗 ${rc.hash}`);
  console.log(`  ✅ ${label}  ${EXPLORER}${rc.hash}`);
  return rc;
}

async function setup(label: string, maxPerPeriod: string, maxTotal: string) {
  if (!/^[a-z0-9-]{1,20}$/.test(label)) throw new Error("label 只能是小寫英數與 -");
  const { manager, anchor } = tenantAddresses();
  const investor = await unlock("investor");
  const agent = await unlock("agent");
  const mgr = new ethers.Contract(manager, [
    ...AGENT_SESSION_MANAGER_ABI,
    "function createSessionWithAssets(address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 maxLeverage, uint256 expiry, bytes32[] allowedAssets) returns (uint256)",
    "event SessionCreated(uint256 indexed sessionId, address indexed user, address indexed agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 maxLeverage, uint256 expiry)",
  ], investor);
  const anchorC = new ethers.Contract(anchor, SESSION_ANCHOR_ABI, investor);
  if ((await anchorC.sessionManager()).toLowerCase() !== manager.toLowerCase()) throw new Error("錨定合約綁的 session manager 與部署紀錄不同");

  console.log(`【1】投資人 ${investor.address} 在 AgentSessionManager 開 session 給代理人 ${agent.address}`);
  const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const assets = ["sAAPL", "sGOLD", "sBTC", "sETH"].map((s) => assetIdOf(s));
  const args = [agent.address, 50n * 10n ** 18n, 150n * 10n ** 18n, 5n, BigInt(expiry), assets];
  const rc = await simulateThenSend(mgr, "createSessionWithAssets", args, "createSessionWithAssets（單筆 50、總預算 150、5 倍、7 天、sAAPL/sGOLD/sBTC/sETH）");
  const ev = rc.logs.map((l: any) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "SessionCreated");
  const sessionId = Number(ev!.args[0]);
  console.log(`  session #${sessionId}`);

  console.log(`【2】投資人簽發 v3 委託憑證（x402 每期 ${formatUsdcAtomic(BigInt(maxPerPeriod))}／總額 ${formatUsdcAtomic(BigInt(maxTotal))} USDC）`);
  const onchain = await until("讀鏈上 session", () => readOnchainSession(provider, manager, sessionId), (s: any) => s && String(s.agent).toLowerCase() === agent.address.toLowerCase());
  const { credential, credentialHash } = await issueDelegationCredential({
    issuer: investor,
    agentAddress: agent.address,
    sessionManager: manager,
    sessionId,
    session: termsFromOnchain(onchain),
    x402: { maxPerPeriod, periodSeconds: 3600, maxTotal, endpoints: ["GET /signals/*", "GET /oracle/*"] },
    chainId: 84532,
  });
  console.log(`  credentialHash ${credentialHash}`);

  console.log("【3】投資人在 SessionCredentialAnchor 錨定憑證雜湊");
  const ar = await simulateThenSend(anchorC, "anchor", [sessionId, credentialHash], "anchor(sessionId, credentialHash)");
  await until("isAnchored", () => anchorC.isAnchored(sessionId, credentialHash), (v: boolean) => v === true);
  console.log("  isAnchored = true");

  fs.mkdirSync(STATE, { recursive: true });
  const out = { label, sessionId, credentialHash, sessionTx: rc.hash, anchorTx: ar.hash, credential };
  fs.writeFileSync(path.join(STATE, `${label}.json`), JSON.stringify(out, null, 2));
  console.log(`  憑證已存 agent/.state/rwa-poc/x402/${label}.json`);
  console.log(`RESULT setup label=${label} session=${sessionId} hash=${credentialHash} sessionTx=${rc.hash} anchorTx=${ar.hash}`);
}

async function pickTrader(): Promise<string> {
  const reg = new ethers.Contract(ADDRESSES.StrategyRegistry, ["function getAllTraders() view returns (address[])"], provider);
  const list = (await reg.getAllTraders()) as string[];
  const t = list.find((a) => !isCompromisedAddress(a));
  if (!t) throw new Error("StrategyRegistry 沒有可用的 trader");
  return t;
}

async function call(label: string, mode: string, count: number) {
  const saved = JSON.parse(fs.readFileSync(path.join(STATE, `${label}.json`), "utf8"));
  const agent = await unlock("agent");
  const { createWalletClient, http, publicActions } = await import("viem");
  const { toAccount } = await import("viem/accounts");
  const { baseSepolia } = await import("viem/chains");
  const { wrapFetchWithPayment } = await import("x402-fetch");
  // viem 帳戶只把「簽 typed data」委派給記憶體裡的 ethers 錢包（不把私鑰交給第二個程式庫）。
  const account = toAccount({
    address: agent.address as `0x${string}`,
    signMessage: async ({ message }) => (await agent.signMessage(typeof message === "string" ? message : ethers.getBytes((message as any).raw))) as `0x${string}`,
    signTransaction: async () => { throw new Error("此 PoC 不簽交易"); },
    signTypedData: async (td: any) => {
      const types = { ...td.types };
      delete types.EIP712Domain;
      return (await agent.signTypedData(td.domain, types, td.message)) as `0x${string}`;
    },
  });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) }).extend(publicActions);
  const base = mode === "vp"
    ? kyaFetch({ credential: saved.credential, holderAddress: agent.address, signTypedData: (d, t, m) => agent.signTypedData(d, t, m), allowedOrigins: [API] })
    : fetch;
  const pay = wrapFetchWithPayment(base, wallet as never, resolveX402MaxValue()) as unknown as typeof fetch;
  const trader = await pickTrader();
  const usdc = new ethers.Contract(OFFICIAL_BASE_SEPOLIA_USDC, ["function balanceOf(address) view returns (uint256)"], provider);
  for (let i = 1; i <= count; i++) {
    const bal = (await usdc.balanceOf(agent.address)) as bigint;
    const url = `${API}/signals/${trader}`;
    const r = await pay(url, { method: "GET" });
    const text = await r.text();
    let body: any = {};
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    const xpr = r.headers.get("X-PAYMENT-RESPONSE");
    let settle: any = null;
    if (xpr) { try { settle = JSON.parse(Buffer.from(xpr, "base64").toString("utf8")); } catch { settle = xpr; } }
    const spend = r.headers.get(AGENT_KYA_SPEND_HEADER);
    console.log(`\n[${mode} #${i}] GET /signals/<trader> → HTTP ${r.status}（呼叫前代理人 USDC ${formatUsdcAtomic(bal)}）`);
    if (r.status >= 400) console.log(`  error=${String(body.error ?? "")} message=${String(body.message ?? body.reason ?? "").slice(0, 400)}`);
    if (body.accepts) console.log(`  accepts: ${JSON.stringify(body.accepts.map((a: any) => ({ scheme: a.scheme, network: a.network, maxAmountRequired: a.maxAmountRequired, payTo: a.payTo, asset: a.asset })))}`);
    if (settle) console.log(`  X-PAYMENT-RESPONSE: ${JSON.stringify(settle)}${settle.transaction ? `\n  結算 tx ${EXPLORER}${settle.transaction}` : ""}`);
    if (spend) console.log(`  ${AGENT_KYA_SPEND_HEADER}: ${spend}`);
    console.log(`RESULT call label=${label} mode=${mode} i=${i} status=${r.status} error=${String(body.error ?? "")} tx=${settle?.transaction ?? ""}`);
  }
}

async function balance() {
  const agent = await unlock("agent");
  const usdc = new ethers.Contract(OFFICIAL_BASE_SEPOLIA_USDC, ["function balanceOf(address) view returns (uint256)"], provider);
  const b = (await usdc.balanceOf(agent.address)) as bigint;
  console.log(`代理人 ${agent.address} USDC ${formatUsdcAtomic(b)}`);
  console.log(`RESULT balance atomic=${b}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "setup" && rest.length === 3 && /^\d+$/.test(rest[1]!) && /^\d+$/.test(rest[2]!)) await setup(rest[0]!, rest[1]!, rest[2]!);
else if (cmd === "call" && rest.length >= 2 && ["vp", "novp"].includes(rest[1]!)) await call(rest[0]!, rest[1]!, Number(rest[2] ?? 1));
else if (cmd === "balance") await balance();
else {
  console.error("用法：setup <label> <maxPerPeriod> <maxTotal> | call <label> <vp|novp> [次數] | balance");
  process.exit(2);
}
