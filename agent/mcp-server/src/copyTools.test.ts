// 跟單自動同步 MCP 工具（copyTools.ts）的離線測試：不連 RPC、不簽名、不送任何交易。
//   (a) ABI 片段與 forge 產物（frontend/src/contracts/abi/*.json）完全一致
//   (b) 純邏輯：假的 CopyReads
//   (c) 協定層：真的 McpServer + Client（InMemoryTransport），三個工具都標成唯讀
//   npx tsx mcp-server/src/copyTools.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ASSET_IDS } from "@pepelab/shared";
import {
  COPY_TRACKER_TOOL_ABI,
  ERC20_TOOL_ABI,
  EXCHANGE_TOOL_ABI,
  KYC_TOOL_ABI,
  REGISTRY_TOOL_ABI,
  SIG_FOLLOW_AUTOSYNC,
  SIG_FOLLOW_PINNED,
  copySyncStatus,
  decodeRevert,
  effectiveLeverage,
  prepareCopyFollow,
  prepareCopyTx,
  registerCopyTools,
  type Alloc,
  type CopyReads,
} from "./copyTools.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// ─────────────── (a) ABI 與 forge 產物一致 ───────────────
{
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend", "src", "contracts", "abi");
  const same = (abi: readonly string[], contract: string) => {
    const artifact = new ethers.Interface(JSON.parse(readFileSync(join(dir, `${contract}.json`), "utf8")));
    const shape = (f: ethers.Fragment): string => {
      const ps = (xs: readonly ethers.ParamType[]) => xs.map((p) => p.format("sighash") + (p.indexed ? " indexed" : "")).join(",");
      if (f instanceof ethers.FunctionFragment) return `${f.name}(${ps(f.inputs)}) ${f.stateMutability} returns (${ps(f.outputs)})`;
      return f.type;
    };
    const theirs = new Set(artifact.fragments.map(shape));
    for (const f of new ethers.Interface(abi as unknown as string[]).fragments) {
      assert.ok(theirs.has(shape(f)), `${contract}: ${shape(f)} 與 forge 產物不符`);
    }
  };
  same(COPY_TRACKER_TOOL_ABI, "CopyTracker");
  same(REGISTRY_TOOL_ABI, "StrategyRegistry");
  same(EXCHANGE_TOOL_ABI, "PerpetualExchange");
  same(KYC_TOOL_ABI, "KYCRegistry");
  same(ERC20_TOOL_ABI, "MockUSDC");
  ok("工具用的每個函式片段（含回傳型別與 payable／view）都與 forge 產物相同");
}

// ─────────────── (b) 純邏輯 ───────────────
const TRACKER = ethers.getAddress("0x" + "7c".repeat(20));
const FOLLOWER = ethers.getAddress("0x" + "f0".repeat(20));
const TRADER = ethers.getAddress("0x" + "11".repeat(20));
const AGENT = ethers.getAddress("0x" + "ae".repeat(20));
const FEE = 10n ** 14n;
const NOW = 1_800_000_000;
const BTC = ASSET_IDS.sBTC as string;
const ETH = ASSET_IDS.sETH as string;
const IFACE = new ethers.Interface(COPY_TRACKER_TOOL_ABI as unknown as string[]);
const USDC = ethers.getAddress("0x" + "05".repeat(20));
const E18 = 10n ** 18n;

interface FakeOpts {
  supported?: boolean;
  autoSync?: boolean;
  maxLeverage?: number;
  minSyncInterval?: number;
  tipWei?: bigint;
  cap?: bigint;
  executor?: string | null;
  gas?: bigint;
  readyAt?: number;
  latestAllocs?: Alloc[];
  latestVersion?: bigint;
  recordVersion?: bigint;
  assetMax?: Record<string, bigint>;
  // ── 跟單（prepare_copy_follow_tx）──
  missing?: string[];
  eligible?: boolean;
  allowance?: bigint;
  balance?: bigint;
  rwa?: Record<string, boolean>;
  kycVerified?: boolean | null;
  simulate?: { ok: true } | { ok: false; reason: string };
  noStrategy?: boolean;
}

function fake(o: FakeOpts = {}): CopyReads {
  const latestAllocs = o.latestAllocs ?? [
    { asset: BTC, weight: 6000n, isLong: true, leverage: 5n },
    { asset: ETH, weight: 4000n, isLong: false, leverage: 2n },
  ];
  return {
    chainId: 84532,
    tracker: TRACKER,
    supported: async () => o.supported ?? true,
    hasExecutor: async () => true,
    records: async () => [
      { trader: TRADER, versionId: o.recordVersion ?? 0n, positionIds: [1n, 2n, 3n], copiedAt: BigInt(NOW - 100), active: true, deployedAmount: 900n * 10n ** 18n },
      { trader: TRADER, versionId: 0n, positionIds: [], copiedAt: 0n, active: false, deployedAmount: 0n },
    ],
    syncConfig: async () => ({
      autoSync: o.autoSync ?? true,
      maxLeverage: o.maxLeverage ?? 3,
      minSyncInterval: o.minSyncInterval ?? 24 * 3600,
      tipWei: o.tipWei ?? 5n * 10n ** 13n,
    }),
    syncState: async () => ({ lastSyncedAt: 0, syncCount: 2, followerClosed: false }),
    syncExecFeeCap: async () => o.cap ?? FEE,
    syncExecutor: async () => (o.executor === undefined ? null : o.executor),
    syncReadyAt: async () => o.readyAt ?? NOW + 3600,
    syncGasBalance: async () => o.gas ?? 10n ** 16n,
    pendingSync: async () => ({ syncable: false, latestVersion: o.latestVersion ?? 1n, cost: 0n }),
    latestStrategy: async () => (o.noStrategy ? null : { allocations: latestAllocs, versionId: o.latestVersion ?? 1n }),
    executionFee: async () => FEE,
    maxLeverageForAsset: async (a) => o.assetMax?.[a] ?? 5n,
    maxTipWei: async () => 10n ** 15n,
    now: async () => NOW,
    hasFunction: async (sig) => !(o.missing ?? []).includes(sig),
    traderEligible: async () => o.eligible ?? true,
    // 合約的算法：0.3% 跟單費、手續費緩衝（這裡固定 1%）、依權重拆份額
    previewFollow: async (_t, amount, cap) => {
      lastPreviewCap = cap;
      const copyFee = (amount * 30n) / 10_000n;
      const buffer = (amount - copyFee) / 100n;
      const m = amount - copyFee - buffer;
      return { copyFee, totalTradingFee: buffer, marginForPositions: m, portions: latestAllocs.map((a) => (m * a.weight) / 10_000n) };
    },
    minMargin: async () => 10n * 10n ** 18n,
    usdc: async () => ({ token: USDC, decimals: 18, balance: o.balance ?? 10n ** 24n, allowance: o.allowance ?? 0n }),
    kycGate: async (_f, assets) => ({
      rwa: Object.fromEntries(assets.map((a) => [a, o.rwa?.[a] ?? false])),
      verified: o.kycVerified === undefined ? false : o.kycVerified,
    }),
    simulate: async (tx) => {
      simulated.push(tx);
      return o.simulate ?? { ok: true };
    },
  };
}
let lastPreviewCap: number | null = null;
const simulated: Array<{ from: string; to: string; data: string; value: bigint }> = [];

{
  assert.equal(effectiveLeverage(5n, 2n, 3), 2n);
  assert.equal(effectiveLeverage(5n, 5n, 3), 3n);
  assert.equal(effectiveLeverage(5n, null, 0), 5n, "跟隨者沒設上限：照策略（資產上限讀不到時不另夾）");
  assert.equal(effectiveLeverage(1n, 5n, 3), 1n);
  ok("槓桿三者取小（策略、資產上限、跟隨者上限；0 = 不另設），與合約相同");
}

{
  const s = (await copySyncStatus(fake({ executor: AGENT }), FOLLOWER)) as Extract<Awaited<ReturnType<typeof copySyncStatus>>, { records: unknown }>;
  assert.equal(s.supported, true);
  assert.equal(s.records.length, 1, "已結束的跟單不列");
  const r = s.records[0] as any;
  assert.equal(r.version.current, "v1");
  assert.equal(r.version.latest, "v2");
  assert.equal(r.version.behind, true);
  assert.equal(r.autoSync.designatedExecutor, AGENT);
  assert.equal(r.autoSync.cooldownHours, 24);
  assert.equal(r.autoSync.executionFeeWithinConsent, true);
  assert.equal(r.cooldown.cooling, true);
  assert.match(r.nextStep, /冷卻中.*指定的執行者/);
  assert.equal(r.cost.perThirdPartySyncEth, ethers.formatEther(FEE * 2n + 5n * 10n ** 13n));
  assert.equal(r.cost.thirdPartySyncsAffordable, (10n ** 16n / (FEE * 2n + 5n * 10n ** 13n)).toString());
  assert.equal(s.syncGasBalanceEth, "0.01");

  const off = (await copySyncStatus(fake({ autoSync: false }), FOLLOWER, 0)) as any;
  assert.match(off.records[0].nextStep, /自動同步未開啟.*prepare_copy_sync_tx/);
  const fee = (await copySyncStatus(fake({ cap: FEE - 1n, readyAt: NOW - 1 }), FOLLOWER)) as any;
  assert.equal(fee.records[0].autoSync.executionFeeWithinConsent, false);
  assert.match(fee.records[0].nextStep, /執行費/);
  const broke = (await copySyncStatus(fake({ gas: 0n, readyAt: NOW - 1 }), FOLLOWER)) as any;
  assert.match(broke.records[0].nextStep, /油箱不夠/);
  const synced = (await copySyncStatus(fake({ recordVersion: 1n }), FOLLOWER)) as any;
  assert.match(synced.records[0].nextStep, /已是交易者最新版/);

  const old = (await copySyncStatus(fake({ supported: false }), FOLLOWER)) as any;
  assert.equal(old.supported, false);
  assert.match(old.message, /快照式/);
  await assert.rejects(copySyncStatus(fake(), "0x1234"), /不是合法地址/);
  await assert.rejects(copySyncStatus(fake(), FOLLOWER, 5), /沒有第 5 筆/);
  ok("copy_sync_status：版本落後、自動同步設定、指定執行者、冷卻、費率同意、油箱可同步次數與下一步建議");
}

{
  // 立即同步：釘最新版與執行費、油箱不夠時附上差額、預覽每腿實際槓桿
  const tx = await prepareCopyTx(fake({ gas: FEE, maxLeverage: 3, assetMax: { [BTC]: 2n } }), { follower: FOLLOWER, action: "resync", recordIdx: 0 });
  assert.equal(tx.to, TRACKER);
  assert.equal(tx.from, FOLLOWER);
  const d = IFACE.parseTransaction({ data: tx.data, value: BigInt(tx.value) })!;
  assert.equal(d.name, "resyncAtVersion");
  assert.deepEqual([...d.args].map(String), ["0", "1", FEE.toString()], "釘住 recordIdx、最新 versionId、每腿執行費");
  assert.equal(tx.value, FEE.toString(), "兩腿要 2 份執行費，油箱只有 1 份：附上差額");
  const legs = (tx.preview as any).legs;
  assert.deepEqual(legs.map((l: any) => [l.asset, l.direction, l.strategyLeverage, l.leverageUsed]), [
    ["sBTC", "long", 5, 2],
    ["sETH", "short", 2, 2],
  ]);
  assert.ok(tx.warnings.some((w) => /全部部位.*績效費/.test(w)), "揭露全平再開、績效費");
  assert.ok(tx.warnings.some((w) => /附上/.test(w)));
  assert.match(tx.note, /未簽名、未送出/);
  const noCap = await prepareCopyTx(fake({ maxLeverage: 0 }), { follower: FOLLOWER, action: "resync", recordIdx: 0 });
  assert.ok(noCap.warnings.some((w) => /沒有設定槓桿上限/.test(w)));
  assert.equal(noCap.value, "0");
  await assert.rejects(prepareCopyTx(fake({ recordVersion: 1n }), { follower: FOLLOWER, action: "resync", recordIdx: 0 }), /已是交易者最新版/);
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "resync", recordIdx: 1 }), /已結束/);
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "resync" }), /recordIdx 必填/);
  ok("prepare resync：resyncAtVersion 釘版本與執行費、差額附在 value、預覽新版各腿與三者取小的槓桿、揭露費用");
}

{
  const en = await prepareCopyTx(fake(), { follower: FOLLOWER, action: "enable", recordIdx: 0, maxLeverage: 2 });
  const d = IFACE.parseTransaction({ data: en.data })!;
  assert.equal(d.name, "setAutoSync");
  assert.deepEqual([...d.args].map(String), ["0", "true", "2", String(24 * 3600), "0", FEE.toString()], "預設冷卻 24 小時、小費 0、同意目前的執行費");
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "enable", recordIdx: 0 }), /maxLeverage 必填/);
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "enable", recordIdx: 0, maxLeverage: 2, cooldownHours: 0.5 }), /至少 1/);
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "enable", recordIdx: 0, maxLeverage: 2, tipEth: "0.01" }), /超過合約上限/);
  const short = await prepareCopyTx(fake(), { follower: FOLLOWER, action: "enable", recordIdx: 0, maxLeverage: 2, cooldownHours: 1 });
  assert.ok(short.warnings.some((w) => /短於預設/.test(w)));

  const dis = IFACE.parseTransaction({ data: (await prepareCopyTx(fake({ maxLeverage: 3 }), { follower: FOLLOWER, action: "disable", recordIdx: 0 })).data })!;
  assert.deepEqual([dis.args[1], Number(dis.args[2]), dis.args[5]], [false, 3, 0n], "關閉時保留槓桿上限、不看執行費");

  const ex = IFACE.parseTransaction({ data: (await prepareCopyTx(fake(), { follower: FOLLOWER, action: "set-executor", recordIdx: 0, executor: AGENT })).data })!;
  assert.deepEqual([ex.name, ex.args[1]], ["setSyncExecutor", AGENT]);
  const clear = IFACE.parseTransaction({ data: (await prepareCopyTx(fake(), { follower: FOLLOWER, action: "set-executor", recordIdx: 0 })).data })!;
  assert.equal(clear.args[1], ethers.ZeroAddress, "省略 executor＝解除指定");

  const dep = await prepareCopyTx(fake(), { follower: FOLLOWER, action: "deposit", amountEth: "0.02" });
  assert.equal(IFACE.parseTransaction({ data: dep.data, value: BigInt(dep.value) })!.name, "depositSyncGas");
  assert.equal(dep.value, ethers.parseEther("0.02").toString());
  const wd = await prepareCopyTx(fake(), { follower: FOLLOWER, action: "withdraw", amountEth: "0.004" });
  assert.equal(IFACE.parseTransaction({ data: wd.data })!.args[0], ethers.parseEther("0.004"));
  assert.equal(wd.value, "0");
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "withdraw", amountEth: "1" }), /油箱餘額/);
  await assert.rejects(prepareCopyTx(fake(), { follower: FOLLOWER, action: "deposit", amountEth: "abc" }), /ETH 金額/);
  await assert.rejects(prepareCopyTx(fake({ supported: false }), { follower: FOLLOWER, action: "deposit", amountEth: "1" }), /不是自動同步版/);
  ok("prepare enable／disable／set-executor／deposit／withdraw：編碼正確、enable 不替你決定槓桿上限、預設冷卻 24 小時");
}


{
  // 由 agent 發起跟單＋開啟自動同步：授權不足 → approve（剛好金額）＋跟單兩筆；釘最新版、執行費上限、預存油箱
  simulated.length = 0;
  const plan = await prepareCopyFollow(fake({ assetMax: { [BTC]: 2n } }), {
    follower: FOLLOWER, trader: TRADER, amountUsdc: "1000", autoSync: true, maxLeverage: 3,
  });
  assert.equal(plan.steps.length, 2);
  const [approve, follow] = plan.steps;
  assert.equal(approve.to, USDC);
  const ap = new ethers.Interface(ERC20_TOOL_ABI as unknown as string[]).parseTransaction({ data: approve.data })!;
  assert.deepEqual([ap.name, ap.args[0], ap.args[1]], ["approve", TRACKER, 1000n * E18], "只授權剛好的金額給 CopyTracker");
  assert.equal(approve.value, "0");
  assert.equal(follow.to, TRACKER);
  assert.equal(follow.from, FOLLOWER);
  const f = IFACE.parseTransaction({ data: follow.data, value: BigInt(follow.value) })!;
  assert.equal(f.name, "followTraderAtVersionWithAutoSync");
  assert.deepEqual([...f.args].map(String), [TRADER, (1000n * E18).toString(), "1", "3", String(24 * 3600), "0", FEE.toString()],
    "釘最新版 versionId、槓桿上限、預設冷卻 24 小時、小費 0、以目前執行費為同意上限");
  const prefund = (FEE * 2n) * 5n;
  assert.equal(follow.value, (FEE * 2n + prefund).toString(), "value＝開倉執行費 × 腿數＋預存油箱（預設夠代為同步 5 次）");
  assert.equal(lastPreviewCap, 3, "預覽套用跟隨者的槓桿上限（與合約開倉相同）");
  const pv = plan.preview as any;
  assert.deepEqual(pv.legs.map((l: any) => [l.asset, l.direction, l.strategyLeverage, l.leverageUsed]), [
    ["sBTC", "long", 5, 2],
    ["sETH", "short", 2, 2],
  ], "實際槓桿＝策略、交易所上限、跟隨者上限三者取小");
  assert.equal(pv.version, "v2");
  assert.equal(plan.simulation, null, "還沒授權：無法模擬，等 approve 上鏈後再呼叫一次");
  assert.equal(simulated.length, 0);
  assert.ok(plan.warnings.some((w) => /不能選資產、方向或槓桿/.test(w) && /隨時關閉自動同步、隨時提領油箱/.test(w)), "揭露自動同步的權限邊界");
  assert.ok(plan.warnings.some((w) => /StrategyVersionMismatch/.test(w)));
  assert.ok(plan.warnings.some((w) => /ExecutionFeeAboveCap/.test(w)));
  assert.ok(plan.nextSteps.some((s) => /set-executor recordIdx=2/.test(s)), "預估的新 recordIdx＝目前筆數");
  assert.match(plan.note, /未簽名、未送出/);
  ok("prepare_copy_follow_tx（autoSync）：approve 剛好金額＋followTraderAtVersionWithAutoSync（釘版本、執行費上限、預存油箱）；預覽三者取小的槓桿、揭露權限邊界");
}

{
  // 授權已足夠：只剩跟單一筆，並附 eth_call 模擬；不開自動同步 → followTraderAtVersion，只付開倉執行費
  simulated.length = 0;
  const plan = await prepareCopyFollow(fake({ allowance: 5000n * E18 }), {
    follower: FOLLOWER, trader: TRADER, amountUsdc: "1000.5", autoSync: false,
  });
  assert.equal(plan.steps.length, 1);
  const f = IFACE.parseTransaction({ data: plan.steps[0].data, value: BigInt(plan.steps[0].value) })!;
  assert.equal(f.name, "followTraderAtVersion");
  assert.deepEqual([...f.args].map(String), [TRADER, (10005n * E18 / 10n).toString(), "1"]);
  assert.equal(plan.steps[0].value, (FEE * 2n).toString());
  assert.equal(lastPreviewCap, null, "沒開自動同步：不套用上限的預覽（與 followTraderAtVersion 相同）");
  assert.deepEqual(plan.simulation, { ok: true });
  assert.equal(simulated.length, 1);
  assert.deepEqual([simulated[0].from, simulated[0].to, simulated[0].value], [FOLLOWER, TRACKER, FEE * 2n], "以跟隨者身分、附同樣的 value 模擬");
  assert.equal((plan.preview as any).autoSync, null);
  assert.ok(plan.nextSteps.some((s) => /action=enable recordIdx=2/.test(s)));

  const bad = await prepareCopyFollow(fake({ allowance: 5000n * E18, simulate: { ok: false, reason: "StalePrice(0x…, 1)" } }), {
    follower: FOLLOWER, trader: TRADER, amountUsdc: "1000", autoSync: false,
  });
  assert.deepEqual(bad.simulation, { ok: false, reason: "StalePrice(0x…, 1)" });
  assert.ok(bad.warnings.some((w) => /模擬這筆跟單會失敗：StalePrice/.test(w)));
  ok("prepare_copy_follow_tx：授權足夠只剩一筆並附模擬結果；不開自動同步用 followTraderAtVersion（仍釘版本）");
}

{
  // 檢查：金額、資格、策略、KYC、入口存在與否、自動同步一定要跟隨者自己給槓桿上限
  const base = { follower: FOLLOWER, trader: TRADER, amountUsdc: "1000", autoSync: true, maxLeverage: 2 };
  await assert.rejects(prepareCopyFollow(fake(), { ...base, maxLeverage: undefined }), /maxLeverage 必填/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, autoSync: undefined as unknown as boolean }), /autoSync 必填/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, trader: FOLLOWER }), /不能跟單自己/);
  await assert.rejects(prepareCopyFollow(fake({ eligible: false }), base), /TraderNotEligible/);
  await assert.rejects(prepareCopyFollow(fake({ noStrategy: true }), base), /還沒有發布任何策略/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, amountUsdc: "abc" }), /金額字串/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, amountUsdc: "0" }), /大於 0/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, tipEth: "0.01" }), /超過合約上限/);
  await assert.rejects(prepareCopyFollow(fake(), { ...base, cooldownHours: 0.5 }), /至少 1/);
  // 拆到各腿後最小一腿 < MIN_MARGIN（10）：拒絕並給出至少要投入多少
  await assert.rejects(prepareCopyFollow(fake(), { ...base, amountUsdc: "20" }), (e: Error) => /最低保證金 10\.0/.test(e.message) && /至少要投入約 26\.0/.test(e.message));
  await assert.rejects(prepareCopyFollow(fake({ missing: [SIG_FOLLOW_AUTOSYNC] }), base), /沒有一筆完成/);
  await assert.rejects(prepareCopyFollow(fake({ supported: false }), base), /沒有一筆完成/);
  await assert.rejects(prepareCopyFollow(fake({ missing: [SIG_FOLLOW_PINNED] }), { ...base, autoSync: false }), /沒有釘版本的跟單入口/);

  const rwa = await prepareCopyFollow(fake({ rwa: { [ETH]: true }, kycVerified: false, balance: 10n * E18 }), base);
  assert.ok(rwa.warnings.some((w) => /RWA.*sETH.*尚未通過 KYC.*NotKycVerified/.test(w)));
  assert.ok(rwa.warnings.some((w) => /不夠投入/.test(w)), "餘額不足時提醒");
  const zero = await prepareCopyFollow(fake(), { ...base, prefundEth: "0", cooldownHours: 1, tipEth: "0.0001" });
  const z = IFACE.parseTransaction({ data: zero.steps[1].data })!;
  assert.deepEqual([z.args[4], z.args[5]], [3600n, 10n ** 14n]);
  assert.equal(zero.steps[1].value, (FEE * 2n).toString(), "預存 0：只付開倉執行費");
  assert.ok(zero.warnings.some((w) => /油箱預存 0/.test(w)) && zero.warnings.some((w) => /短於預設/.test(w)));
  ok("prepare_copy_follow_tx 檢查：自動同步必須自己給槓桿上限、資格、策略、金額與每腿最低保證金、KYC、餘額、舊版 tracker 沒有入口");
}

{
  const T = new ethers.Interface(["error StrategyVersionMismatch(uint256 expected, uint256 actual)", "error NotKycVerified(address user)"]);
  assert.equal(decodeRevert(T.encodeErrorResult("StrategyVersionMismatch", [1, 2])), "StrategyVersionMismatch(1, 2)");
  assert.equal(decodeRevert(T.encodeErrorResult("NotKycVerified", [FOLLOWER])), `NotKycVerified(${FOLLOWER})`);
  const reason = "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["ERC20: insufficient allowance"]).slice(2);
  assert.equal(decodeRevert(reason), "ERC20: insufficient allowance");
  assert.equal(decodeRevert("0x"), null);
  assert.equal(decodeRevert("0xdeadbeef"), null);
  ok("模擬失敗的原因：解碼 CopyTracker／交易所自訂錯誤與 Error(string)");
}

// ─────────────── (c) 協定層 ───────────────
{
  const server = new McpServer({ name: "t", version: "0" });
  registerCopyTools(server, fake({ executor: AGENT }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(b);
  const names = ["copy_sync_status", "prepare_copy_sync_tx", "prepare_copy_follow_tx"];
  const tools = (await client.listTools()).tools.filter((t) => names.includes(t.name));
  assert.equal(tools.length, 3);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} 不簽名、不送出：唯讀`);
    assert.equal(t.annotations?.destructiveHint, false);
  }
  const res: any = await client.callTool({ name: "prepare_copy_sync_tx", arguments: { follower: FOLLOWER, action: "set-executor", recordIdx: 0, executor: AGENT } });
  assert.ok(!res.isError);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.to, TRACKER);
  assert.match(body.note, /未簽名/);
  const bad: any = await client.callTool({ name: "copy_sync_status", arguments: { follower: "nope" } });
  assert.equal(bad.isError, true);
  const fol: any = await client.callTool({
    name: "prepare_copy_follow_tx",
    arguments: { follower: FOLLOWER, trader: TRADER, amountUsdc: "1000", autoSync: true, maxLeverage: 2 },
  });
  assert.ok(!fol.isError);
  const plan = JSON.parse(fol.content[0].text);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].to, TRACKER);
  const noLev: any = await client.callTool({
    name: "prepare_copy_follow_tx",
    arguments: { follower: FOLLOWER, trader: TRADER, amountUsdc: "1000", autoSync: true },
  });
  assert.equal(noLev.isError, true);
  assert.match(noLev.content[0].text, /maxLeverage 必填/);
  await client.close();
  ok("協定層：三個工具都標唯讀（readOnlyHint）、回傳待簽交易 JSON；錯誤以 isError 回報");
}

console.log(`mcp copyTools: ${n} ok`);
