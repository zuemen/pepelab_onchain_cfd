// 授權 VC 撤銷（狀態清單，ADR-016）測試。完全離線：不連鏈、不送交易。
// 快取與新鮮度一律用注入的時鐘；寫入路徑（write.ts）的整合段落只用真實時間「產生」
// 有效的 VC／清單，斷言不依賴時間。
//   npx tsx examples/vc-status.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-vc-status-"));
const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const OTHER_MGR = ethers.getAddress("0x" + "77".repeat(20));
const AGENT_PK = ethers.Wallet.createRandom().privateKey;
process.env.AGENT_PRIVATE_KEY = AGENT_PK;
process.env.SESSION_MANAGER_ADDRESS = MGR;
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.POLICY_STATE_PATH = path.join(TMP, "policy.json");
process.env.POLICY_AUDIT_PATH = path.join(TMP, "audit.jsonl");
process.env.VC_NONCE_STATE_PATH = path.join(TMP, "nonces.json");
process.env.VC_STATUS_DIR = path.join(TMP, "status");
process.env.VC_STATUS_STATE_PATH = path.join(TMP, "status-state.json");
process.env.VC_STATUS_CACHE_MAX_AGE_SEC = "0";
delete process.env.VC_STATUS_URL;
delete process.env.VC_STATUS_READ_POLICY;
delete process.env.RISK_GATE_ENABLED;
delete process.env.AGENT_ALLOW_UNSIGNED_TRADES;

const S = await import("@pepelab/shared");
const {
  issueAuthorizationVC, verifyAuthorizationVC, issueStatusList, verifyStatusList, credentialJti,
  createVcStatusChecker, memoryStatusStateStore, fileStatusStateStore, dirStatusSource, httpStatusSource,
  openPositionForSession, closePositionForSession, MAX_STATUS_CACHE_MAX_AGE_SEC, STATUS_DIRECTORY_TYPE,
  LEGACY_VC_SUNSET_ISO,
} = S;
type StatusFetch = import("@pepelab/shared").StatusFetch;
type VerifyResult = import("@pepelab/shared").VerifyResult;
const { createWriteHandlers } = await import("../mcp-server/src/writeTools.ts");
const { vcStatusProblemForBot } = await import("../tg-bot/guard.ts");
const { localVerifyVcWithStatus } = await import("./vc-gate.ts");

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// 固定的「現在」（早於 v1 淘汰期限，v1 段落才有意義）。
const T0 = Date.parse("2026-09-01T00:00:00Z") / 1000;
assert.ok(T0 * 1000 < Date.parse(LEGACY_VC_SUNSET_ISO));
const DAY = 86400;
const user = ethers.Wallet.createRandom();
const mallory = ethers.Wallet.createRandom();
const agent = new ethers.Wallet(AGENT_PK);
const caps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: T0 + 60 * DAY };

async function vcAt(issuedAt: number, o: Record<string, unknown> = {}) {
  const vc = await issueAuthorizationVC({ issuer: user, agentAddress: agent.address, sessionId: 3, caps, issuedAt, verifyingContract: MGR, ...o });
  const r = verifyAuthorizationVC(vc, { now: T0 * 1000 + DAY * 1000, expectedVerifyingContract: o.legacyV1 ? undefined : MGR });
  assert.equal(r.valid, true, r.reason);
  return { vc, r };
}
const list = (o: { sequence: number; revoked?: string[]; revokedBefore?: number; issuedAt?: number; validUntil?: number; issuer?: ethers.HDNodeWallet; verifyingContract?: string }) =>
  issueStatusList({ issuer: o.issuer ?? user, verifyingContract: o.verifyingContract ?? MGR, issuedAt: o.issuedAt ?? T0 + 3600, sequence: o.sequence, revoked: o.revoked, revokedBefore: o.revokedBefore, validUntil: o.validUntil });

/** 可控的假來源：記錄呼叫次數。 */
function fakeSource(initial: StatusFetch = { kind: "none" }) {
  const st = { next: initial, calls: 0 };
  return { st, src: { describe: "fake", fetch: async () => { st.calls++; return st.next; } } };
}
function harness(o: { initial?: StatusFetch; maxAge?: number; readPolicy?: "allow" | "deny"; store?: import("@pepelab/shared").StatusStateStore } = {}) {
  const clock = { ms: (T0 + DAY) * 1000 };
  const f = fakeSource(o.initial);
  const checker = createVcStatusChecker({
    source: f.src,
    store: o.store ?? memoryStatusStateStore(),
    now: () => clock.ms,
    cacheMaxAgeSec: o.maxAge ?? 60,
    readPolicy: o.readPolicy,
  });
  const check = (r: VerifyResult, action: "write" | "read" = "write") => checker.check(r, { action, verifyingContract: MGR });
  return { clock, f, checker, check };
}

// ───────────────────────── A. 清單本身的驗證 ─────────────────────────
const A = await vcAt(T0);
const B = await vcAt(T0 + 10);
{
  const l = await list({ sequence: 1, revoked: [A.r.nonce!] });
  const now = (T0 + DAY) * 1000;
  const good = verifyStatusList(l, { now, expectedIssuer: user.address, expectedVerifyingContract: MGR });
  assert.equal(good.valid, true);

  const tampered = structuredClone(l);
  tampered.revoked = [];
  assert.equal((verifyStatusList(tampered, { now }) as any).reasonCode, "STATUS_LIST_BAD_SIGNATURE", "拿掉撤銷項目 → 簽章不符");
  const tampered2 = structuredClone(l);
  tampered2.sequence = 99;
  assert.equal((verifyStatusList(tampered2, { now }) as any).reasonCode, "STATUS_LIST_BAD_SIGNATURE", "改 sequence → 簽章不符");

  const byMallory = await list({ sequence: 1, issuer: mallory });
  assert.equal((verifyStatusList(byMallory, { now, expectedIssuer: user.address }) as any).reasonCode, "STATUS_LIST_WRONG_ISSUER");
  const forged = structuredClone(byMallory);
  forged.issuer = `did:pkh:eip155:84532:${user.address}`;
  assert.equal((verifyStatusList(forged, { now }) as any).reasonCode, "STATUS_LIST_BAD_SIGNATURE", "冒用 issuer DID → 簽章不符");

  const otherDomain = await list({ sequence: 1, verifyingContract: OTHER_MGR });
  assert.equal((verifyStatusList(otherDomain, { now, expectedVerifyingContract: MGR }) as any).reasonCode, "STATUS_LIST_WRONG_DOMAIN");

  const expired = await list({ sequence: 1, issuedAt: T0, validUntil: T0 + 3600 });
  assert.equal((verifyStatusList(expired, { now }) as any).reasonCode, "STATUS_LIST_EXPIRED");
  const future = await list({ sequence: 1, issuedAt: T0 + 2 * DAY });
  assert.equal((verifyStatusList(future, { now }) as any).reasonCode, "STATUS_LIST_ISSUED_IN_FUTURE");

  const wrongChain = structuredClone(l);
  wrongChain.issuer = `did:pkh:eip155:1:${user.address}`;
  assert.equal((verifyStatusList(wrongChain, { now }) as any).reasonCode, "STATUS_LIST_WRONG_CHAIN");

  const unsorted = structuredClone(await list({ sequence: 1, revoked: [A.r.nonce!, B.r.nonce!] }));
  unsorted.revoked = [...unsorted.revoked].reverse();
  assert.equal((verifyStatusList(unsorted, { now }) as any).reasonCode, "STATUS_LIST_MALFORMED", "非正規排序 → 拒絕");

  await assert.rejects(list({ sequence: 1, validUntil: T0 + 91 * DAY }), /有效期/);
  await assert.rejects(list({ sequence: 1, issuedAt: T0, revokedBefore: T0 + 1 }), /revokedBefore/);
  ok("清單：竄改／冒用簽發者／別的部署／過期／未來時間／錯鏈／非正規排序 都被拒；有效期上限 90 天");
}

// ───────────────────────── B. jti 對應 ─────────────────────────
const V1 = await vcAt(T0 + 20, { legacyV1: true });
{
  assert.equal(credentialJti(A.r), A.vc.credentialSubject.nonce!.toLowerCase(), "v2：jti = nonce");
  assert.equal(V1.r.version, 1);
  assert.equal(credentialJti(V1.r), V1.r.digest!.toLowerCase(), "v1：jti = EIP-712 digest");
  ok("jti：v2 = 簽進 EIP-712 的 nonce（不另立欄位）；v1 = EIP-712 digest");
}

// ───────────────────────── C. 撤銷判斷 ─────────────────────────
{
  const h = harness();
  let r = await h.check(A.r);
  assert.equal(r.ok, true);
  assert.equal(r.reasonCode, "STATUS_NO_LIST");

  const h2 = harness({ initial: { kind: "list", doc: await list({ sequence: 1, revoked: [A.r.nonce!] }) } });
  r = await h2.check(A.r);
  assert.equal(r.ok, false);
  assert.equal(r.status, "revoked");
  assert.equal(r.reasonCode, "VC_REVOKED");
  assert.equal((await h2.check(A.r, "read")).ok, false, "已知撤銷：唯讀也拒絕");
  r = await h2.check(B.r);
  assert.equal(r.ok, true);
  assert.equal(r.reasonCode, "STATUS_ACTIVE");
  assert.equal(r.listSequence, 1);

  // revokedBefore：撤銷所有早於該時間簽發的；之後簽發的不受影響。
  const h3 = harness({ initial: { kind: "list", doc: await list({ sequence: 1, revokedBefore: T0 + 5 }) } });
  assert.equal((await h3.check(A.r)).reasonCode, "VC_REVOKED", "issuedAt T0 < revokedBefore");
  assert.equal((await h3.check(B.r)).reasonCode, "STATUS_ACTIVE", "issuedAt T0+10 ≥ revokedBefore");
  ok("沒有清單＝沒有撤銷；jti 在清單內 → VC_REVOKED（寫入、唯讀都拒）；revokedBefore 只撤銷較早簽發的");
}

// ───────────────────────── D. 重放舊清單 ─────────────────────────
{
  const l1 = await list({ sequence: 1 });
  const l2 = await list({ sequence: 2, revoked: [A.r.nonce!] });
  const h = harness({ initial: { kind: "list", doc: l2 }, maxAge: 60 });
  assert.equal((await h.check(A.r)).reasonCode, "VC_REVOKED");
  // 攻擊者（或過期的 CDN）改送舊清單（沒有撤銷 A）。
  h.f.st.next = { kind: "list", doc: l1 };
  h.clock.ms += 61_000;
  const rA = await h.check(A.r);
  assert.equal(rA.ok, false);
  assert.equal(rA.reasonCode, "VC_REVOKED", "撤銷不會因為舊清單而復活（sticky）");
  const rB = await h.check(B.r);
  assert.equal(rB.ok, false, "寫入：舊清單 → 拒絕");
  assert.equal(rB.reasonCode, "STATUS_LIST_REPLAYED");
  const rBread = await h.check(B.r, "read");
  assert.equal(rBread.ok, true, "唯讀（預設 allow）：放行但標 unknown");
  assert.equal(rBread.status, "unknown");
  assert.ok(rBread.warnings?.length);
  ok("重放舊版清單（sequence 較小）→ STATUS_LIST_REPLAYED，寫入拒絕；已撤銷的憑證不會復活");
}

// ───────────────────────── E. 同 sequence 不同內容 ─────────────────────────
{
  const h = harness({ initial: { kind: "list", doc: await list({ sequence: 5 }) }, maxAge: 0 });
  assert.equal((await h.check(B.r)).ok, true);
  h.f.st.next = { kind: "list", doc: await list({ sequence: 5, revoked: [A.r.nonce!] }) };
  const r = await h.check(B.r);
  assert.equal(r.reasonCode, "STATUS_LIST_EQUIVOCATION");
  assert.equal(r.ok, false);
  ok("同一個 sequence 出現兩份不同內容 → STATUS_LIST_EQUIVOCATION，寫入拒絕");
}

// ───────────────────────── F. 清單被扣住 ─────────────────────────
{
  const h = harness({ initial: { kind: "list", doc: await list({ sequence: 1 }) }, maxAge: 60 });
  assert.equal((await h.check(B.r)).ok, true);
  h.f.st.next = { kind: "none" };
  h.clock.ms += 61_000;
  const r = await h.check(B.r);
  assert.equal(r.reasonCode, "STATUS_LIST_WITHHELD");
  assert.equal(r.ok, false);
  ok("接受過清單後來源改說「沒有清單」→ STATUS_LIST_WITHHELD（不當成沒有撤銷），寫入拒絕");
}

// ───────────────────────── G. 清單過期 ─────────────────────────
{
  const h = harness({ initial: { kind: "list", doc: await list({ sequence: 1, validUntil: T0 + 2 * DAY }) }, maxAge: 900 });
  assert.equal((await h.check(B.r)).ok, true);
  h.clock.ms = (T0 + 2 * DAY) * 1000; // 恰好到期（快取仍在新鮮度內）
  const r = await h.check(B.r);
  assert.equal(r.reasonCode, "STATUS_LIST_EXPIRED", "快取中的清單到期也要擋");
  assert.equal(r.ok, false);
  // 來源還是只有那份過期清單 → 重新取也一樣被拒。
  h.clock.ms += 1000;
  assert.equal((await h.check(B.r)).reasonCode, "STATUS_LIST_EXPIRED");
  ok("清單過期（含快取中的）→ STATUS_LIST_EXPIRED，寫入拒絕");
}

// ───────────────────────── H. 快取與新鮮度上限 ─────────────────────────
{
  const h = harness({ initial: { kind: "list", doc: await list({ sequence: 1 }) }, maxAge: 60 });
  await h.check(B.r);
  assert.equal(h.f.st.calls, 1);
  h.clock.ms += 30_000;
  const c = await h.check(B.r);
  assert.equal(h.f.st.calls, 1, "60 秒內沿用快取");
  assert.equal(c.fromCache, true);
  // 簽發者發佈新清單撤銷 B：快取期內還看不到，過了新鮮度上限一定看到。
  h.f.st.next = { kind: "list", doc: await list({ sequence: 2, revoked: [B.r.nonce!] }) };
  h.clock.ms += 29_000;
  assert.equal((await h.check(B.r)).ok, true, "仍在 60 秒內：沿用快取");
  h.clock.ms += 2_000;
  const r = await h.check(B.r);
  assert.equal(h.f.st.calls, 2);
  assert.equal(r.reasonCode, "VC_REVOKED", "超過新鮮度上限 → 重新取得 → 看到撤銷");

  // 設定再大也不超過 900 秒。
  const big = harness({ initial: { kind: "list", doc: await list({ sequence: 1 }) }, maxAge: 99_999 });
  await big.check(B.r);
  big.clock.ms += MAX_STATUS_CACHE_MAX_AGE_SEC * 1000;
  await big.check(B.r);
  assert.equal(big.f.st.calls, 1, "900 秒整：仍在上限內");
  big.clock.ms += 1000;
  await big.check(B.r);
  assert.equal(big.f.st.calls, 2, "超過 900 秒：一定重新取得");

  // maxAge 0：每次都取。時鐘倒退也不沿用快取。
  const zero = harness({ initial: { kind: "none" }, maxAge: 0 });
  await zero.check(B.r);
  await zero.check(B.r);
  assert.equal(zero.f.st.calls, 2);
  const back = harness({ initial: { kind: "none" }, maxAge: 60 });
  await back.check(B.r);
  back.clock.ms -= 10_000;
  await back.check(B.r);
  assert.equal(back.f.st.calls, 2, "時鐘倒退 → 不信任快取");
  ok("快取：新鮮度上限內沿用、超過即重取；上限硬封頂 900 秒；0＝不快取；時鐘倒退不沿用（注入時鐘）");
}

// ───────────────────────── I. 狀態來源不可達 ─────────────────────────
{
  const down: StatusFetch = { kind: "unavailable", reason: "test" };
  const h = harness({ initial: down });
  const w = await h.check(B.r, "write");
  assert.equal(w.ok, false, "寫入：fail-closed");
  assert.equal(w.reasonCode, "STATUS_UNAVAILABLE");
  const r = await h.check(B.r, "read");
  assert.equal(r.ok, true, "唯讀預設 allow");
  assert.equal(r.status, "unknown");
  const hd = harness({ initial: down, readPolicy: "deny" });
  assert.equal((await hd.check(B.r, "read")).ok, false, "VC_STATUS_READ_POLICY=deny → 唯讀也拒");

  // 已知撤銷 + 來源掛掉 → 仍回 revoked（不是 unknown）。
  const store = memoryStatusStateStore();
  const h1 = harness({ initial: { kind: "list", doc: await list({ sequence: 1, revoked: [A.r.nonce!] }) }, store });
  await h1.check(A.r);
  const h2 = harness({ initial: down, store });
  const rr = await h2.check(A.r, "read");
  assert.equal(rr.status, "revoked");
  assert.equal(rr.ok, false);
  assert.equal(S.readPolicyFromEnv({ VC_STATUS_READ_POLICY: "bogus" } as any), "deny", "無法辨識的設定 → deny");
  assert.equal(S.readPolicyFromEnv({} as any), "allow");
  // 自訂來源丟例外 → 視為未知（不讓例外穿出去）。
  const boom = createVcStatusChecker({ source: { describe: "boom", fetch: async () => { throw new Error("boom"); } }, store: memoryStatusStateStore(), now: () => (T0 + DAY) * 1000 });
  const rb = await boom.check(B.r, { action: "write", verifyingContract: MGR });
  assert.equal(rb.ok, false);
  assert.equal(rb.reasonCode, "STATUS_UNAVAILABLE");
  ok("來源不可達：寫入拒絕、唯讀依設定（預設 allow 並標 unknown、deny 拒絕）；已知撤銷照樣拒");
}

// ───────────────────────── J. 檔案狀態（跨 process 共用）─────────────────────────
{
  const file = path.join(TMP, "j-state.json");
  const hA = harness({ initial: { kind: "list", doc: await list({ sequence: 3, revoked: [A.r.nonce!] }) }, store: fileStatusStateStore(file) });
  assert.equal((await hA.check(A.r)).reasonCode, "VC_REVOKED");
  // 另一個 process（新的檢查器、空快取、來源掛掉）也知道 A 被撤銷、也知道最高 sequence。
  const hB = harness({ initial: { kind: "list", doc: await list({ sequence: 2 }) }, store: fileStatusStateStore(file) });
  assert.equal((await hB.check(A.r)).reasonCode, "VC_REVOKED");
  assert.equal((await hB.check(B.r)).reasonCode, "STATUS_LIST_REPLAYED", "另一個 process 也拒絕較舊的清單");
  fs.writeFileSync(file, "{ not json", "utf8");
  const hC = harness({ initial: { kind: "none" }, store: fileStatusStateStore(file) });
  const r = await hC.check(B.r);
  assert.equal(r.reasonCode, "STATUS_STATE_UNREADABLE");
  assert.equal(r.ok, false);
  ok("檔案狀態跨 process 共用（撤銷與最高 sequence）；狀態檔壞掉 → STATUS_STATE_UNREADABLE，寫入拒絕");
}

// ───────────────────────── K. 來源實作 ─────────────────────────
{
  const dir = path.join(TMP, "k-dir");
  const ds = dirStatusSource(dir);
  assert.equal((await ds.fetch(user.address)).kind, "none", "目錄不存在 → none");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${user.address.toLowerCase()}.json`), "garbage");
  assert.equal((await ds.fetch(user.address)).kind, "unavailable", "壞 JSON → unavailable");

  const routes = new Map<string, { status: number; body: string }>();
  const fetchImpl = async (url: string) => {
    const r = routes.get(url);
    if (r === undefined) throw new TypeError("fetch failed");
    if (r.status === -1) return new Promise<never>(() => {}); // 永遠不回
    return { status: r.status, text: async () => r.body };
  };
  const base = "https://status.example";
  const hs = httpStatusSource(base, { fetchImpl: fetchImpl as any, timeoutMs: 20 });
  assert.equal((await hs.fetch(user.address)).kind, "unavailable", "連不到 → unavailable");
  routes.set(`${base}/index.json`, { status: 404, body: "" });
  routes.set(`${base}/${user.address.toLowerCase()}.json`, { status: 404, body: "" });
  assert.equal((await hs.fetch(user.address)).kind, "unavailable", "沒有目錄標記 → 404 不能當成「沒有清單」");
  routes.set(`${base}/index.json`, { status: 200, body: JSON.stringify({ type: STATUS_DIRECTORY_TYPE }) });
  assert.equal((await hs.fetch(user.address)).kind, "none", "有目錄標記後 404 → none");
  routes.set(`${base}/${user.address.toLowerCase()}.json`, { status: 500, body: "" });
  assert.equal((await hs.fetch(user.address)).kind, "unavailable", "5xx → unavailable");
  routes.set(`${base}/${user.address.toLowerCase()}.json`, { status: -1, body: "" });
  const t = await hs.fetch(user.address);
  assert.equal(t.kind, "unavailable", "逾時 → unavailable");
  const doc = await list({ sequence: 1 });
  routes.set(`${base}/${user.address.toLowerCase()}.json`, { status: 200, body: JSON.stringify(doc) });
  const got = await hs.fetch(user.address);
  assert.equal(got.kind, "list");
  ok("來源：本機目錄（不存在＝沒有清單、壞檔＝不可用）；HTTP 需目錄標記、404/5xx/逾時/斷線各自對應");
}

// ───────────────────────── L. v1 舊憑證 ─────────────────────────
{
  const h = harness({ initial: { kind: "list", doc: await list({ sequence: 1 }) } });
  assert.equal((await h.check(V1.r)).reasonCode, "STATUS_ACTIVE", "v1 照樣可讀，也經過狀態檢查");
  const h2 = harness({ initial: { kind: "list", doc: await list({ sequence: 1, revoked: [credentialJti(V1.r)!] }) } });
  assert.equal((await h2.check(V1.r)).reasonCode, "VC_REVOKED", "v1 以 digest 撤銷");
  const h3 = harness({ initial: { kind: "list", doc: await list({ sequence: 1, revokedBefore: T0 + 21 }) } });
  assert.equal((await h3.check(V1.r)).reasonCode, "VC_REVOKED", "v1 也受 revokedBefore 約束");
  ok("v1（舊格式）在新規則下照樣可讀，但經過狀態檢查（digest 或 revokedBefore 可撤銷）");
}

// ───────────────────────── M. 寫入路徑（write.ts）：開倉與平倉 ─────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
async function liveVc(issuer: ethers.HDNodeWallet) {
  const t = nowSec() - 60;
  return issueAuthorizationVC({
    issuer, agentAddress: agent.address, sessionId: 3,
    caps: { ...caps, expiry: t + 60 * DAY }, issuedAt: t, verifyingContract: MGR,
  });
}
async function liveList(issuer: ethers.HDNodeWallet, o: { sequence: number; revoked?: string[]; validUntil?: number; verifyingContract?: string }) {
  const t = nowSec() - 30;
  return issueStatusList({ issuer, verifyingContract: o.verifyingContract ?? MGR, issuedAt: t, sequence: o.sequence, revoked: o.revoked, validUntil: o.validUntil });
}
function install(issuerAddr: string, doc: unknown) {
  fs.mkdirSync(process.env.VC_STATUS_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.VC_STATUS_DIR!, `${issuerAddr.toLowerCase()}.json`), JSON.stringify(doc));
}
const open = (vc: any) => openPositionForSession({ sessionId: 3, symbol: "sBTC", isLong: true, marginUsdc: 10, leverage: 2, authVc: vc });
const close = (vc: any) => closePositionForSession({ sessionId: 3, positionId: 1, authVc: vc });
const STATUS_PASSED = /讀取鏈上 session 失敗/; // 狀態通過後才會去讀鏈（測試的 RPC 連不到）

const u1 = ethers.Wallet.createRandom();
const revokedVc = await liveVc(u1);
const keptVc = await liveVc(u1);
const jtiOf = (vc: any) => credentialJti(verifyAuthorizationVC(vc))!;
install(u1.address, await liveList(u1, { sequence: 1, revoked: [jtiOf(revokedVc)] }));
{
  for (const [name, fn] of [["開倉", open], ["平倉", close]] as const) {
    const r: any = await fn(revokedVc);
    assert.equal(r.ok, false, name);
    assert.equal(r.reasonCode, "VC_REVOKED", `${name}：${r.error}`);
    assert.equal(r.guardStage, "vc");
    const k: any = await fn(keptVc);
    assert.equal(k.ok, false);
    assert.match(k.error, STATUS_PASSED, `${name}：未撤銷的 VC 通過狀態檢查，止於鏈上讀取（${k.error}）`);
  }
  const closeR: any = await close(revokedVc);
  assert.match(closeR.error, /closePosition\(positionId\)/, "平倉被拒時附上鏈上自行平倉的指引");
  ok("write.ts：被撤銷的 VC 開倉、平倉都被拒（VC_REVOKED，未觸及鏈）；未撤銷的 VC 照常往下走");
}
{
  // 重放：已接受 sequence 2，目錄被換回 sequence 1。
  const u2 = ethers.Wallet.createRandom();
  const vc = await liveVc(u2);
  install(u2.address, await liveList(u2, { sequence: 2 }));
  assert.match(((await open(vc)) as any).error, STATUS_PASSED);
  install(u2.address, await liveList(u2, { sequence: 1 }));
  for (const fn of [open, close]) {
    const r: any = await fn(vc);
    assert.equal(r.reasonCode, "VC_STATUS_UNVERIFIED");
    assert.match(r.error, /STATUS_LIST_REPLAYED/);
  }
  // 過期清單、簽發者不符、簽章錯（各用新的簽發者，免得被 sticky 狀態影響）。
  const u3 = ethers.Wallet.createRandom();
  const vc3 = await liveVc(u3);
  const exp = await issueStatusList({ issuer: u3, verifyingContract: MGR, issuedAt: nowSec() - 10 * DAY, validUntil: nowSec() - DAY, sequence: 1 });
  install(u3.address, exp);
  assert.match(((await open(vc3)) as any).error, /STATUS_LIST_EXPIRED/);
  const u4 = ethers.Wallet.createRandom();
  const vc4 = await liveVc(u4);
  install(u4.address, await liveList(mallory, { sequence: 1 }));
  const r4: any = await open(vc4);
  assert.equal(r4.reasonCode, "VC_STATUS_UNVERIFIED");
  assert.match(r4.error, /STATUS_LIST_WRONG_ISSUER/);
  const u5 = ethers.Wallet.createRandom();
  const vc5 = await liveVc(u5);
  const bad = await liveList(u5, { sequence: 1, revoked: [jtiOf(vc5)] });
  bad.revoked = [];
  install(u5.address, bad);
  const r5: any = await close(vc5);
  assert.equal(r5.reasonCode, "VC_STATUS_UNVERIFIED");
  assert.match(r5.error, /STATUS_LIST_BAD_SIGNATURE/);
  ok("write.ts：重放舊清單、清單過期、簽發者不符、簽章錯 → VC_STATUS_UNVERIFIED（開倉與平倉）");
}
{
  // 狀態來源不可達：寫入一律拒絕（開倉與平倉，沒有降級）。
  process.env.VC_STATUS_URL = "http://127.0.0.1:1";
  try {
    for (const fn of [open, close]) {
      const r: any = await fn(keptVc);
      assert.equal(r.reasonCode, "VC_STATUS_UNVERIFIED");
      assert.match(r.error, /STATUS_UNAVAILABLE/);
    }
  } finally {
    delete process.env.VC_STATUS_URL;
  }
  // 設定錯誤（不是 http(s)）→ 一樣是結構化的拒絕，不丟例外。
  process.env.VC_STATUS_URL = "ftp://status.invalid";
  try {
    const r: any = await open(keptVc);
    assert.equal(r.reasonCode, "VC_STATUS_UNVERIFIED");
    assert.match(r.error, /STATUS_UNAVAILABLE/);
  } finally {
    delete process.env.VC_STATUS_URL;
  }
  ok("write.ts：狀態來源不可達或設定錯誤 → 開倉、平倉都 fail-closed（VC_STATUS_UNVERIFIED）");
}

// ───────────────────────── N. MCP 寫入工具（經 write.ts）─────────────────────────
{
  const deps: any = {
    requireConfirm: false,
    elicit: { supported: () => true, ask: async () => "accept" },
    open: (a: any) => openPositionForSession({ sessionId: a.sessionId, symbol: a.asset, isLong: a.isLong, marginUsdc: a.marginUsdc, leverage: a.leverage, authVc: JSON.parse(a.authVcJson) }),
    close: (a: any) => closePositionForSession({ sessionId: a.sessionId, positionId: a.positionId, authVc: JSON.parse(a.authVcJson) }),
    readFees: async () => ({ tradingFeeBps: null, executionFeeEth: null }),
    readPosition: async () => ({ asset: null, isLong: null, marginUsdc: null, leverage: null, isOpen: null }),
    readSessionUser: async () => null,
    policyPreview: () => null,
    warn: () => {},
  };
  const h = createWriteHandlers(deps);
  const o: any = await h.openPosition({ sessionId: 3, asset: "sBTC", isLong: true, marginUsdc: 10, leverage: 2, authVcJson: JSON.stringify(revokedVc) });
  assert.equal(o.kind, "fail");
  assert.equal(o.reasonCode, "VC_REVOKED");
  const c: any = await h.closePosition({ sessionId: 3, positionId: 1, authVcJson: JSON.stringify(revokedVc) });
  assert.equal(c.reasonCode, "VC_REVOKED");
  assert.match(c.message, /closePosition\(/);
  ok("MCP open_position / close_position：被撤銷的 VC → VC_REVOKED");
}

// ───────────────────────── O. tg-bot 與 vc-gate 預檢 ─────────────────────────
{
  const rev = await S.checkCredentialStatus(verifyAuthorizationVC(revokedVc), { action: "write" });
  assert.equal(rev.reasonCode, "VC_REVOKED");
  assert.match(vcStatusProblemForBot(rev)!, /撤銷/);
  const live = await S.checkCredentialStatus(verifyAuthorizationVC(keptVc), { action: "write" });
  assert.equal(live.ok, true);
  assert.equal(vcStatusProblemForBot(live), null);
  assert.match(vcStatusProblemForBot({ ok: true, status: "unknown", reasonCode: "STATUS_UNAVAILABLE" })!, /無法確認/, "unknown 一律拒單");

  const g = await localVerifyVcWithStatus(revokedVc, agent.address, 3);
  assert.equal(g.ok, false);
  assert.match(g.reason, /撤銷/);
  const g2 = await localVerifyVcWithStatus(keptVc, agent.address, 3);
  assert.equal(g2.ok, true, g2.reason);
  const g3 = await localVerifyVcWithStatus(keptVc, agent.address, 3, async () => ({ ok: true, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message: "x" }));
  assert.equal(g3.ok, false, "下單前預檢：狀態未知也不准下單");
  ok("tg-bot 下單前檢查與 vc-gate（x402 agent／範例）：撤銷或狀態未知 → 拒單");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ vc-status.test.ts 全過（${n} 組）`);
