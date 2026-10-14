// 在本機 Anvil 上回放一份排程：逐日設定時間、寫入價格、清算、讓交易者重新發布策略並換倉、
// 讓虛擬跟隨者跟隨與取消。結束時把相關事件匯出成 events.json。
//   cd agent && npx tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { COPY_ABI, EXCHANGE_ABI, KYC_ABI, ORACLE_ABI, REGISTRY_ABI, STAKE_ABI, USDC_ABI } from "./abi.ts";
import { planOpens, shouldLiquidate, type LegPlan } from "./plan.ts";

const RPC = process.env.HEROES_RPC_URL ?? "http://127.0.0.1:8545";
// Anvil 的預設助記詞。公開的測試金鑰，只能用在本機鏈。
const MNEMONIC = "test test test test test test test test test test test junk";
const DEMO_INDEX = 9;
const E18 = 10n ** 18n;

interface Rebalance { date: string; legs: LegPlan[] }
interface TraderDoc { index: number; name: string; rule: string; capitalUsd: number; stakeUsd: number; rebalances: Rebalance[] }
interface FollowerAction { date: string; type: "follow" | "unfollow"; traderIndex: number; amountUsd?: number }
interface Schedule {
  start: string; end: string; assets: string[];
  days: { date: string; timestamp: number; prices: Record<string, string> }[];
  traders: TraderDoc[];
  followers: { index: number; actions: FollowerAction[] }[];
}

const [schedulePath, addressesPath, outPath] = process.argv.slice(2);
if (!schedulePath || !addressesPath || !outPath) {
  console.error("usage: tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>");
  process.exit(2);
}
const schedule: Schedule = JSON.parse(readFileSync(schedulePath, "utf8"));
const A: Record<string, string> = JSON.parse(readFileSync(addressesPath, "utf8"));

// 固定網路、不批次、不快取：回放是幾萬筆依序送出的交易，預設的 10ms 批次等待會讓它慢上好幾倍。
const LOCAL = ethers.Network.from(31337);
const provider = new ethers.JsonRpcProvider(RPC, LOCAL, {
  staticNetwork: LOCAL, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 100,
});
const wallet = (index: number) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
// 刻意不用 NonceManager：它在 estimateGas 失敗時也會把 nonce 往前推，之後每筆交易都卡住。
const deployer = wallet(0);

const exchange = new ethers.Contract(A.PerpetualExchange, EXCHANGE_ABI, provider);
const registry = new ethers.Contract(A.StrategyRegistry, REGISTRY_ABI, provider);
const copy = new ethers.Contract(A.CopyTracker, COPY_ABI, provider);
const stake = new ethers.Contract(A.TraderStake, STAKE_ABI, provider);
const usdc = new ethers.Contract(A.MockUSDC, USDC_ABI, provider);
const oracle = new ethers.Contract(A.MockOracle, ORACLE_ABI, provider);
const kyc = new ethers.Contract(A.KYCRegistry, KYC_ABI, provider);

const assetId = (symbol: string) => ethers.id(symbol);
const symbolOf = new Map(schedule.assets.map((s) => [assetId(s), s]));
const usd = (amount: number) => BigInt(amount) * E18;

const stats = { sent: 0, failed: 0, failures: [] as string[], skipped: [] as string[] };
type Receipt = ethers.ContractTransactionReceipt | null;

/** 送一筆交易並等它上鏈。失敗只記錄、不中斷——結束時由失敗比例決定這趟回放算不算數。 */
async function send(label: string, tx: () => Promise<ethers.ContractTransactionResponse>): Promise<Receipt> {
  stats.sent += 1;
  try {
    return await (await tx()).wait();
  } catch (e) {
    stats.failed += 1;
    if (stats.failures.length < 50) stats.failures.push(`${label}: ${(e as Error).message.slice(0, 160)}`);
    return null;
  }
}

// 目前開著的部位（交易者的與跟隨者的都算），清算檢查用。
const open = new Map<bigint, { asset: string; margin: bigint; leverage: bigint }>();

function track(receipt: Receipt): void {
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== A.PerpetualExchange.toLowerCase()) continue;
    const parsed = exchange.interface.parseLog(log);
    if (parsed?.name === "PositionOpened") {
      open.set(parsed.args.positionId, {
        asset: symbolOf.get(parsed.args.asset)!, margin: parsed.args.margin, leverage: parsed.args.leverage,
      });
    } else if (parsed?.name === "PositionClosed") {
      open.delete(parsed.args.positionId);
    }
  }
}

async function chunked<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function main(): Promise<void> {
  // provider 的網路是寫死的，所以直接問節點它到底是哪條鏈。
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 31337n) throw new Error(`refusing to replay on chainId ${chainId}: local Anvil (31337) only`);

  const traders = schedule.traders.map((t) => ({ ...t, wallet: wallet(t.index) }));
  const traderByIndex = new Map(traders.map((t) => [t.index, t]));
  const followers = schedule.followers.map((f) => ({ ...f, wallet: wallet(f.index) }));
  const demo = wallet(DEMO_INDEX);

  // ── 初始化 ────────────────────────────────────────────────────────────────
  // 每個區塊的時間戳固定 +1 秒，兩次回放才會逐筆相同。
  await provider.send("anvil_setBlockTimestampInterval", [1]);
  const everyone = [...traders.map((t) => t.wallet.address), ...followers.map((f) => f.wallet.address), demo.address];
  for (const address of everyone) await provider.send("anvil_setBalance", [address, ethers.toBeHex(1000n * E18)]);
  for (let i = 0; i < everyone.length; i += 50) {
    await send("kyc", () => kyc.connect(deployer).getFunction("batchVerify")(everyone.slice(i, i + 50)));
  }
  await send("mint demo", () => usdc.connect(deployer).getFunction("mint")(demo.address, usd(100_000)));

  // 第一天的時間與價格要先就位，交易者存入與開倉才不會遇到過期報價。
  const executionFee: bigint = await exchange.executionFee();
  const feeBps: Record<string, bigint> = {};
  const maintenanceBps: Record<string, bigint> = {};
  for (const symbol of schedule.assets) {
    feeBps[symbol] = await exchange.tradingFeeBpsForAsset(assetId(symbol));
    maintenanceBps[symbol] = await exchange.maintenanceMarginBpsForAsset(assetId(symbol));
  }

  for (const t of traders) {
    const w = t.wallet;
    await send(`mint ${t.name}`, () => usdc.connect(deployer).getFunction("mint")(w.address, usd(t.capitalUsd + t.stakeUsd)));
    await send(`approve stake ${t.name}`, () => usdc.connect(w).getFunction("approve")(A.TraderStake, usd(t.stakeUsd)));
    await send(`stake ${t.name}`, () => stake.connect(w).getFunction("stake")(usd(t.stakeUsd)));
    await send(`register ${t.name}`, () => registry.connect(w).getFunction("registerTrader")(t.name));
    await send(`approve margin ${t.name}`, () => usdc.connect(w).getFunction("approve")(A.PerpetualExchange, usd(t.capitalUsd)));
    await send(`deposit ${t.name}`, () => exchange.connect(w).getFunction("depositMargin")(usd(t.capitalUsd)));
  }
  for (const f of followers) {
    const total = f.actions.reduce((sum, a) => sum + (a.amountUsd ?? 0), 0);
    if (total > 0) await send(`mint follower ${f.index}`, () => usdc.connect(deployer).getFunction("mint")(f.wallet.address, usd(total)));
  }

  // ── 逐日 ──────────────────────────────────────────────────────────────────
  for (const [n, day] of schedule.days.entries()) {
    await provider.send("evm_setNextBlockTimestamp", [day.timestamp]);
    for (const symbol of schedule.assets) {
      await send(`price ${symbol} ${day.date}`, () =>
        oracle.connect(deployer).getFunction("updatePrice")(assetId(symbol), BigInt(day.prices[symbol])));
    }

    // 清算不會自己發生：每天把不健康的部位清掉。
    const ids = [...open.keys()];
    const values = await chunked(ids, 50, (id) => exchange.getPositionValue(id) as Promise<bigint>);
    for (const [i, id] of ids.entries()) {
      const p = open.get(id)!;
      if (shouldLiquidate(values[i], p.margin, p.leverage, maintenanceBps[p.asset])) {
        track(await send(`liquidate ${id}`, () => exchange.connect(deployer).getFunction("liquidatePosition")(id)));
      }
    }

    for (const t of traders) {
      const rebalance = t.rebalances.find((r) => r.date === day.date);
      if (!rebalance) continue;
      const w = t.wallet;
      const held: bigint[] = await exchange.getUserPositions(w.address);
      for (const id of held) {
        track(await send(`close ${id}`, () => exchange.connect(w).getFunction("closePosition")(id)));
      }
      // 質押被罰沒到門檻以下的交易者不能再發布；他照樣換倉，只是鏈上的策略停在上一版。
      if (await registry.isEligibleTrader(w.address)) {
        await send(`publish ${t.name} ${day.date}`, () =>
          registry.connect(w).getFunction("publishStrategy")(rebalance.legs.map((l) => ({
            asset: assetId(l.asset), weight: l.weightBps, isLong: l.isLong, leverage: l.leverage,
          }))));
      } else {
        stats.skipped.push(`publish ${t.name} ${day.date}: stake below the minimum`);
      }
      const free: bigint = await exchange.freeMargin(w.address);
      for (const order of planOpens(free, rebalance.legs, feeBps)) {
        track(await send(`open ${t.name} ${order.asset}`, () =>
          exchange.connect(w).getFunction("openPosition")(
            assetId(order.asset), order.isLong, order.margin, order.leverage, { value: executionFee })));
      }
    }

    for (const f of followers) {
      for (const action of f.actions.filter((a) => a.date === day.date)) {
        const trader = traderByIndex.get(action.traderIndex)!.wallet.address;
        if (action.type === "follow") {
          if (!(await registry.isEligibleTrader(trader))) {
            stats.skipped.push(`follow ${f.index}->${action.traderIndex} ${day.date}: trader not eligible`);
            continue;
          }
          const amount = usd(action.amountUsd!);
          const [allocations] = await registry.getLatestStrategy(trader);
          await send(`approve follow ${f.index}`, () => usdc.connect(f.wallet).getFunction("approve")(A.CopyTracker, amount));
          track(await send(`follow ${f.index}->${action.traderIndex}`, () =>
            copy.connect(f.wallet).getFunction("followTrader")(trader, amount, { value: executionFee * BigInt(allocations.length) })));
        } else {
          const records: { trader: string; active: boolean }[] = await copy.getCopyRecords(f.wallet.address);
          const index = records.findIndex((r) => r.active && r.trader.toLowerCase() === trader.toLowerCase());
          if (index < 0) continue; // 跟隨那一步失敗過，沒有紀錄可取消
          track(await send(`unfollow ${f.index}->${action.traderIndex}`, () =>
            copy.connect(f.wallet).getFunction("unfollowAndCloseAll")(index)));
        }
      }
    }
    if (n % 30 === 0) console.log(`${day.date}  open=${open.size}  sent=${stats.sent}  failed=${stats.failed}`);
  }

  // ── 匯出 ──────────────────────────────────────────────────────────────────
  const traderDocs = [];
  for (const t of traders) {
    const held: bigint[] = await exchange.getUserPositions(t.wallet.address);
    let equity: bigint = await exchange.freeMargin(t.wallet.address);
    for (const id of held) equity += (await exchange.getPositionValue(id)) as bigint;
    traderDocs.push({
      index: t.index, name: t.name, rule: t.rule, address: t.wallet.address, capitalUsd: t.capitalUsd,
      finalEquity: equity.toString(), followerCount: Number(await copy.getFollowerCount(t.wallet.address)),
    });
  }

  const events = [];
  for (const contract of [exchange, registry, copy]) {
    const logs = await provider.getLogs({ address: await contract.getAddress(), fromBlock: 0, toBlock: "latest" });
    for (const log of logs) {
      const parsed = contract.interface.parseLog(log);
      if (!parsed) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        const value = parsed.args[i];
        args[input.name] = input.name === "asset" ? symbolOf.get(value)
          : typeof value === "bigint" ? value.toString() : value;
      });
      if (parsed.name === "PositionOpened") args.tradingFeeBps = feeBps[args.asset as string].toString();
      if (parsed.name === "StrategyPublished") {
        const [legs] = await registry.getStrategyVersion(parsed.args.trader, parsed.args.versionId);
        args.legs = legs.map((l: { asset: string; weight: bigint; isLong: boolean; leverage: bigint }) => ({
          asset: symbolOf.get(l.asset), weightBps: Number(l.weight), isLong: l.isLong, leverage: Number(l.leverage),
        }));
      }
      events.push({ name: parsed.name, block: log.blockNumber, logIndex: log.index, timestamp: 0, tx: log.transactionHash, args });
    }
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const blocks = [...new Set(events.map((e) => e.block))];
  const stamps = new Map(await chunked(blocks, 100, async (b) => [b, (await provider.getBlock(b))!.timestamp] as const));
  for (const e of events) e.timestamp = stamps.get(e.block)!;

  writeFileSync(outPath, JSON.stringify({
    schemaVersion: 1, chainId: 31337, range: { from: schedule.start, to: schedule.end },
    stats, traders: traderDocs, events,
  }) + "\n");

  const ratio = stats.sent === 0 ? 0 : stats.failed / stats.sent;
  console.log(`replayed ${schedule.days.length} days: ${stats.sent} tx, ${stats.failed} failed (${(ratio * 100).toFixed(2)}%), ${events.length} events -> ${outPath}`);
  for (const line of stats.failures.slice(0, 10)) console.log(`  failed: ${line}`);
  if (ratio > 0.01) {
    console.error("more than 1% of transactions failed: this replay does not count");
    process.exit(1);
  }
}

// 明確結束：provider 的連線會讓行程掛著不退出，後面的腳本就等不到它。
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
