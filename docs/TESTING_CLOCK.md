# 測試與時鐘：避免「日期炸彈」

（2026-10-01，issue #210 收尾時整理）

## 規則

測試裡**不要**把「真實時鐘」和「寫死的日期／期限」混在一起比較。典型炸彈：

| 寫法 | 何時爆 |
|---|---|
| 以 `Date.now()` 簽發 v1 VC，再用預設的「現在」驗證 | `LEGACY_VC_SUNSET_ISO`（2026-12-31）之後一律 `LEGACY_VC_SUNSET` |
| `issuedAt` 用真實時間、驗證時間寫死成某一天 | 真實時間超過寫死那天 + 300 秒，就被判成 `VC_ISSUED_IN_FUTURE`（`sdk/test/vc.test.ts` 2026-10-01 實際爆過） |

做法：把整個測試檔的「現在」定成一個常數（例如 `NOW_ISO = "2026-09-01T00:00:00Z"`），
簽發一律覆寫 `issuedAt`，`verifyAuthorizationVC`／`checkAndRecordVcNonce` 等一律明確傳 `now`。
`agent/examples/vc-v2.test.ts` 用 `verify()`／`checkNonce()` 兩個小包裝預設帶入 `now: NOW_MS`。

**不要全域 mock `Date.now`**：`agent/shared/src/fileLock.ts` 在鎖檔內容讀不到時，以
`Date.now() - mtime` 判斷鎖是否過期；`Date.now` 被平移後，檔案系統的 mtime 不會跟著動，鎖的行為就變了。

## 怎麼證明測試不依賴真實時鐘

把整個 process 的時鐘平移到指定日期（仍會前進）再跑測試。下面的 preload 只用於本機驗證，不放進 repo 測試：

```js
// fake-clock.mjs
const target = Date.parse(process.env.FAKE_NOW ?? "2027-01-02T00:00:00Z");
const RealDate = Date;
const offset = target - RealDate.now();
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = FakeDate;
```

```bash
cd agent
FAKE_NOW=2027-01-02T00:00:00Z NODE_OPTIONS="--import=file:///<絕對路徑>/fake-clock.mjs" npx tsx examples/vc-v2.test.ts
cd ../frontend
FAKE_NOW=2030-01-01T00:00:00Z NODE_OPTIONS="--import=file:///<絕對路徑>/fake-clock.mjs" npx vitest run
```

`NODE_OPTIONS` 會傳給子行程，vitest 的 worker 也吃得到（已用探針測試確認）。
`examples/concurrency.test.ts` 的「mtime 未過期不回收」在平移時鐘下**必定**失敗 —— 這正是上面說的
fileLock 現象（鎖檔 mtime 是真實時間），不是日期炸彈；在真實時鐘下這段測試與日期無關。
`signal-api/src/bundleFingerprint.test.mjs` 要用 `node --test` 直接跑，不要 `npx node`（npx 會去下載名為 node 的套件）。

## 2026-10-01 掃描結果

方法：grep（`Date.now`、`new Date()`、`LEGACY_VC_SUNSET`、`2026-`、`2027-`、寫死年份）＋ 以上述 preload 在
真實時鐘、2027-01-02、2030-01-01 三種時間下逐一跑 `agent` 的 45 支測試指令與 `frontend` 的 vitest（59 檔／746 項）。

| 檔案 | 結論 | 處理 |
|---|---|---|
| `agent/examples/vc-v2.test.ts` 第 6、6b 段 | 炸彈（2026-12-31 後失敗；平移到 2027-01-02 重現） | 已修：整檔固定「現在」 |
| `agent/sdk/test/vc.test.ts` 第 3 段 | 炸彈（2026-10-01 起已失敗，真實時鐘下重現） | 已修：固定 `issuedAt`，內容與 PR #209 相同 |
| `agent/examples/concurrency.test.ts` | 平移時鐘下失敗，但屬 fileLock mtime 現象，非炸彈 | 不改 |
| 其餘 agent 測試（policy-gate、alert、market、carbon 等寫死日期者） | 都明確傳入 `now`，或只用相對時間 | 不改 |
| frontend 全部（`tradingParams.test.ts` 用 `Date.now()` 但走無碳資料分支、與時間無關；`assetRows`／`carbon` 用固定 `now`） | 三種時間下全過 | 不改 |
