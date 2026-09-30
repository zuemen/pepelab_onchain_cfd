// Read client：同一區塊一致性、P1 欄位的 supported/unsupported、格式化、session 狀態。
// 完全離線（假 transport），不連鏈。
//   cd agent && npx tsx sdk/test/read.test.ts
import assert from "node:assert";
import { baseSepolia } from "viem/chains";
import { toFunctionSelector, type Abi } from "viem";

import {
  AGENT_SESSION_MANAGER_ABI,
  ASSET_IDS,
  createReadClient,
  ORACLE_ABI,
  PERPETUAL_EXCHANGE_ABI,
  ReadCallError,
  resolveAddresses,
} from "../src/index.ts";
import { mockChain, Revert } from "./mockChain.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const A = resolveAddresses(84532);
const sBTC = ASSET_IDS.sBTC;
const sETH = ASSET_IDS.sETH;
const USER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;
const LATEST = 5_000_000n;
const TS = (bn: bigint) => 1_790_000_000n + bn * 2n; // 每區塊 2 秒

/** 現行部署版（沒有 P1 getter）或 P1 版的交易所假資料。 */
function exchangeFns(p1: boolean, mode = 0) {
  const fns: Record<string, (args: readonly unknown[], bn: bigint) => unknown> = {
    maxPriceAge: () => 21_600n,
    executionFee: () => 10n ** 14n,
    getFundingRate: ([a]) => (a === sBTC ? -3n : 0n),
    maxLeverageForAsset: () => 5n,
    globalLongNotional: ([a]) => (a === sBTC ? 1_000n * E18 : 0n),
    globalShortNotional: ([a]) => (a === sBTC ? 400n * E18 : 0n),
    freeMargin: () => 1234n * E18 + 5n, // 帶一個最小單位，確認格式化不失真
    getAccountHealth: () => [900n * E18, 50n * E18, true],
    getUserPositions: () => [7n, 8n],
    getPosition: ([id]) => ({
      id,
      owner: USER,
      asset: sBTC,
      isLong: true,
      entryPrice: 50_000n * E18,
      margin: 100n * E18,
      leverage: 3n,
      openedAt: 1_700_000_000n,
      closedAt: id === 8n ? 1_700_001_000n : 0n,
      realizedPnL: id === 8n ? -12n * E18 : 0n,
      isOpen: id === 7n,
      copiedFrom: "0x0000000000000000000000000000000000000000",
      entryFundingIndex: 0n,
    }),
    getUnrealizedPnL: () => {
      throw new Revert(); // 例如價格過期時 revert → 應回 null，不讓整份帳戶讀取失敗
    },
    pendingFunding: () => -1n * E18,
  };
  if (p1) {
    fns.assetMode = ([a]) => (a === sBTC ? mode : 0);
    fns.paused = () => false;
    fns.longOpenSize = ([a]) => (a === sBTC ? 2n * E18 : 0n); // 2 BTC
    fns.shortOpenSize = () => 0n;
    fns.maxLongOI = () => 500_000n * E18;
    fns.maxShortOI = () => 0n;
  }
  return fns;
}

function contracts(p1: boolean, mode = 0, priceUpdatedAt?: (bn: bigint) => bigint) {
  return {
    [A.perpetualExchange.toLowerCase()]: { abi: PERPETUAL_EXCHANGE_ABI as Abi, fns: exchangeFns(p1, mode) },
    [A.oracle.toLowerCase()]: {
      abi: ORACLE_ABI as Abi,
      fns: {
        getPrice: ([a]: readonly unknown[], bn: bigint) => [
          a === sBTC ? 60_000n * 10n ** 8n : 3_000n * 10n ** 8n,
          priceUpdatedAt ? priceUpdatedAt(bn) : TS(bn) - 100n,
        ],
      },
    },
    [A.sessionManager!.toLowerCase()]: {
      abi: AGENT_SESSION_MANAGER_ABI as Abi,
      fns: {
        sessions: ([id]: readonly unknown[], bn: bigint) =>
          id === 0n
            ? [USER, AGENT, 50n * E18, 1000n * E18, 150n * E18, 3n, TS(bn) + 3600n, false]
            : id === 1n
              ? [USER, AGENT, 50n * E18, 1000n * E18, 0n, 3n, TS(bn) - 1n, false] // 已過期（以區塊時間）
              : ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n, 0n, 0n, 0n, 0n, false],
        allowedAssets: ([id]: readonly unknown[]) => (id === 0n ? [sBTC, sETH] : []),
      },
    },
  };
}

// 1) 現行部署版（Multicall 路徑）：P1 欄位 supported=false、所有 eth_call 同一區塊
{
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(false) });
  const read = createReadClient({ chainId: 84532, publicClient: m.client, latestBlockLag: 3 });
  const mk = await read.getMarket("sBTC");
  assert.equal(mk.blockNumber, LATEST - 3n, "latestBlockLag=3 → latest − 3");
  assert.equal(mk.blockTimestamp, TS(LATEST - 3n));
  assert.ok(m.callBlockTags.length > 0);
  assert.ok(m.callBlockTags.every((t) => BigInt(t) === LATEST - 3n), "每個 eth_call 都帶同一個區塊");
  assert.ok(m.methods.filter((x) => x === "eth_call").length <= 2, "走 multicall，不是逐筆");
  assert.deepEqual(mk.mode, { supported: false, value: null });
  assert.deepEqual(mk.paused, { supported: false, value: null });
  assert.equal(mk.openInterest.longOpenSize.supported, false);
  assert.equal(mk.openInterest.longNotional.formatted, "1000");
  assert.equal(mk.oracle.price.formatted, "60000");
  assert.equal(mk.oracle.freshness.ageSec, 100, "年齡以區塊時間計，不用本機時鐘");
  assert.equal(mk.oracle.freshness.fresh, true);
  assert.equal(mk.openLikelyAllowed, true, "不支援 P1 時只看新鮮度");
  assert.equal(mk.executionFee.formatted, "0.0001");
  assert.equal(mk.fundingRateBps, -3n);
  ok("現行部署版：P1 欄位回 supported=false、全部讀取在同一區塊（multicall）");
}

// 2) P1 版（逐筆 eth_call 路徑）：ReduceOnly、OI 數量 × 價格、固定 blockNumber
{
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(true, 1) });
  const read = createReadClient({ chainId: 84532, publicClient: m.client, multicall: false });
  const pinned = 4_900_000n;
  const [btc, eth] = await read.getMarkets(["sBTC", "sETH"], { blockNumber: pinned });
  assert.ok(!m.methods.includes("eth_blockNumber"), "給了 blockNumber 就不查 latest");
  assert.ok(m.callBlockTags.every((t) => BigInt(t) === pinned), "逐筆路徑也全部帶同一個區塊");
  assert.ok(m.methods.filter((x) => x === "eth_call").length > 10, "確實是逐筆");
  assert.deepEqual(btc!.mode, { supported: true, value: "ReduceOnly" });
  assert.deepEqual(btc!.paused, { supported: true, value: false });
  assert.equal(btc!.openLikelyAllowed, false, "ReduceOnly → 不能開倉");
  assert.equal(btc!.openInterest.longOpenSize.value!.formatted, "2");
  assert.equal(btc!.openInterest.longOpenValue.value!.formatted, "120000", "2 BTC × 60000");
  assert.equal(btc!.openInterest.maxLongOI.value!.formatted, "500000");
  assert.deepEqual(eth!.mode, { supported: true, value: "Active" });
  assert.equal(eth!.blockNumber, btc!.blockNumber);
  ok("P1 版：assetMode/paused/OI 讀取正確，逐筆路徑同樣鎖定區塊");
}

// 3) Halted 與過期價格
{
  const stale = (bn: bigint) => TS(bn) - 21_601n;
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(true, 2, stale) });
  const read = createReadClient({ chainId: 84532, publicClient: m.client });
  const mk = await read.getMarket(ASSET_IDS.sBTC);
  assert.equal(mk.asset, "sBTC", "bytes32 也能反查代號");
  assert.equal(mk.mode.value, "Halted");
  assert.equal(mk.oracle.freshness.fresh, false);
  assert.equal(mk.oracle.freshness.maxPriceAgeSec, 21_600);
  assert.equal(mk.openLikelyAllowed, false);
  ok("Halted 與過期價格（maxPriceAge 判準）");
}

// 4) 帳戶：保證金精確格式化、PnL revert → null、預設只列未平倉
{
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(false) });
  const read = createReadClient({ chainId: 84532, publicClient: m.client });
  const acct = await read.getAccount(USER.toUpperCase().replace("0X", "0x"));
  assert.equal(acct.freeMargin.raw, 1234n * E18 + 5n);
  assert.equal(acct.freeMargin.formatted, "1234.000000000000000005", "不經浮點數");
  assert.deepEqual(acct.positionIds, [7n, 8n]);
  assert.equal(acct.positions.length, 1, "預設只列未平倉");
  const p = acct.positions[0]!;
  assert.equal(p.positionId, 7n);
  assert.equal(p.asset, "sBTC");
  assert.equal(p.unrealizedPnL, null, "getUnrealizedPnL revert → null");
  assert.equal(p.pendingFunding!.formatted, "-1");
  assert.equal(p.copiedFrom, null);
  assert.equal(acct.health!.healthy, true);
  assert.ok(m.callBlockTags.every((t) => BigInt(t) === acct.blockNumber));
  const all = await read.getAccount(USER, { includeClosed: true, blockNumber: acct.blockNumber });
  assert.equal(all.positions.length, 2);
  assert.equal(all.positions[1]!.realizedPnL.formatted, "-12");
  assert.equal(all.positions[1]!.unrealizedPnL, null, "已平倉不讀 PnL");
  ok("帳戶：保證金精確、PnL revert 不拖垮整份讀取、includeClosed");
}

// 5) Session：資產白名單、空白名單 = 不限、以區塊時間判斷過期、不存在
{
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(false) });
  const read = createReadClient({ chainId: 84532, publicClient: m.client });
  const s0 = await read.getSession(0);
  assert.equal(s0.exists, true);
  assert.equal(s0.active, true);
  assert.equal(s0.unrestricted, false);
  assert.deepEqual(s0.allowedAssets.map((a) => a.asset), ["sBTC", "sETH"]);
  assert.equal(s0.remainingBudget.formatted, "850");
  const s1 = await read.getSession(1n);
  assert.equal(s1.expired, true, "expiry < 區塊時間");
  assert.equal(s1.active, false);
  assert.equal(s1.unrestricted, true, "空陣列 = 不限資產（要讓整合方看得見）");
  const s9 = await read.getSession(9);
  assert.equal(s9.exists, false);
  assert.equal(s9.active, false);
  ok("Session：白名單／不限資產／過期（區塊時間）／不存在");
}

// 6) RPC 層級錯誤不能被當成「合約不支援」
{
  const m = mockChain({
    chain: baseSepolia,
    latestBlock: LATEST,
    blockTimestamp: TS,
    contracts: contracts(false),
    failRpc: (method) => method === "eth_call",
  });
  const read = createReadClient({ chainId: 84532, publicClient: m.client, multicall: false });
  await assert.rejects(read.getMarket("sBTC"), (e: Error) => !(e instanceof ReadCallError) && /mock RPC failure|RPC/.test(e.message));
  const read2 = createReadClient({ chainId: 84532, publicClient: m.client });
  await assert.rejects(read2.getMarket("sBTC"));
  ok("RPC 錯誤直接丟出（兩條路徑），不偽裝成 supported=false");
}

// 7) 必要欄位 revert → ReadCallError；未知 assetMode → 丟錯
{
  const c = contracts(true, 7);
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: c });
  const read = createReadClient({ chainId: 84532, publicClient: m.client });
  await assert.rejects(read.getMarket("sBTC"), /未知的 assetMode 7/);
  delete c[A.perpetualExchange.toLowerCase()]!.fns.maxPriceAge;
  await assert.rejects(read.getMarket("sETH"), (e: Error) => e instanceof ReadCallError && (e as ReadCallError).functionName === "maxPriceAge");
  ok("必要欄位讀不到 → ReadCallError；未知列舉值不猜");
}

// 8) 設定錯誤
{
  const m = mockChain({ chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: {} });
  assert.throws(() => createReadClient({ chainId: 11155111, publicClient: m.client }), /不一致/);
  assert.throws(() => createReadClient({ chainId: 84532 }), /publicClient 或 rpcUrl/);
  assert.throws(() => createReadClient({ chainId: 1, rpcUrl: "http://127.0.0.1:1" }), /CHAIN_MAP/);
  const read = createReadClient({ chainId: 84532, publicClient: m.client });
  await assert.rejects(read.getMarket("sDOGE"), /未知資產/);
  ok("設定錯誤：chain 不一致、沒有 RPC、未知鏈、未知資產");
}

// 9) 審查 M3：multicall 整批被 RPC 拒絕 → 丟出，不能變成 null／supported:false
{
  const UPNL = toFunctionSelector("function getUnrealizedPnL(uint256)").slice(2);
  const PAUSED = toFunctionSelector("function paused()").slice(2);
  const hits = (p: unknown[], sel: string) => String((p[0] as { data?: string })?.data ?? "").includes(sel);
  for (const err of [
    { code: -32000, message: "header not found" },
    { code: -32603, message: "header not found" },
  ]) {
    const m = mockChain({
      chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(false),
      failRpc: (method, p) => (method === "eth_call" && hits(p, UPNL) ? err : false),
    });
    const read = createReadClient({ chainId: 84532, publicClient: m.client });
    await assert.rejects(read.getAccount(USER), `multicall 第二批（uPnL）${err.code} → 丟出，不回 null`);
    const m2 = mockChain({
      chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(true),
      failRpc: (method, p) => (method === "eth_call" && hits(p, PAUSED) ? err : false),
    });
    await assert.rejects(createReadClient({ chainId: 84532, publicClient: m2.client }).getMarket("sBTC"), `multicall ${err.code} → 丟出`);
  }
  ok("M3：multicall 整批 RPC 失敗（-32000／-32603）→ 丟出，不偽裝成 revert");
}

// 10) 審查 M3：逐筆路徑 -32603 沒有 revert data 也沒寫 execution reverted → 丟出；有寫 → 算 revert
{
  const PAUSED = toFunctionSelector("function paused()").slice(2);
  const hits = (p: unknown[]) => String((p[0] as { data?: string })?.data ?? "").startsWith("0x" + PAUSED);
  const mkRead = (err: { code: number; message: string; data?: string }) =>
    createReadClient({
      chainId: 84532,
      multicall: false,
      publicClient: mockChain({
        chain: baseSepolia, latestBlock: LATEST, blockTimestamp: TS, contracts: contracts(true),
        failRpc: (method, p) => (method === "eth_call" && hits(p) ? err : false),
      }).client,
    });
  await assert.rejects(mkRead({ code: -32603, message: "header not found" }).getMarket("sBTC"), "-32603 無 data → RPC 錯誤");
  await assert.rejects(mkRead({ code: -32000, message: "header not found" }).getMarket("sBTC"));
  const r1 = await mkRead({ code: -32603, message: "execution reverted" }).getMarket("sBTC");
  assert.deepEqual(r1.paused, { supported: false, value: null }, "-32603 但明確 execution reverted → 算 revert");
  const r2 = await mkRead({ code: -32000, message: "execution reverted" }).getMarket("sBTC");
  assert.deepEqual(r2.paused, { supported: false, value: null }, "geth -32000 execution reverted → 算 revert");
  const r3 = await mkRead({ code: 3, message: "execution reverted", data: "0x" }).getMarket("sBTC");
  assert.deepEqual(r3.paused, { supported: false, value: null }, "code 3 → revert");
  ok("M3：-32603 只有在帶 revert data 或寫明 execution reverted 時才算 revert");
}

console.log(`\n✅ sdk read.test.ts 全過（${n} 項）`);
