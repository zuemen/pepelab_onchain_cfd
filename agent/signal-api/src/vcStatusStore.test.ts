// ADR-016 驗證端狀態的 Upstash 共享儲存（signal-api/src/vcStatusStore.ts，ADR-021）測試。
//   cd agent && npx tsx signal-api/src/vcStatusStore.test.ts
//
// 完全離線：假 Upstash（signal-api/src/testing/fakeUpstash.ts，compare-and-set 腳本語意與 Lua 逐行相同）、
// 本機狀態清單目錄、隨機測試金鑰。不連網、不送交易。
//
// 要證明的（多個 Vercel 實例＝多個 store／檢查器物件共用同一個 KV）：
//   • 合併規則與檔案版相同：高水位只升不降（REPLAYED）、同號異文（EQUIVOCATION）、撤銷聯集＋revokedBefore 取最大（sticky）。
//   • 並行：兩個實例讀到同一個舊狀態後各自寫入——後寫者一定以先寫者的狀態重新合併；較舊的清單變成 REPLAYED，
//     不會蓋掉較新的狀態；同一份清單只寫一次；競爭不斷時 fail-closed（LOCK_FAILED），不會寫入未合併的狀態。
//   • 冷實例：空快取、來源送舊清單 → 拒絕；已知撤銷（別的實例看過的）照樣拒絕，即使來源掛掉。
//   • 故障一律 fail-closed：KV 連不上、狀態壞掉、版本號與狀態缺一、寫入失敗、沒有 Upstash 設定。
//   • 注入：有 Upstash 就自動注入（signal-api 的預設檢查器改用共享儲存），VC_STATUS_STATE_STORE=file 可關閉。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-vcstatus-kv-"));
const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const upstash = await startFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = upstash.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
process.env.SESSION_MANAGER_ADDRESS = MGR;
process.env.VC_STATUS_DIR = path.join(TMP, "status");
process.env.VC_STATUS_STATE_PATH = path.join(TMP, "status-state.json");
process.env.VC_STATUS_CACHE_MAX_AGE_SEC = "0";
for (const k of ["VC_STATUS_URL", "VC_STATUS_READ_POLICY", "VC_STATUS_STATE_STORE"]) delete process.env[k];

const S = await import("@pepelab/shared");
const {
  upstashVcStatusStateStore, upstashRestCommand, installVcStatusStateStore, resolveVcStatusStateStoreMode,
  VC_STATUS_KV_PREFIX, DEFAULT_CAS_ATTEMPTS,
} = await import("./vcStatusStore.ts");
type UpstashCommand = import("./vcStatusStore.ts").UpstashCommand;
type VerifiedStatusList = import("@pepelab/shared").VerifiedStatusList;
type StatusFetch = import("@pepelab/shared").StatusFetch;

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const NOW = Math.floor(Date.now() / 1000);
const ISSUER = ethers.getAddress("0x" + "1a".repeat(20));
const jti = (c: string) => "0x" + c.repeat(64);
const verKeyOf = (k: string) => `${VC_STATUS_KV_PREFIX}ver:${k}`;
const stateKeyOf = (k: string) => `${VC_STATUS_KV_PREFIX}state:${k}`;
let keySeq = 0;
/** 每個段落一個獨立的 (manager, issuer) 鍵，段落之間互不干擾。 */
const freshKey = () => S.stateKey(ethers.getAddress("0x" + (++keySeq).toString(16).padStart(40, "0")), ISSUER);

/** 只測儲存時用的清單（儲存本身不驗簽；digest 只用來分辨內容）。 */
const L = (sequence: number, o: { revoked?: string[]; revokedBefore?: number; digest?: string } = {}): VerifiedStatusList => ({
  issuer: ISSUER,
  sequence,
  issuedAt: NOW,
  validUntil: NOW + 86_400,
  revokedBefore: o.revokedBefore ?? 0,
  revoked: [...(o.revoked ?? [])].sort(),
  verifyingContract: MGR,
  digest: o.digest ?? ethers.id(`list-${sequence}`),
});

/**
 * 一個「實例」的指令傳輸：真的打假 Upstash，但可以把 compare-and-set 擋在門口，
 * 讓測試決定兩個實例的讀寫交錯順序（不靠時序運氣）。
 */
function instance() {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let arrived: () => void = () => {};
  let atGate: Promise<void> = Promise.resolve();
  const command: UpstashCommand = async <T>(cmd: (string | number)[]): Promise<T> => {
    if (cmd[0] === "EVAL" && gate) {
      const g = gate;
      gate = null;
      arrived();
      await g;
    }
    return upstashRestCommand<T>(cmd);
  };
  return {
    store: upstashVcStatusStateStore({ command }),
    /** 下一次 compare-and-set 先停在門口；回傳「已經停在門口」的 promise。 */
    holdNextCas(): Promise<void> {
      gate = new Promise<void>((r) => (open = r));
      atGate = new Promise<void>((r) => (arrived = r));
      return atGate;
    },
    release: () => open(),
  };
}

// ───────────────────────── A. 合併規則（單一實例）─────────────────────────
{
  const k = freshKey();
  const s = upstashVcStatusStateStore();
  assert.equal(await s.get(k), null, "沒有紀錄 → null");

  const a1 = await s.accept(k, L(1, { revoked: [jti("a")] }), NOW);
  assert.equal(a1.ok, true);
  assert.equal(upstash.strings.get(verKeyOf(k)), "1");
  const g1 = await s.get(k);
  assert.equal(g1?.sequence, 1);
  assert.deepEqual(g1?.revoked, [jti("a")]);

  const same = await s.accept(k, L(1, { revoked: [jti("a")] }), NOW + 5);
  assert.equal(same.ok, true, "同一份清單 → 接受");
  assert.equal(upstash.strings.get(verKeyOf(k)), "1", "同一份清單不寫入（版本號不變）");

  const eq = await s.accept(k, L(1, { digest: ethers.id("other") }), NOW);
  assert.equal(eq.ok, false);
  assert.equal((eq as { reasonCode: string }).reasonCode, "STATUS_LIST_EQUIVOCATION");

  // 新清單漏掉 a（攻擊者或主機改送缺項清單）：a 仍是撤銷（sticky），revokedBefore 取最大。
  assert.equal((await s.accept(k, L(3, { revokedBefore: NOW - 100 }), NOW)).ok, true);
  assert.equal((await s.accept(k, L(4, { revoked: [jti("b")], revokedBefore: NOW - 500 }), NOW)).ok, true);
  const g4 = await s.get(k);
  assert.equal(g4?.sequence, 4);
  assert.deepEqual(g4?.revoked, [jti("a"), jti("b")]);
  assert.equal(g4?.revokedBefore, NOW - 100, "revokedBefore 只取最大值");
  assert.equal(upstash.strings.get(verKeyOf(k)), "3");

  const old = await s.accept(k, L(2), NOW);
  assert.equal(old.ok, false);
  assert.equal((old as { reasonCode: string }).reasonCode, "STATUS_LIST_REPLAYED", "較舊的清單 → REPLAYED");
  assert.equal((await s.get(k))?.sequence, 4, "高水位不降");
  ok("合併規則與檔案版相同：同一份不重寫、同號異文、較舊被拒、撤銷聯集、revokedBefore 取最大");
}

// ───────────────────────── B. 並行：兩個實例交錯寫入 ─────────────────────────
{
  // B1. 過時的寫入者：I1 讀到 seq 4 後被擋住；I2 先寫入 seq 6（撤銷 y）；I1 放行 → compare-and-set 失敗 →
  //     重讀 seq 6 → 自己的 seq 5 變成 REPLAYED。最終狀態是 seq 6，不會被 seq 5 蓋掉。
  const k = freshKey();
  await upstashVcStatusStateStore().accept(k, L(4, { revoked: [jti("w")] }), NOW);
  const i1 = instance();
  const i2 = instance();
  const parked = i1.holdNextCas();
  const p1 = i1.store.accept(k, L(5, { revoked: [jti("w"), jti("x")] }), NOW);
  await parked;
  const r2 = await i2.store.accept(k, L(6, { revoked: [jti("w"), jti("y")] }), NOW);
  assert.equal(r2.ok, true);
  i1.release();
  const r1 = await p1;
  assert.equal(r1.ok, false);
  assert.equal((r1 as { reasonCode: string }).reasonCode, "STATUS_LIST_REPLAYED", "過時寫入者重讀後被拒");
  const st = await upstashVcStatusStateStore().get(k);
  assert.equal(st?.sequence, 6);
  assert.deepEqual(st?.revoked, [jti("w"), jti("y")]);
  ok("並行（過時寫入者）：compare-and-set 失敗 → 重讀 → 較舊清單 REPLAYED，不蓋掉較新的狀態");
}
{
  // B2. 較新的寫入者被搶先：I1（seq 6，清單漏了 w）停在門口；I2 寫入 seq 5（w、x）；I1 放行 → 重讀 →
  //     以 seq 5 的狀態重新合併：seq 6、撤銷 = {w, x, y}（不會因為 I1 讀到的是 seq 4 就漏掉 x）。
  const k = freshKey();
  await upstashVcStatusStateStore().accept(k, L(4, { revoked: [jti("w")] }), NOW);
  const i1 = instance();
  const i2 = instance();
  const parked = i1.holdNextCas();
  const p1 = i1.store.accept(k, L(6, { revoked: [jti("y")] }), NOW);
  await parked;
  assert.equal((await i2.store.accept(k, L(5, { revoked: [jti("w"), jti("x")] }), NOW)).ok, true);
  i1.release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  const st = await upstashVcStatusStateStore().get(k);
  assert.equal(st?.sequence, 6);
  assert.deepEqual(st?.revoked, [jti("w"), jti("x"), jti("y")], "後寫者合併了先寫者的撤銷（sticky 跨實例成立）");
  assert.equal(upstash.strings.get(verKeyOf(k)), "3", "seq 4 → 5 → 6，三次寫入");
  ok("並行（後寫者）：以先寫者的狀態重新合併，撤銷聯集不遺失");
}
{
  // B3. 同時接受同一份清單：一個寫入、另一個重讀後發現相同 → 都成功，只寫一次。
  //     同號異文的競爭：先寫者贏，後寫者重讀後 EQUIVOCATION。
  const k = freshKey();
  const i1 = instance();
  const i2 = instance();
  const parked = i1.holdNextCas();
  const p1 = i1.store.accept(k, L(1, { revoked: [jti("a")] }), NOW);
  await parked;
  assert.equal((await i2.store.accept(k, L(1, { revoked: [jti("a")] }), NOW)).ok, true);
  i1.release();
  assert.equal((await p1).ok, true);
  assert.equal(upstash.strings.get(verKeyOf(k)), "1", "同一份清單只寫一次");

  const k2 = freshKey();
  const i3 = instance();
  const parked3 = i3.holdNextCas();
  const p3 = i3.store.accept(k2, L(1, { digest: ethers.id("d1") }), NOW);
  await parked3;
  assert.equal((await upstashVcStatusStateStore().accept(k2, L(1, { digest: ethers.id("d2") }), NOW)).ok, true);
  i3.release();
  const r3 = await p3;
  assert.equal((r3 as { reasonCode: string }).reasonCode, "STATUS_LIST_EQUIVOCATION");
  assert.equal((await upstashVcStatusStateStore().get(k2))?.digest, ethers.id("d2"));
  ok("並行（同一份清單）只寫一次；同號異文的競爭 → 後寫者 EQUIVOCATION");
}
{
  // B4. 競爭不斷（每次 compare-and-set 前都有人先寫）：用盡次數 → LOCK_FAILED，狀態不被未合併的內容覆蓋。
  const k = freshKey();
  await upstashVcStatusStateStore().accept(k, L(1, { revoked: [jti("a")] }), NOW);
  let bumps = 0;
  const hostile: UpstashCommand = async <T>(cmd: (string | number)[]): Promise<T> => {
    if (cmd[0] === "EVAL") {
      bumps++;
      upstash.strings.set(verKeyOf(k), String(Number(upstash.strings.get(verKeyOf(k))) + 1));
    }
    return upstashRestCommand<T>(cmd);
  };
  const r = await upstashVcStatusStateStore({ command: hostile, maxAttempts: 3 }).accept(k, L(2), NOW);
  assert.equal(r.ok, false);
  assert.equal((r as { reasonCode: string }).reasonCode, "STATUS_STATE_LOCK_FAILED");
  assert.equal(bumps, 3, "嘗試次數上限");
  assert.equal((await upstashVcStatusStateStore().get(k))?.sequence, 1, "沒有寫入");
  assert.ok(DEFAULT_CAS_ATTEMPTS >= 3);
  ok("競爭不斷 → compare-and-set 用盡次數 → STATUS_STATE_LOCK_FAILED（fail-closed），不寫入");
}

// ───────────────────────── C. 故障一律 fail-closed ─────────────────────────
{
  const k = freshKey();
  const s = upstashVcStatusStateStore();
  await s.accept(k, L(1), NOW);

  upstash.failNext("MGET");
  await assert.rejects(Promise.resolve(s.get(k)), "KV 連不上 → get reject（檢查器視為 STATUS_STATE_UNREADABLE）");
  upstash.failNext("MGET");
  assert.equal(((await s.accept(k, L(2), NOW)) as { reasonCode: string }).reasonCode, "STATUS_STATE_UNREADABLE");

  upstash.failNext("EVAL");
  assert.equal(((await s.accept(k, L(2), NOW)) as { reasonCode: string }).reasonCode, "STATUS_STATE_WRITE_FAILED");

  upstash.strings.set(stateKeyOf(k), "{ not json");
  await assert.rejects(Promise.resolve(s.get(k)), "狀態壞掉 → reject");
  assert.equal(((await s.accept(k, L(3), NOW)) as { reasonCode: string }).reasonCode, "STATUS_STATE_UNREADABLE");
  upstash.strings.set(stateKeyOf(k), JSON.stringify({ sequence: "1", digest: 1, revokedBefore: 0, revoked: [] }));
  await assert.rejects(Promise.resolve(s.get(k)), "格式不符 → reject");

  const k2 = freshKey();
  upstash.strings.set(verKeyOf(k2), "1");
  await assert.rejects(Promise.resolve(s.get(k2)), "版本號在、狀態不見 → 不當成「沒有紀錄」");
  const k3 = freshKey();
  upstash.strings.set(stateKeyOf(k3), JSON.stringify({ sequence: 9, digest: "0x", validUntil: 0, revokedBefore: 0, revoked: [], acceptedAt: 0 }));
  await assert.rejects(Promise.resolve(s.get(k3)), "狀態在、版本號不見 → 不一致");

  // 沒有 Upstash 設定（VC_STATUS_STATE_STORE=upstash 卻沒設 URL／TOKEN）：每次都 reject，不會悄悄退回單機。
  const saved = process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  await assert.rejects(Promise.resolve(s.get(freshKey())), /UPSTASH_REDIS_REST_URL/);
  assert.equal(((await s.accept(freshKey(), L(1), NOW)) as { reasonCode: string }).reasonCode, "STATUS_STATE_UNREADABLE");
  process.env.UPSTASH_REDIS_REST_URL = saved;
  ok("故障 fail-closed：KV 連不上、寫入失敗、狀態壞掉、版本號與狀態缺一、沒有 Upstash 設定");
}

// ───────────────────────── D. 檢查器：多個實例共用 KV（真的簽章清單）─────────────────────────
const user = ethers.Wallet.createRandom();
const agentAddr = ethers.Wallet.createRandom().address;
const caps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: NOW + 60 * 86_400 };
async function vc(issuedAt: number) {
  const v = await S.issueAuthorizationVC({ issuer: user, agentAddress: agentAddr, sessionId: 3, caps, issuedAt, verifyingContract: MGR });
  const r = S.verifyAuthorizationVC(v, { expectedVerifyingContract: MGR });
  assert.equal(r.valid, true, r.reason);
  return r;
}
const A = await vc(NOW - 600);
const B = await vc(NOW - 300);
const list = (sequence: number, revoked: string[] = []) =>
  S.issueStatusList({ issuer: user, verifyingContract: MGR, issuedAt: NOW - 60, sequence, revoked });
const source = (f: StatusFetch) => ({ describe: "fake", fetch: async () => f });
const checker = (f: StatusFetch) =>
  S.createVcStatusChecker({ source: source(f), store: upstashVcStatusStateStore(), cacheMaxAgeSec: 0 });
const write = { action: "write" as const, verifyingContract: MGR };
{
  // 實例 1 看過 seq 2（撤銷 A）。冷啟動的實例 2：來源（CDN 快取）還在送 seq 1（沒有撤銷）。
  const inst1 = checker({ kind: "list", doc: await list(2, [A.nonce!]) });
  assert.equal((await inst1.check(A, write)).reasonCode, "VC_REVOKED");
  assert.equal((await inst1.check(B, write)).reasonCode, "STATUS_ACTIVE");

  const inst2 = checker({ kind: "list", doc: await list(1) });
  const a2 = await inst2.check(A, write);
  assert.equal(a2.reasonCode, "VC_REVOKED", "已知撤銷跨實例成立（sticky）");
  assert.equal(a2.ok, false);
  const b2 = await inst2.check(B, write);
  assert.equal(b2.reasonCode, "STATUS_LIST_REPLAYED", "冷實例拒絕舊清單（高水位跨實例成立）");
  assert.equal(b2.ok, false);

  // 實例 3：來源掛掉 → A 仍是撤銷（不是 unknown）；B 是 unknown（寫入拒絕）。
  const inst3 = checker({ kind: "unavailable", reason: "down" });
  assert.equal((await inst3.check(A, write)).status, "revoked");
  assert.equal((await inst3.check(B, write)).ok, false);
  // 實例 4：來源說「沒有清單」，但共享狀態接受過 → 被扣住（withheld），不當成「沒有撤銷」。
  const inst4 = checker({ kind: "none" });
  assert.equal((await inst4.check(B, write)).reasonCode, "STATUS_LIST_WITHHELD");

  // KV 連不上 → 寫入拒絕（STATUS_STATE_UNREADABLE），唯讀依預設 allow 標 unknown。
  upstash.failNext("MGET");
  const down = await inst1.check(B, write);
  assert.equal(down.reasonCode, "STATUS_STATE_UNREADABLE");
  assert.equal(down.ok, false);
  ok("檢查器跨實例：冷實例拒絕舊清單、已知撤銷照樣拒（含來源掛掉）、被扣住偵測；KV 故障 → 寫入拒絕");
}

// ───────────────────────── E. 依環境變數注入 ─────────────────────────
{
  const env = (o: Record<string, string | undefined>) => ({ ...o }) as NodeJS.ProcessEnv;
  const creds = { UPSTASH_REDIS_REST_URL: "http://x", UPSTASH_REDIS_REST_TOKEN: "t" };
  assert.equal(resolveVcStatusStateStoreMode(env(creds)), "upstash", "有 Upstash → 預設共用");
  assert.equal(resolveVcStatusStateStoreMode(env({})), "file", "沒有 Upstash → 單機");
  assert.equal(resolveVcStatusStateStoreMode(env({ ...creds, VC_STATUS_STATE_STORE: "file" })), "file");
  assert.equal(resolveVcStatusStateStoreMode(env({ VC_STATUS_STATE_STORE: "UPSTASH" })), "upstash", "明確要求共用：沒設定也不退回單機");
  assert.equal(resolveVcStatusStateStoreMode(env({ ...creds, VC_STATUS_STATE_STORE: "redis" })), "upstash", "無法辨識 → 照預設");

  // 本機清單目錄（預設檢查器的來源）：seq 5 撤銷 B。
  const dir = process.env.VC_STATUS_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, S.STATUS_DIRECTORY_MARKER), JSON.stringify({ type: S.STATUS_DIRECTORY_TYPE }));
  fs.writeFileSync(path.join(dir, `${user.address.toLowerCase()}.json`), JSON.stringify(await list(5, [A.nonce!, B.nonce!])));

  const desc = installVcStatusStateStore();
  assert.match(desc, /upstash/);
  const r = await S.checkCredentialStatus(B, write);
  assert.equal(r.reasonCode, "VC_REVOKED");
  const k = S.stateKey(MGR, user.address);
  assert.equal(JSON.parse(upstash.strings.get(stateKeyOf(k))!).sequence, 5, "預設檢查器寫進共享儲存");
  assert.equal(fs.existsSync(process.env.VC_STATUS_STATE_PATH!), false, "注入時不寫單機狀態檔");

  // VC_STATUS_STATE_STORE=file：撤掉注入，回到單機檔案。
  process.env.VC_STATUS_STATE_STORE = "file";
  assert.match(installVcStatusStateStore(), /單機檔案/);
  assert.equal((await S.checkCredentialStatus(B, write)).reasonCode, "VC_REVOKED");
  assert.equal(fs.existsSync(process.env.VC_STATUS_STATE_PATH!), true, "回到單機檔案");
  delete process.env.VC_STATUS_STATE_STORE;
  S.setVcStatusStateStore(null);
  ok("有 Upstash 自動注入共享儲存（預設檢查器改寫 KV、不寫單機檔）；VC_STATUS_STATE_STORE=file 回到單機");
}

await upstash.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`vcStatusStore.test.ts ✓ ${n} 組全部通過`);
