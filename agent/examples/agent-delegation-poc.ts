// SSI 委託授權 × x402 KYA —— 可錄影的 PoC 驅動程式（由 scripts/poc/agent-delegation-demo.sh 呼叫）。
// docs/SSI_AGENT_DELEGATION.md §錄製步驟。
//
// 哪些是真的、哪些是模擬（錄影時請照這段口白說明）：
//   真的（本機 anvil 鏈）  AgentSessionManager／PerpetualExchange／SessionCredentialAnchor 合約、session 建立、
//                          錨定、開倉、合約層的額度檢查、撤銷——全部是真的鏈上交易（本機鏈，非公開鏈）。
//   真的（程式碼路徑）      v3 委託憑證的簽發與驗證、VP 簽章與驗證、ADR-016 狀態清單、signal-api 的 KYA 閘門、
//                          依 credentialHash 原子累計花費（Upstash 腳本）、x402 v1 付款授權（EIP-3009 簽章）。
//   模擬                   x402 facilitator（本機假 facilitator：會真的驗 EIP-3009 簽章，但結算不上鏈、沒有任何錢移動）、
//                          Upstash（本機假 Upstash，同一組 Lua 語意）、/signals 的訊號內容（固定的假資料）。
//   不使用                 公開 facilitator、公開鏈、真錢、任何 .env 或真實私鑰（只用 anvil 公開測試助記詞）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const env = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`缺少環境變數 ${k}（請用 scripts/poc/agent-delegation-demo.sh 執行）`);
  return v;
};
const RPC = env("POC_RPC_URL");
const MANAGER = env("POC_SESSION_MANAGER");
const ANCHOR = env("POC_SESSION_ANCHOR");
const EXCHANGE = env("POC_EXCHANGE");
const USDC = env("POC_USDC");

// ── 在載入 @pepelab/shared 之前設好環境（它在 import 時讀設定）──────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepelab-kya-poc-"));
const STATUS_DIR = path.join(TMP, "vc-status");
fs.mkdirSync(STATUS_DIR, { recursive: true });
const { ethers } = await import("ethers");
// anvil 的公開測試助記詞（Foundry 文件公開、沒有任何價值）；#1＝使用者、#2＝代理人。
const MNEMONIC = "test test test test test test test test test test test junk";
const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true, cacheTimeout: -1 });
const chainId = Number((await provider.getNetwork()).chainId);
const userW = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/1").connect(provider);
const agentW = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/2").connect(provider);
Object.assign(process.env, {
  AGENT_CHAIN_ID: String(chainId),
  BASE_SEPOLIA_RPC_URL: RPC,
  SESSION_MANAGER_ADDRESS: MANAGER,
  SESSION_ANCHOR_ADDRESS: ANCHOR,
  AGENT_PRIVATE_KEY: agentW.privateKey, // 只存在這個 process 的記憶體；是 anvil 測試助記詞推出的金鑰
  DELEGATION_VC_CHAIN_IDS: `${chainId},84532`,
  VC_STATUS_DIR: STATUS_DIR,
  VC_STATUS_STATE_PATH: path.join(TMP, "vc-status-state.json"),
  VC_STATUS_CACHE_MAX_AGE_SEC: "0",
  VC_NONCE_STATE_PATH: path.join(TMP, "vc-nonces.json"),
  POLICY_STATE_PATH: path.join(TMP, "policy.json"),
  POLICY_AUDIT_PATH: path.join(TMP, "audit.jsonl"),
  X402_NETWORK: "base-sepolia",
});
for (const k of ["X402_PROTOCOL", "PAY_TO", "X402_KYA_MODE", "RISK_GATE_ENABLED", "AGENT_ALLOW_UNSIGNED_TRADES"]) delete process.env[k];

const { startMockFacilitator } = await import("../signal-api/src/testing/mockFacilitator.ts");
const { startFakeUpstash } = await import("../signal-api/src/testing/fakeUpstash.ts");
const { startRpcStub } = await import("../signal-api/src/testing/rpcStub.ts");
const facilitator = await startMockFacilitator();
const upstash = await startFakeUpstash();
const rpcStub = await startRpcStub();
process.env.X402_FACILITATOR_URL = facilitator.url;
process.env.UPSTASH_REDIS_REST_URL = upstash.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "poc-token";
process.env.X402_PAYTO_ALLOWLIST = "0x4444444444444444444444444444444444444444";

const shared = await import("@pepelab/shared");
const {
  issueDelegationCredential, readOnchainSession, termsFromOnchain, kyaFetch, verifyDelegationCredential,
  delegationAsVerifyResult, credentialJti, issueStatusList, openPositionForSession, ADDRESSES,
  STATUS_DIRECTORY_MARKER, STATUS_DIRECTORY_TYPE, SESSION_ANCHOR_ABI, AGENT_PRESENTATION_HEADER,
  AGENT_KYA_SPEND_HEADER, formatUsdcAtomic, resolveX402MaxValue, agentDid, assetIdOf, AGENT_SESSION_MANAGER_ABI,
} = shared;
const { createApp } = await import("../signal-api/src/app.ts");
const { createKyaGate, providerKyaChainReader, upstashKyaSpendStore } = await import("../signal-api/src/kya.ts");
const { serve } = await import("@hono/node-server");
const { createWalletClient, http, publicActions } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const { baseSepolia } = await import("viem/chains");
const { wrapFetchWithPayment } = await import("x402-fetch");

fs.writeFileSync(path.join(STATUS_DIR, STATUS_DIRECTORY_MARKER), JSON.stringify({ type: STATUS_DIRECTORY_TYPE }));

// ── 小工具 ────────────────────────────────────────────────────────────────────
let step = 0;
const results: { step: string; ok: boolean }[] = [];
const banner = (title: string, say: string) => {
  step++;
  console.log(`\n${"━".repeat(72)}\n【步驟 ${step}】${title}\n${"━".repeat(72)}`);
  console.log(`📣 ${say}`);
};
const expect = (label: string, ok: boolean, detail = "") => {
  results.push({ step: `${step}. ${label}`, ok });
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `：${detail}` : ""}`);
};
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const BTC = assetIdOf("sBTC");
const ETH = assetIdOf("sETH");

const mgr = new ethers.Contract(MANAGER, [
  ...AGENT_SESSION_MANAGER_ABI,
  "function createSessionWithAssets(address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 maxLeverage, uint256 expiry, bytes32[] allowedAssets) returns (uint256)",
  "function revokeSession(uint256 sessionId)",
  "error MarginExceedsPerTradeCap()",
  "error SessionIsRevoked()",
], provider);
const anchorC = new ethers.Contract(ANCHOR, SESSION_ANCHOR_ABI, provider);
const usdc = new ethers.Contract(USDC, ["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"], provider);
const exchange = new ethers.Contract(
  EXCHANGE,
  ["function depositMargin(uint256)", "function executionFee() view returns (uint256)"],
  provider,
);
const deployer = await provider.getSigner(0); // anvil 解鎖帳號 #0（部署者＝MockUSDC owner）
// 送交易一律經 NonceManager：ethers 會短暫快取 eth_getTransactionCount，連續送出會撞同一個 nonce。
const userTx = new ethers.NonceManager(userW);
const agentTx = new ethers.NonceManager(agentW);

// ── 0) 準備：使用者入金（本機鏈）────────────────────────────────────────────────
banner("準備：使用者存入保證金", "使用者（anvil #1）領 MockUSDC 並存入交易所，作為代理人下單的保證金。這一步與 SSI 無關，只是讓之後的下單有錢可用。");
await (await (usdc.connect(deployer) as any).mint(userW.address, 10_000n * 10n ** 18n)).wait();
await (await (usdc.connect(userTx) as any).approve(EXCHANGE, ethers.MaxUint256)).wait();
await (await (exchange.connect(userTx) as any).depositMargin(1_000n * 10n ** 18n)).wait();
console.log(`使用者 ${userW.address} 存入 1,000 USDC（MockUSDC，本機鏈）`);
console.log(`代理人 ${agentW.address}\n代理人 DID：${agentDid(agentW.address, chainId)}`);

// ── 1) 建立 session ────────────────────────────────────────────────────────────
banner("使用者在鏈上建立受限 session", "使用者把一把有界的 session key 委派給代理人：單筆 100、總預算 300、最高 5 倍、24 小時、只能交易 sBTC 與 sETH。");
const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
const rc = await (await (mgr.connect(userTx) as any).createSessionWithAssets(
  agentW.address, 100n * 10n ** 18n, 300n * 10n ** 18n, 5n, BigInt(expiry), [BTC, ETH],
)).wait();
const created = rc.logs.map((l: any) => { try { return mgr.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "SessionCreated");
const sessionId = Number(created.args[0]);
expect("鏈上 SessionCreated", true, `session #${sessionId}，tx ${short(rc.hash)}`);

// ── 2) 簽發 v3 委託憑證 ────────────────────────────────────────────────────────
banner("使用者簽發 v3 委託授權憑證（W3C VC 2.0）", "使用者錢包以 EIP-712 簽一張 AgentDelegationCredential：內容逐欄抄自鏈上 session，再加上 x402 付費上限——每小時 0.02 USDC、總額 0.03 USDC，只准呼叫 /signals 與 /oracle。");
const onchain = await readOnchainSession(provider, MANAGER, sessionId);
const { credential, credentialHash } = await issueDelegationCredential({
  issuer: userW,
  agentAddress: agentW.address,
  sessionManager: MANAGER,
  sessionId,
  session: termsFromOnchain(onchain),
  x402: { maxPerPeriod: "20000", periodSeconds: 3600, maxTotal: "30000", endpoints: ["GET /signals/*", "GET /oracle/*"] },
  chainId,
});
fs.writeFileSync(path.join(TMP, "delegation-vc-v3.json"), JSON.stringify(credential, null, 2));
console.log(JSON.stringify({ type: credential.type, issuer: credential.issuer, credentialSubject: credential.credentialSubject, credentialStatus: credential.credentialStatus, validUntil: credential.validUntil }, null, 2));
const v = verifyDelegationCredential(credential, { expectedSessionManager: MANAGER });
expect("憑證簽章驗證", v.valid, `credentialHash ${short(credentialHash)}`);

// ── 3) 錨定 ────────────────────────────────────────────────────────────────────
banner("使用者把憑證錨定到鏈上", "只有 session 的使用者能呼叫 SessionCredentialAnchor.anchor；第三方因此能確認這張憑證就是 session 擁有者目前認可的那一張。");
try {
  await (anchorC.connect(agentW) as any).anchor.staticCall(sessionId, credentialHash);
  expect("代理人自己錨定被拒", false);
} catch {
  expect("代理人自己錨定被拒（NotSessionUser）", true);
}
const ar = await (await (anchorC.connect(userTx) as any).anchor(sessionId, credentialHash)).wait();
expect("使用者錨定成功", Boolean(await anchorC.isAnchored(sessionId, credentialHash)), `tx ${short(ar.hash)}`);

// ── 4) 起本機 signal-api（KYA 開啟）──────────────────────────────────────────────
banner("啟動本機 signal-api（x402 KYA 開啟）", "本機 signal-api：x402 v1＋v2、KYA 開啟、錨定必要。facilitator 與 Upstash 是本機模擬（不結算、不動錢），鏈上讀取打的是本機 anvil。");
const TRADER = "0x5555555555555555555555555555555555555555";
const kya = createKyaGate({
  config: { mode: "on", anchor: "required", sessionManager: ethers.getAddress(MANAGER), anchorAddress: ethers.getAddress(ANCHOR), acceptedChainIds: [chainId, 84532], maxSkewSec: 120 },
  chain: providerKyaChainReader(provider),
  spend: upstashKyaSpendStore(),
});
const app = createApp({
  x402Protocol: "both",
  payTo: "0x4444444444444444444444444444444444444444",
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => true,
  signalReader: async (trader) => ({ trader, note: "PoC 模擬訊號（固定資料）", suggestion: "sBTC long 2x" }),
  kya,
});
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((r) => server.once("listening", () => r()));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
console.log(`signal-api ${API}（KYA on）；mock facilitator ${facilitator.url}（模擬）`);

const account = privateKeyToAccount(agentW.privateKey as `0x${string}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcStub.url) }).extend(publicActions);
const plainPay = wrapFetchWithPayment(fetch, wallet as never, resolveX402MaxValue()) as unknown as typeof fetch;
const kyaPay = wrapFetchWithPayment(
  kyaFetch({ credential, holderAddress: agentW.address, signTypedData: (d, t, m) => agentW.signTypedData(d, t, m), allowedOrigins: [API] }),
  wallet as never,
  resolveX402MaxValue(),
) as unknown as typeof fetch;
const call = async (f: typeof fetch, label: string) => {
  const r = await f(`${API}/signals/${TRADER}`, { method: "GET" });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const spend = r.headers.get(AGENT_KYA_SPEND_HEADER);
  const m = spend && /total=(\d+);period=(\d+)/.exec(spend);
  console.log(`${label} → HTTP ${r.status}${m ? `（憑證累計 ${formatUsdcAtomic(BigInt(m[1]!))} USDC，本期 ${formatUsdcAtomic(BigInt(m[2]!))}）` : ""}${r.status >= 400 ? `：${String(body.error ?? "")} ${String(body.message ?? "")}` : ""}`);
  return { status: r.status, body };
};

// ── 5) 沒出示憑證的代理人 ───────────────────────────────────────────────────────
banner("沒有出示憑證的代理人付費呼叫", "同一個代理人錢包付款，但不附 Verifiable Presentation：在付款送進 facilitator 之前就被擋下。");
{
  const verifyBefore = facilitator.count("/verify");
  const r = await call(plainPay, "GET /signals（無 presentation）");
  expect("無 presentation → 403 kya_presentation_required，未扣款", r.status === 403 && facilitator.count("/verify") === verifyBefore);
}

// ── 6) 出示 VP 呼叫付費端點 ─────────────────────────────────────────────────────
banner("代理人出示 VP 呼叫付費端點（x402 KYA）", "代理人以自己的金鑰簽 VP，綁定這次請求的路徑、時間與 x402 付款的 EIP-3009 nonce。signal-api 驗證：VP 簽者＝憑證主體＝付款人、憑證未撤銷、未過期、已錨定、與鏈上 session 一致，再依 credentialHash 累計花費。");
{
  const r1 = await call(kyaPay, "第 1 次 GET /signals（0.01 USDC）");
  const r2 = await call(kyaPay, "第 2 次 GET /signals（0.01 USDC）");
  expect("兩次都通過（本期累計 0.02，等於每期上限）", r1.status === 200 && r2.status === 200);
}

// ── 7) 超過憑證花費上限 ──────────────────────────────────────────────────────────
banner("超過憑證的 x402 花費上限", "第三次會讓本期花費超過 0.02 USDC：signal-api 依憑證上限回 403 並說明，付款授權不會送去結算。");
{
  const settles = facilitator.count("/settle");
  const r3 = await call(kyaPay, "第 3 次 GET /signals");
  expect("超額 → 403 kya_spend_limit_exceeded、沒有結算", r3.status === 403 && r3.body.error === "kya_spend_limit_exceeded" && facilitator.count("/settle") === settles);
}

// ── 8) 代理人在 session 上限內下單 ──────────────────────────────────────────────
banner("代理人在 session 額度內下單", "代理人帶著同一張 v3 憑證下單：write 路徑先驗憑證（簽章、撤銷、與鏈上 session 逐欄比對），再由 AgentSessionManager 在鏈上檢查額度。");
const useWritePath = ADDRESSES.PerpetualExchange.toLowerCase() === EXCHANGE.toLowerCase();
console.log(useWritePath ? "（使用 agent/shared 的 openPositionForSession 寫入路徑：VC 閘門＋policy gate＋簽章守門）" : "（前端 addresses.ts 的 anvil 位址與本次部署不同 → 改用等價的直接呼叫：先以同一組 shared 函式驗憑證，再送交易）");
async function trade(marginUsdc: number, label: string): Promise<{ ok: boolean; why: string }> {
  if (useWritePath) {
    const r = await openPositionForSession({ sessionId, symbol: "sBTC", isLong: true, marginUsdc, leverage: 2, authVc: credential });
    console.log(`${label} → ${r.ok ? `成功 tx ${short(r.txHash!)} positionId ${r.positionId}` : `拒絕（${r.reasonCode}）${r.error}`}`);
    return { ok: r.ok, why: r.reasonCode ?? "" };
  }
  const r3 = verifyDelegationCredential(credential, { expectedSessionManager: MANAGER });
  const st = await shared.checkCredentialStatus(delegationAsVerifyResult(r3), { action: "write", verifyingContract: MANAGER });
  const s = await readOnchainSession(provider, MANAGER, sessionId);
  const mm = shared.compareDelegationWithSession(r3.fields!, s);
  const margin = ethers.parseUnits(String(marginUsdc), 18);
  const why = !r3.valid ? r3.reasonCode! : !st.ok ? (st.status === "revoked" ? "VC_REVOKED" : "VC_STATUS_UNVERIFIED") : mm ? mm.code : margin > BigInt(r3.fields!.maxMarginPerTrade) ? "VC_MARGIN_CAP_EXCEEDED" : "";
  if (why) {
    console.log(`${label} → 拒絕（${why}），沒有送出交易`);
    return { ok: false, why };
  }
  const fee = (await exchange.executionFee()) as bigint;
  const tx = await (mgr.connect(agentTx) as any).openPositionForSession(sessionId, BTC, true, margin, 2n, ethers.ZeroAddress, { value: fee });
  const r = await tx.wait();
  console.log(`${label} → 成功 tx ${short(r.hash)}`);
  return { ok: true, why: "" };
}
{
  const ok1 = await trade(50, "開多 sBTC 50 USDC × 2");
  expect("額度內下單成功", ok1.ok);
  const bad = await trade(150, "開多 sBTC 150 USDC × 2（超過單筆 100）");
  expect("超額被憑證閘門拒絕", !bad.ok && bad.why === "VC_MARGIN_CAP_EXCEEDED");
  // 即使繞過鏈下閘門直接送交易，合約也會擋：
  try {
    const fee = (await exchange.executionFee()) as bigint;
    await (mgr.connect(agentW) as any).openPositionForSession.staticCall(sessionId, BTC, true, 150n * 10n ** 18n, 2n, ethers.ZeroAddress, { value: fee });
    expect("繞過閘門直接上鏈也被合約拒絕", false);
  } catch (e) {
    expect("繞過閘門直接上鏈也被合約拒絕（MarginExceedsPerTradeCap）", /MarginExceedsPerTradeCap|0x[0-9a-f]{8}|revert/i.test(String((e as Error).message)));
  }
}

// ── 9) 使用者撤銷 ────────────────────────────────────────────────────────────────
banner("使用者撤銷 session 與憑證", "使用者在鏈上 revokeSession，並以錢包簽一份 ADR-016 狀態清單把這張憑證的 jti 列為撤銷（前端撤銷 session 時會一併做這一步）。");
{
  const tx = await (await (mgr.connect(userTx) as any).revokeSession(sessionId)).wait();
  const jti = credentialJti(delegationAsVerifyResult(verifyDelegationCredential(credential)))!;
  const list = await issueStatusList({ issuer: userW, sequence: 1, revoked: [jti], verifyingContract: MANAGER });
  fs.writeFileSync(path.join(STATUS_DIR, `${userW.address.toLowerCase()}.json`), JSON.stringify(list, null, 2));
  console.log(`revokeSession tx ${short(tx.hash)}；狀態清單 sequence ${list.sequence} 撤銷 jti ${short(jti)}`);
  expect("鏈上錨定隨 session 撤銷失效（isAnchored=false）", !(await anchorC.isAnchored(sessionId, credentialHash)));
}

// ── 10) 撤銷後 ───────────────────────────────────────────────────────────────────
banner("撤銷後：VP 與下單都被拒", "撤銷是即時的：signal-api 的 KYA 與代理人的寫入路徑都拒絕這張憑證。");
{
  const r = await call(kyaPay, "撤銷後 GET /signals");
  expect("撤銷後 VP 被拒（403）", r.status === 403 && /kya_credential_revoked|kya_session_mismatch|kya_not_anchored/.test(String(r.body.error)));
  const t2 = await trade(10, "撤銷後開多 sBTC 10 USDC");
  expect("撤銷後下單被拒", !t2.ok);
}

// ── 總結 ──────────────────────────────────────────────────────────────────────
await new Promise<void>((r) => server.close(() => r()));
await facilitator.close();
await upstash.close();
await rpcStub.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${"═".repeat(72)}\nPoC 結果：${results.length - failed.length}/${results.length} 項符合預期`);
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.step}`);
console.log(`\n模擬的部分：x402 facilitator（不結算、不動錢）、Upstash、/signals 訊號內容。其餘皆為真實程式碼與本機鏈交易。`);
console.log(`憑證與狀態清單：${TMP}`);
process.exit(failed.length ? 1 : 0);
