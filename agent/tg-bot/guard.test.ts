// tg-bot 存取控制（白名單 / 二次確認 / 頻率限制）離線測試。
//   cd agent && npx tsx tg-bot/guard.test.ts
import assert from "node:assert";
import { parseIdList, isAuthorized, ConfirmationStore, RateLimiter, classifyVcForBot } from "./guard.ts";

// ── 白名單：chat 與 from.id 都要命中 ─────────────────────────────────────────
{
  const chats = (parseIdList("-100123,42") as { ids: Set<string> }).ids;
  const users = (parseIdList("7") as { ids: Set<string> }).ids;
  assert.equal(isAuthorized("-100123", "7", chats, users), true);
  assert.equal(isAuthorized("-100123", "8", chats, users), false, "白名單群組裡的其他成員不可下單");
  assert.equal(isAuthorized("999", "7", chats, users), false, "白名單使用者在別的 chat 也不行");
  assert.equal(isAuthorized("-100123", undefined, chats, users), false, "沒有 from（頻道貼文）一律拒絕");
  assert.ok("error" in parseIdList(""), "空白名單 → 錯誤");
  assert.ok("error" in parseIdList("12,abc"), "非整數 → 錯誤");
  console.log("✓ chat 與 from.id 都必須在白名單內");
}

// ── 二次確認：正確碼 60 秒內有效、一次性、過期/錯碼作廢 ───────────────────────
{
  let t = 0;
  const store = new ConfirmationStore<{ n: number }>(60_000, () => t);
  const p = store.create("c", "u", { n: 1 });
  assert.match(p.code, /^\d{6}$/);
  // 別人（同 chat 不同 user）拿同一個碼不能確認
  assert.deepEqual(store.consume("c", "other", p.code), { ok: false, reason: "none" });
  t = 59_000;
  const ok = store.consume("c", "u", p.code);
  assert.equal(ok.ok, true);
  assert.deepEqual(store.consume("c", "u", p.code), { ok: false, reason: "none" }, "確認碼一次性");

  const p2 = store.create("c", "u", { n: 2 });
  t += 60_001;
  assert.deepEqual(store.consume("c", "u", p2.code), { ok: false, reason: "expired" });

  const p3 = store.create("c", "u", { n: 3 });
  const wrong = p3.code === "000000" ? "000001" : "000000";
  assert.deepEqual(store.consume("c", "u", wrong), { ok: false, reason: "mismatch" });
  assert.deepEqual(store.consume("c", "u", p3.code), { ok: false, reason: "none" }, "錯碼後整筆作廢，防暴力猜碼");

  const a = store.create("c", "u", { n: 4 });
  const b = store.create("c", "u", { n: 5 });
  const r = store.consume("c", "u", b.code);
  assert.ok(r.ok && r.order.n === 5, "新指令覆蓋舊的待確認");
  void a;
  console.log("✓ 二次確認：60 秒內有效、一次性、過期/錯碼/他人皆拒絕");
}

// ── 每人頻率限制 ─────────────────────────────────────────────────────────────
{
  let t = 0;
  const rl = new RateLimiter(2, 10_000, () => t);
  assert.equal(rl.hit("u").allowed, true);
  assert.equal(rl.hit("u").allowed, true);
  const third = rl.hit("u");
  assert.equal(third.allowed, false);
  assert.equal(third.retryAfterSec, 10);
  assert.equal(rl.hit("v").allowed, true, "別人不受影響");
  t = 10_000;
  assert.equal(rl.hit("u").allowed, true, "視窗過後重置");
  console.log("✓ 每人頻率限制");
}

// ── VC 狀態：過期不致命（拒單＋提示），其他錯誤致命 ──────────────────────────
{
  assert.equal(classifyVcForBot({ valid: true, sessionId: 6 }, 6).status, "ok");
  const exp = classifyVcForBot({ valid: false, reasonCode: "VC_EXPIRED", reason: "credential expired" }, 6);
  assert.equal(exp.status, "expired");
  assert.match((exp as any).message, /重新簽發/);
  assert.equal(classifyVcForBot({ valid: false, reasonCode: "LEGACY_VC_SUNSET" }, 6).status, "expired");
  assert.equal(classifyVcForBot({ valid: false, reasonCode: "VC_BAD_SIGNATURE", reason: "sig" }, 6).status, "fatal");
  assert.equal(classifyVcForBot({ valid: true, sessionId: 7 }, 6).status, "fatal", "session 不符仍致命");
  console.log("✓ VC 過期 → 拒單並提示重新簽發（不 exit）；簽章錯誤 / session 不符 → 致命");
}

console.log("\n✅ tg-bot guard.test.ts 全過");
