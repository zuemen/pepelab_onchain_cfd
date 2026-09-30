// 交易建構：calldata 正確、只建構不簽、session 空陣列拒絕、平倉沒有任何額外限制。
// 完全離線：不連鏈、不簽、不送。
//   cd agent && npx tsx sdk/test/write.test.ts
import assert from "node:assert";
import { decodeFunctionData, getAddress, type Abi } from "viem";

import {
  AGENT_SESSION_MANAGER_ABI,
  ASSET_IDS,
  EmptyAssetListError,
  ERC20_ABI,
  PERPETUAL_EXCHANGE_ABI,
  TxBuildError,
  buildApproveMargin,
  buildClosePosition,
  buildClosePositionForSession,
  buildCreateSessionWithAssets,
  buildDepositMargin,
  buildOpenPosition,
  buildOpenPositionForSession,
  buildRevokeSession,
  buildSetSessionAssets,
  buildWithdrawMargin,
  resolveAddresses,
  type UnsignedTx,
} from "../src/index.ts";
import * as write from "../src/write.ts";

const A = resolveAddresses(84532);
const E18 = 10n ** 18n;
const AGENT = "0x2222222222222222222222222222222222222222";
const NOW = 1_790_000_000;
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const decode = (abi: readonly unknown[], tx: UnsignedTx) => decodeFunctionData({ abi: abi as Abi, data: tx.data });

// 1) 保證金：approve → deposit → withdraw
{
  const ap = buildApproveMargin(A, { amount: 100n * E18 });
  assert.equal(ap.to, A.marginToken);
  const d = decode(ERC20_ABI, ap);
  assert.equal(d.functionName, "approve");
  assert.deepEqual(d.args, [A.perpetualExchange, 100n * E18]);
  const dep = buildDepositMargin(A, { amount: 100n * E18 });
  assert.equal(dep.to, A.perpetualExchange);
  assert.equal(dep.value, 0n);
  assert.deepEqual(decode(PERPETUAL_EXCHANGE_ABI, dep).args, [100n * E18]);
  const wd = buildWithdrawMargin(A, { amount: 1n });
  assert.equal(decode(PERPETUAL_EXCHANGE_ABI, wd).functionName, "withdrawMargin");
  assert.throws(() => buildDepositMargin(A, { amount: 0n }), TxBuildError);
  assert.throws(() => buildWithdrawMargin(A, { amount: -1n }), TxBuildError);
  ok("approve／deposit／withdraw calldata 正確；0 或負數拒絕");
}

// 2) 開倉：executionFee 放在 value；request 可直接給 simulateContract
{
  const tx = buildOpenPosition(A, { asset: "sBTC", isLong: true, margin: 50n * E18, leverage: 3, executionFee: 10n ** 14n });
  assert.equal(tx.to, A.perpetualExchange);
  assert.equal(tx.value, 10n ** 14n);
  const d = decode(PERPETUAL_EXCHANGE_ABI, tx);
  assert.equal(d.functionName, "openPosition");
  assert.deepEqual(d.args, [ASSET_IDS.sBTC, true, 50n * E18, 3n]);
  assert.equal(tx.request.address, A.perpetualExchange);
  assert.equal(tx.request.functionName, "openPosition");
  assert.equal(tx.request.value, 10n ** 14n);
  assert.deepEqual(tx.request.args, d.args);
  assert.throws(() => buildOpenPosition(A, { asset: "sBTC", isLong: true, margin: 50n * E18, leverage: 0, executionFee: 0n }), /leverage/);
  assert.throws(() => buildOpenPosition(A, { asset: "sFOO", isLong: true, margin: 1n, leverage: 1, executionFee: 0n }), /未知資產/);
  ok("開倉：calldata、value=executionFee、simulateContract request 一致");
}

// 3) 平倉：沒有任何額外限制 —— 純函式、不需要 client、不看市場狀態
{
  assert.equal(buildClosePosition.length, 2, "只接收 (addresses, params)，沒有 client 參數");
  assert.equal(buildClosePositionForSession.length, 2);
  // 只需要 exchange 位址；不需要 oracle／session manager／任何市場資訊
  const tx = buildClosePosition({ perpetualExchange: A.perpetualExchange }, { positionId: 0 });
  assert.equal(decode(PERPETUAL_EXCHANGE_ABI, tx).functionName, "closePosition");
  assert.deepEqual(decode(PERPETUAL_EXCHANGE_ABI, tx).args, [0n]);
  assert.equal(tx.value, 0n);
  // 各種 id 表示法都接受（含字串、極大值）
  for (const id of [1, 1n, "42", 2n ** 256n - 1n]) buildClosePosition(A, { positionId: id });
  const s = buildClosePositionForSession(A, { sessionId: 3, positionId: "9" });
  assert.equal(s.to, A.sessionManager);
  assert.deepEqual(decode(AGENT_SESSION_MANAGER_ABI, s).args, [3n, 9n]);
  // 只有「無法編碼成 uint256」會被拒絕 —— 那不是政策，是編碼不可能
  assert.throws(() => buildClosePosition(A, { positionId: -1 }), /uint256/);
  // 原始碼層級：close builder 不得引用任何政策／市場檢查
  const src = String(write.buildClosePosition) + String(write.buildClosePositionForSession);
  for (const banned of ["assetMode", "paused", "fresh", "Halted", "ReduceOnly", "policy", "verify", "await"]) {
    assert.ok(!src.includes(banned), `close builder 不應出現「${banned}」`);
  }
  ok("平倉：無 client、無市場／政策／VC 檢查，只做 uint256 編碼");
}

// 4) createSessionWithAssets：空陣列拒絕；代號與 bytes32 都可；去重；expiry 須在未來
{
  const base = {
    agent: AGENT,
    maxMarginPerTrade: 50n * E18,
    totalMarginBudget: 1000n * E18,
    maxLeverage: 3,
    expiry: NOW + 86_400,
    nowSec: NOW,
  };
  assert.throws(() => buildCreateSessionWithAssets(A, { ...base, allowedAssets: [] }), EmptyAssetListError);
  assert.throws(
    () => buildCreateSessionWithAssets(A, { ...base, allowedAssets: undefined as unknown as string[] }),
    EmptyAssetListError,
  );
  const tx = buildCreateSessionWithAssets(A, { ...base, allowedAssets: ["sBTC", ASSET_IDS.sETH, "sBTC"] });
  assert.equal(tx.to, A.sessionManager);
  const d = decode(AGENT_SESSION_MANAGER_ABI, tx);
  assert.equal(d.functionName, "createSessionWithAssets");
  assert.deepEqual(d.args, [getAddress(AGENT), 50n * E18, 1000n * E18, 3n, BigInt(NOW + 86_400), [ASSET_IDS.sBTC, ASSET_IDS.sETH]]);
  assert.throws(() => buildCreateSessionWithAssets(A, { ...base, expiry: NOW, allowedAssets: ["sBTC"] }), /expiry/);
  assert.throws(() => buildCreateSessionWithAssets(A, { ...base, agent: "0x0000000000000000000000000000000000000000", allowedAssets: ["sBTC"] }), /零地址/);
  assert.throws(() => buildCreateSessionWithAssets(A, { ...base, maxLeverage: 0, allowedAssets: ["sBTC"] }), /maxLeverage/);
  assert.throws(() => buildCreateSessionWithAssets(A, { ...base, allowedAssets: ["0x" + "00".repeat(32)] }), /0x0/);
  assert.throws(() => buildSetSessionAssets(A, { sessionId: 1, allowedAssets: [] }), EmptyAssetListError);
  assert.deepEqual(decode(AGENT_SESSION_MANAGER_ABI, buildSetSessionAssets(A, { sessionId: 1, allowedAssets: ["sGOLD"] })).args, [1n, [ASSET_IDS.sGOLD]]);
  // 沒有 session manager 的鏈
  assert.throws(() => buildCreateSessionWithAssets({ ...A, sessionManager: null }, { ...base, allowedAssets: ["sBTC"] }), /AgentSessionManager/);
  ok("createSessionWithAssets／setSessionAssets：空陣列拒絕（合約視為全部允許）、去重、參數檢查");
}

// 5) revokeSession、openPositionForSession
{
  const r = buildRevokeSession(A, { sessionId: 7 });
  assert.equal(r.to, A.sessionManager);
  assert.deepEqual(decode(AGENT_SESSION_MANAGER_ABI, r), { functionName: "revokeSession", args: [7n] });
  const o = buildOpenPositionForSession(A, { sessionId: 7, asset: "sETH", isLong: false, margin: 10n * E18, leverage: 2, executionFee: 5n });
  const d = decode(AGENT_SESSION_MANAGER_ABI, o);
  assert.deepEqual(d.args, [7n, ASSET_IDS.sETH, false, 10n * E18, 2n, "0x0000000000000000000000000000000000000000"]);
  assert.equal(o.value, 5n);
  ok("revokeSession、openPositionForSession（copiedFrom 固定 0x0）");
}

// 6) builder 從不簽、不送：回傳物件只有 to/data/value/request
{
  const tx = buildDepositMargin(A, { amount: 1n });
  assert.deepEqual(Object.keys(tx).sort(), ["data", "request", "to", "value"]);
  assert.ok(!("signature" in tx) && !("hash" in tx));
  ok("builder 只回傳未簽交易欄位");
}

console.log(`\n✅ sdk write.test.ts 全過（${n} 項）`);
