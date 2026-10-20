// 回放一份排程：逐日寫入價格、清算、讓交易者重新發布策略並換倉、讓虛擬跟隨者跟隨與取消；
// 每個模擬月份的最後一天觸發一次碳權退役的分流與退役（#333）。結束時把相關事件匯出成 events.json。
//
// 兩種模式：
//   本機（預設）：Anvil（31337）。每天把區塊時間撥到那一天，時間是真的過了兩年。
//     cd agent && npx tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>
//   公開鏈（#344）：Base Sepolia（84532），時間壓縮——兩年的交易在幾小時內跑完，區塊時間就是回放當天。
//     cd agent && HEROES_RPC_URL=<Infura/Alchemy> npx tsx heroes/replay.ts --public-chain \
//       <schedule.json> <addresses.json> <events.json> --progress <progress.json> --keystore <keys.json> \
//       --deployer-account <foundry keystore 名稱>
//     - 只允許 chainId 84532，執行前要輸入確認字句（mode.ts 的 CONFIRM_PHRASE）。
//     - 不用任何 Anvil 專屬的 RPC；部署者轉 gas 用的 ETH 給這一天要動的帳號。
//     - 交易者、跟隨者、造市帳號用新產生的金鑰（keystore.ts），存在被 git 忽略的金鑰檔。
//     - 每個動作記進進度檔（journal.ts），中斷後重新執行同一行指令就從最後完成的那一天接著跑、不重複送出。
//     - 記下每一天落在哪些區塊（events.json 的 days），分析用它還原模擬日期。
//     - 同一天裡不同帳號的交易平行送出（sender.ts）。
//     fork 演練：--impersonate-deployer <address> 取代 --deployer-account，只在 anvil fork 上可用。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { COPY_ABI, EXCHANGE_ABI, KYC_ABI, ORACLE_ABI, REGISTRY_ABI, STAKE_ABI, USDC_ABI } from "./abi.ts";
import { isLastDayOfMonth, planHedge, planOpens, shouldLiquidate, type LegPlan, type OpenOrder } from "./plan.ts";
import { localProvider, publicProvider } from "./provider.ts";
import { PUBLIC_POLLING } from "./receipt.ts";
import { crankCarbon, RETIREMENT_ABI, SPLITTER_ABI } from "../keeper/carbon.ts";
import { assertChain, assertImpersonationAllowed, CONFIRM_PHRASE, confirmed, parseArgs, rpcWarning, USAGE, type ReplayArgs } from "./mode.ts";
import { fileStore, Journal, memoryStore, type Entry, type Resolution } from "./journal.ts";
import {
  cachedFees, contractCall, forEach, isFatal, isRejected, LocalSender, PublicSender, transferCall,
  type Account, type Call, type Sender,
} from "./sender.ts";
import { ANVIL_MNEMONIC, loadOrCreateKeystore, type KeySet } from "./keystore.ts";
import { costPerTx, RECYCLE_THRESHOLD, topUp, type Need } from "./gas.ts";
import { ask, closePrompts } from "./prompt.ts";

// Anvil 的預設助記詞。公開的測試金鑰，只能用在本機鏈。
const MNEMONIC = ANVIL_MNEMONIC;
const DEMO_INDEX = 9;
// 造市帳號：站在模擬交易者與跟隨者淨部位的另一邊，讓資金費率趨近 0（見 plan.ts 的 planHedge）。
// 不是模擬交易者，不上排行榜，績效資料也不算它。
const MAKER_INDEX = 1;
const MAKER_CAPITAL_USD = 100_000_000;
const E18 = 10n ** 18n;
/** 共用的 MockOracle（keeper 寫現價）。公開鏈回放絕不能寫它（#344）。 */
const SHARED_MOCK_ORACLE = "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3";

interface Rebalance { date: string; legs: LegPlan[] }
interface TraderDoc { index: number; name: string; rule: string; capitalUsd: number; stakeUsd: number; rebalances: Rebalance[] }
interface FollowerAction { date: string; type: "follow" | "unfollow"; traderIndex: number; amountUsd?: number }
interface Schedule {
  start: string; end: string; assets: string[];
  days: { date: string; timestamp: number; prices: Record<string, string> }[];
  traders: TraderDoc[];
  followers: { index: number; actions: FollowerAction[] }[];
}

let args: ReplayArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const PUBLIC = args.mode === "public";
const scheduleText = readFileSync(args.schedulePath, "utf8");
const schedule: Schedule = JSON.parse(scheduleText);
const A: Record<string, string> = JSON.parse(readFileSync(args.addressesPath, "utf8"));

const RPC = process.env.HEROES_RPC_URL ?? (PUBLIC ? "" : "http://127.0.0.1:8545");
if (!RPC) {
  console.error(`--public-chain needs HEROES_RPC_URL (a stable Infura/Alchemy endpoint)\n${USAGE}`);
  process.exit(2);
}
// 本機：固定網路、不批次、不快取（見 provider.ts）。公開鏈：同樣固定網路與不快取，保留批次。
const provider = PUBLIC ? publicProvider(RPC) : localProvider(RPC);
const sender: Sender = PUBLIC
  ? new PublicSender(provider, cachedFees(provider), {
    ...PUBLIC_POLLING,
    // fork 演練的 anvil 即時出塊，不必每秒才問一次
    intervalMs: Number(process.env.HEROES_RECEIPT_POLL_MS ?? PUBLIC_POLLING.intervalMs),
  })
  : new LocalSender(provider);
// 同時進行的帳號數。公開鏈預設 12：Alchemy 免費方案的每秒額度下，32 個帳號同時輪詢收據會被限流。
const CONCURRENCY = Number(process.env.HEROES_CONCURRENCY ?? (PUBLIC ? 12 : 32));
const LOG_CHUNK = Number(process.env.HEROES_LOG_CHUNK ?? 1000);

const exchange = new ethers.Contract(A.PerpetualExchange, EXCHANGE_ABI, provider);
const registry = new ethers.Contract(A.StrategyRegistry, REGISTRY_ABI, provider);
const copy = new ethers.Contract(A.CopyTracker, COPY_ABI, provider);
const stake = new ethers.Contract(A.TraderStake, STAKE_ABI, provider);
const usdc = new ethers.Contract(A.MockUSDC, USDC_ABI, provider);
const oracle = new ethers.Contract(A.MockOracle, ORACLE_ABI, provider);
const kyc = new ethers.Contract(A.KYCRegistry, KYC_ABI, provider);
const splitter = new ethers.Contract(A.PlatformFeeSplitter, SPLITTER_ABI, provider);
const retirement = new ethers.Contract(A.CarbonRetirement, RETIREMENT_ABI, provider);
const OWNABLE = ["function owner() view returns (address)"];
const exchangeOps = new ethers.Contract(A.PerpetualExchange, [...OWNABLE, "function withdrawExecutionFees()"], provider);

const assetId = (symbol: string) => ethers.id(symbol);
const symbolOf = new Map(schedule.assets.map((s) => [assetId(s), s]));
const usd = (amount: number) => BigInt(amount) * E18;
type Receipt = ethers.TransactionReceipt | null;

let journal: Journal;

/**
 * 送一筆交易並等它上鏈。失敗只記錄、不中斷——結束時由失敗比例決定這趟回放算不算數。
 * key 在整份排程裡唯一：進度裡已經有這個鍵就不再送，回傳記下的那一筆的收據（續跑時接回未平倉部位）。
 * build 回 null 表示看過鏈上狀態後決定不送（例如沒有紀錄可取消）。
 */
async function step(key: string, label: string, build: () => Call | null | Promise<Call | null>): Promise<Receipt> {
  const done = journal.entry(key);
  if (done) {
    if (done.status !== "ok" || !done.hash) return null;
    return provider.getTransactionReceipt(done.hash);
  }
  const call = await build();
  if (!call) return null;
  try {
    const receipt = await sender.submit(call, { onHash: (hash, nonce) => journal.markSent(key, hash, call.from.address, nonce) });
    journal.markResult(key, true, label);
    return receipt;
  } catch (e) {
    const message = (e as Error).message;
    // 公開鏈：節點拒收或等不到收據，不是交易本身失敗——停下整趟，續跑時重送或問節點（sender.ts）。
    if (isFatal(e)) {
      if (e.forget) journal.forget(key);
      throw new Error(`${label}: ${message}\nstopped; fix the cause and run the same command again (the replay resumes)`);
    }
    if (isRejected(e) || !journal.entry(key)) journal.markRejected(key, label, message);
    else journal.markResult(key, false, label, message);
    return null;
  }
}

/** 已送出但結果不明的交易：上鏈了就照收據，節點不知道這筆（沒送出去或被丟掉）就重送。 */
async function resolveEntry(e: Entry): Promise<Resolution> {
  try {
    const receipt = await provider.getTransactionReceipt(e.hash!);
    if (receipt) return receipt.status === 1 ? "ok" : "failed";
    if (await provider.getTransaction(e.hash!)) return "pending";
    // 節點說不知道這一筆，但負載平衡後面的節點可能落後：這個 nonce 已經被用掉，就是我們這一筆
    // （同一個 nonce 只簽過一次），等收據出現，不能當成沒送過而重送。
    if (e.from && e.nonce !== undefined && (await provider.getTransactionCount(e.from, "latest")) > e.nonce) return "pending";
    return "unknown";
  } catch {
    return "pending"; // 查詢本身失敗：稍後再問，絕不因此重送
  }
}

// 目前開著的部位（交易者的與跟隨者的都算），清算檢查用。
type OpenPosition = { owner: string; asset: string; isLong: boolean; margin: bigint; leverage: bigint };
const open = new Map<bigint, OpenPosition>();
const encodeOpen = () => [...open.entries()].map(([id, p]) => [id.toString(), p.owner, p.asset, p.isLong, p.margin.toString(), p.leverage.toString()]);
function restoreOpen(raw: unknown): void {
  open.clear();
  for (const [id, owner, asset, isLong, margin, leverage] of raw as [string, string, string, boolean, string, string][]) {
    open.set(BigInt(id), { owner, asset, isLong, margin: BigInt(margin), leverage: BigInt(leverage) });
  }
}

function track(receipt: Receipt): void {
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== A.PerpetualExchange.toLowerCase()) continue;
    const parsed = exchange.interface.parseLog(log);
    if (parsed?.name === "PositionOpened") {
      open.set(parsed.args.positionId, {
        owner: parsed.args.owner.toLowerCase(), asset: symbolOf.get(parsed.args.asset)!, isLong: parsed.args.isLong,
        margin: parsed.args.margin, leverage: parsed.args.leverage,
      });
    } else if (parsed?.name === "PositionClosed" || parsed?.name === "PositionLiquidated") {
      open.delete(parsed.args.positionId);
    }
  }
}

/**
 * 這個模擬月份的平台份額 → 分流 → 退役。兩筆都走 step()，失敗照常計入 stats（對帳要求 0 失敗）；
 * 任何一筆失敗就停在那裡，預算留到下個月。續跑時 crankCarbon 看的是鏈上狀態：已分配就不會再分配。
 */
async function crankCarbonMonth(date: string, deployer: Account): Promise<void> {
  const must = async (key: string, label: string, method: string, a: unknown[]) => {
    if (!(await step(key, `${label} ${date}`, () => contractCall(deployer, method === "distribute" ? splitter : retirement, method, a)))) {
      throw new Error(`${label} failed`);
    }
  };
  try {
    await crankCarbon(
      {
        pending: async () => (await splitter.pending()) as bigint,
        distribute: () => must("carbon:distribute", "carbon distribute", "distribute", []),
      },
      {
        budget: async () => (await retirement.budget()) as bigint,
        quoteTonnes: async (amount) => (await retirement.quoteTonnes(amount)) as bigint,
        availableTonnes: async () => (await retirement.availableTonnes()) as bigint,
        retire: (amount) => must("carbon:retire", "carbon retire", "retire", [amount]),
      },
    );
  } catch (e) {
    // 交易失敗已由 step() 記錄；停下整趟的錯誤（step() 重新丟出的）照樣往上丟。
    if (!/failed$/.test((e as Error).message)) throw e;
  }
}

async function chunked<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const orderCodec = {
  encode: (orders: OpenOrder[]) => orders.map((o) => ({ ...o, margin: o.margin.toString() })),
  decode: (raw: unknown) => (raw as (OpenOrder & { margin: string })[]).map((o) => ({ ...o, margin: BigInt(o.margin) })),
};
const idsCodec = {
  encode: (ids: bigint[]) => ids.map(String),
  decode: (raw: unknown) => (raw as string[]).map(BigInt),
};
type Hedge = { closeIds: bigint[]; open: { isLong: boolean; margin: bigint } | null } | null;
const hedgeCodec = {
  encode: (h: Hedge) => h && { closeIds: h.closeIds.map(String), open: h.open && { ...h.open, margin: h.open.margin.toString() } },
  decode: (raw: unknown): Hedge => {
    const h = raw as { closeIds: string[]; open: { isLong: boolean; margin: string } | null } | null;
    return h && { closeIds: h.closeIds.map(BigInt), open: h.open && { isLong: h.open.isLong, margin: BigInt(h.open.margin) } };
  },
};

// ── 帳號 ────────────────────────────────────────────────────────────────────

const anvilWallet = (index: number) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
const asAccount = (w: ethers.HDNodeWallet | ethers.Wallet): Account => ({ address: w.address, signer: w });

async function secret(envName: string, question: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const answer = await ask(question, { hidden: true });
  if (answer === null) throw new Error(`no ${envName} and no terminal to ask`);
  return answer;
}

/** 公開鏈的部署者：擁有者的 Foundry keystore，或 fork 演練裡假冒的位址。 */
async function publicDeployer(): Promise<Account> {
  if (args.impersonate) {
    assertImpersonationAllowed(await provider.send("web3_clientVersion", []));
    const address = ethers.getAddress(args.impersonate);
    await provider.send("anvil_impersonateAccount", [address]);
    return { address, signer: await (provider as ethers.JsonRpcProvider).getSigner(address) };
  }
  const dir = process.env.FOUNDRY_DIR ?? join(homedir(), ".foundry");
  const path = join(dir, "keystores", args.deployerAccount!);
  const password = await ask(`password for Foundry keystore ${args.deployerAccount}: `, { hidden: true });
  if (password === null) throw new Error("no terminal to ask for the deployer keystore password");
  const wallet = await ethers.Wallet.fromEncryptedJson(readFileSync(path, "utf8"), password);
  return asAccount((wallet as ethers.Wallet).connect(provider));
}

// ── 主程式 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // provider 的網路是寫死的，所以直接問節點它到底是哪條鏈。
  const chainId = BigInt(await provider.send("eth_chainId", []));
  assertChain(args.mode, chainId);

  let keys: KeySet | null = null;
  let deployer: Account;
  if (PUBLIC) {
    const warning = rpcWarning(RPC);
    if (warning) console.warn(`WARNING: ${warning}`);
    deployer = await publicDeployer();
    const loaded = await loadOrCreateKeystore(args.keystorePath!, await secret("HEROES_KEYSTORE_PASSWORD", `password for ${args.keystorePath}: `));
    keys = loaded.keys;
    console.log(`${loaded.created ? "created" : "loaded"} keystore ${args.keystorePath} (${keys.fingerprint})`);
  } else {
    deployer = asAccount(anvilWallet(0));
  }
  const wallet = (index: number): Account => (keys ? asAccount(keys.wallet(index).connect(provider)) : asAccount(anvilWallet(index)));

  journal = new Journal(
    PUBLIC ? fileStore(args.progressPath!) : memoryStore(),
    Number(chainId),
    {
      schedule: createHash("sha256").update(scheduleText).digest("hex"),
      exchange: A.PerpetualExchange.toLowerCase(),
      oracle: A.MockOracle.toLowerCase(),
      deployer: deployer.address.toLowerCase(),
      keys: keys?.fingerprint ?? "anvil",
    },
  );

  const traders = schedule.traders.map((t) => ({ ...t, wallet: wallet(t.index) }));
  const traderByIndex = new Map(traders.map((t) => [t.index, t]));
  const followers = schedule.followers.map((f) => ({ ...f, wallet: wallet(f.index) }));
  const demo = PUBLIC ? null : wallet(DEMO_INDEX);
  const maker = wallet(MAKER_INDEX);
  const dates = schedule.days.map((d) => d.date);
  const firstDay = journal.nextDay(dates);

  if (PUBLIC) await preflightPublic(deployer, firstDay, dates.length);

  // 第一天的時間與價格要先就位，交易者存入與開倉才不會遇到過期報價。
  const executionFee: bigint = await exchange.executionFee();
  const feeBps: Record<string, bigint> = {};
  const maintenanceBps: Record<string, bigint> = {};
  for (const symbol of schedule.assets) {
    feeBps[symbol] = await exchange.tradingFeeBpsForAsset(assetId(symbol));
    maintenanceBps[symbol] = await exchange.maintenanceMarginBpsForAsset(assetId(symbol));
  }

  // ── 公開鏈的 gas：部署者轉給這一段要送交易的帳號 ──────────────────────────
  const exchangeOwner = PUBLIC ? ((await exchangeOps.owner()) as string) : null;
  const fees = cachedFees(provider);
  async function fundGas(phase: string, needs: Need[]): Promise<void> {
    if (!PUBLIC) return;
    const { maxFeePerGas } = await fees.fees();
    const plan: { need: Need; amount: bigint }[] = [];
    for (const need of needs) {
      const amount = topUp(await provider.getBalance(need.address), need, maxFeePerGas);
      if (amount > 0n) plan.push({ need, amount });
    }
    if (!plan.length) return;
    const total = plan.reduce((s, p) => s + p.amount, 0n) + BigInt(plan.length + 30) * costPerTx(maxFeePerGas);
    if ((await provider.getBalance(deployer.address)) < total) await recycleExecutionFees(`${phase}:recycle`, 0n);
    const have = await provider.getBalance(deployer.address);
    if (have < total) {
      throw new Error(`deployer ${deployer.address} has ${ethers.formatEther(have)} ETH, ${phase} needs ${ethers.formatEther(total)}: ` +
        "fund it and run the same command again (the replay resumes from here)");
    }
    await forEach(true, plan, async ({ need, amount }) => {
      await step(`gas:${phase}:${need.address.toLowerCase()}`, `gas ${need.address}`, () => transferCall(deployer, need.address, amount));
    }, CONCURRENCY);
  }
  /** 交易所收的執行費（開倉付的 ETH）由 owner 領回、繼續發 gas。部署者不是 owner（已移交 timelock）就不領。 */
  async function recycleExecutionFees(key: string, threshold: bigint = RECYCLE_THRESHOLD): Promise<void> {
    if (!PUBLIC || exchangeOwner?.toLowerCase() !== deployer.address.toLowerCase()) return;
    if ((await provider.getBalance(A.PerpetualExchange)) <= threshold) return;
    await step(key, "withdraw execution fees", () => contractCall(deployer, exchangeOps, "withdrawExecutionFees", []));
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  if (!journal.doc.setupDone) {
    if (journal.doc.setupFromBlock !== null) {
      // 初始化做到一半停過：先把「已送出、結果未知」的那幾筆問清楚，再接著做。
      const r = await journal.resolvePending(resolveEntry);
      console.log(`setup: resuming (${r.resolved} in-flight tx resolved, ${r.dropped} never landed)`);
    }
    journal.startSetup((await provider.getBlockNumber()) + 1);
    const everyone = [...traders.map((t) => t.wallet.address), ...followers.map((f) => f.wallet.address),
      ...(demo ? [demo.address] : []), maker.address];
    if (PUBLIC) {
      await fundGas("setup", [
        ...traders.map((t) => ({ address: t.wallet.address, txs: 5, value: 0n })),
        { address: maker.address, txs: 2, value: 0n },
      ]);
    } else {
      // 每個區塊的時間戳固定 +1 秒，兩次回放才會逐筆相同。
      await provider.send("anvil_setBlockTimestampInterval", [1]);
      for (const address of everyone) await provider.send("anvil_setBalance", [address, ethers.toBeHex(1000n * E18)]);
    }
    const batches: string[][] = [];
    for (let i = 0; i < everyone.length; i += 50) batches.push(everyone.slice(i, i + 50));
    await forEach(sender.parallel, batches, async (batch, i) => {
      await step(`kyc:${i}`, "kyc", () => contractCall(deployer, kyc, "batchVerify", [batch]));
    }, CONCURRENCY);
    if (demo) await step("mint:demo", "mint demo", () => contractCall(deployer, usdc, "mint", [demo.address, usd(100_000)]));
    await step("mint:maker", "mint maker", () => contractCall(deployer, usdc, "mint", [maker.address, usd(MAKER_CAPITAL_USD)]));
    await step("approve:maker", "approve maker", () => contractCall(maker, usdc, "approve", [A.PerpetualExchange, usd(MAKER_CAPITAL_USD)]));
    await step("deposit:maker", "deposit maker", () => contractCall(maker, exchange, "depositMargin", [usd(MAKER_CAPITAL_USD)]));

    const mintTrader = async (t: (typeof traders)[number]) => {
      await step(`mint:${t.index}`, `mint ${t.name}`, () => contractCall(deployer, usdc, "mint", [t.wallet.address, usd(t.capitalUsd + t.stakeUsd)]));
    };
    if (sender.parallel) {
      // 公開鏈：部署者的鑄幣連發，全部上鏈後各交易者自己的五筆平行。
      await forEach(true, traders, mintTrader, CONCURRENCY);
      await forEach(true, traders, traderSetup, CONCURRENCY);
    } else {
      for (const t of traders) {
        await mintTrader(t);
        await traderSetup(t);
      }
    }
    await forEach(sender.parallel, followers, async (f) => {
      const total = f.actions.reduce((sum, a) => sum + (a.amountUsd ?? 0), 0);
      if (total > 0) await step(`mint:follower:${f.index}`, `mint follower ${f.index}`, () => contractCall(deployer, usdc, "mint", [f.wallet.address, usd(total)]));
    }, CONCURRENCY);

    // 資金費率每 8 小時結算一次，格線從資產第一次被碰到的時間算起。若讓第一筆開倉決定格線，
    // 結算點會落在每天 21:00 的換倉時段裡——交易者剛平倉、還沒重開的那幾秒多空最失衡，
    // 少的那一邊一次領到最多 10 倍費率（小規模回放實測：Whale Alpha 的 sETH 30 天多領 180）。
    // 這裡先在第一天 17:00 碰一次每個資產（settleFunding 第一次只啟動時鐘），結算點就落在
    // 01:00／09:00／17:00，換倉時段裡不會結算，結算時的帳本都已被造市帳號拉平。
    // 公開鏈的時間是回放當下，整趟只有幾小時，資金費率幾乎不結算；照樣先啟動時鐘，順序與本機相同。
    if (!PUBLIC) await provider.send("evm_setNextBlockTimestamp", [schedule.days[0].timestamp - 4 * 3600]);
    for (const symbol of schedule.assets) {
      const key = `funding:${symbol}`;
      if (!journal.entry(key) && (await exchange.lastFundingUpdateAt(assetId(symbol))) !== 0n) {
        throw new Error(`${symbol}: funding clock already started; replay needs a fresh deployment`);
      }
      await step(key, `funding clock ${symbol}`, () => contractCall(deployer, exchange, "settleFunding", [assetId(symbol)]));
    }
    journal.finishSetup();
  } else {
    restoreOpen(journal.doc.open);
    console.log(`resuming at day ${firstDay + 1}/${dates.length} (${dates[firstDay] ?? "export"}); ${open.size} open positions`);
  }

  async function traderSetup(t: (typeof traders)[number]): Promise<void> {
    const w = t.wallet;
    await step(`approve-stake:${t.index}`, `approve stake ${t.name}`, () => contractCall(w, usdc, "approve", [A.TraderStake, usd(t.stakeUsd)]));
    await step(`stake:${t.index}`, `stake ${t.name}`, () => contractCall(w, stake, "stake", [usd(t.stakeUsd)]));
    await step(`register:${t.index}`, `register ${t.name}`, () => contractCall(w, registry, "registerTrader", [t.name]));
    await step(`approve-margin:${t.index}`, `approve margin ${t.name}`, () => contractCall(w, usdc, "approve", [A.PerpetualExchange, usd(t.capitalUsd)]));
    await step(`deposit:${t.index}`, `deposit ${t.name}`, () => contractCall(w, exchange, "depositMargin", [usd(t.capitalUsd)]));
  }

  // ── 逐日 ──────────────────────────────────────────────────────────────────
  for (let n = firstDay; n < schedule.days.length; n++) {
    const day = schedule.days[n];
    if (!PUBLIC) await provider.send("evm_setNextBlockTimestamp", [day.timestamp]);
    const { resumed } = journal.startDay(day.date, (await provider.getBlockNumber()) + 1);
    if (resumed) {
      const r = await journal.resolvePending(resolveEntry);
      console.log(`${day.date}: resuming an interrupted day (${r.resolved} in-flight tx resolved, ${r.dropped} never landed)`);
    }

    const rebalancing = traders.filter((t) => t.rebalances.some((r) => r.date === day.date));
    const acting = followers.filter((f) => f.actions.some((a) => a.date === day.date));
    await fundGas(day.date, [
      ...rebalancing.map((t) => {
        const legs = t.rebalances.find((r) => r.date === day.date)!.legs.length;
        return { address: t.wallet.address, txs: 2 * legs + 2, value: BigInt(legs) * executionFee };
      }),
      ...acting.map((f) => ({ address: f.wallet.address, txs: 3, value: BigInt(schedule.assets.length) * executionFee })),
      { address: maker.address, txs: 2 * schedule.assets.length, value: BigInt(schedule.assets.length) * executionFee },
    ]);

    await forEach(sender.parallel, schedule.assets, async (symbol) => {
      await step(`price:${symbol}`, `price ${symbol} ${day.date}`, () =>
        contractCall(deployer, oracle, "updatePrice", [assetId(symbol), BigInt(day.prices[symbol])]));
    }, CONCURRENCY);

    // 清算不會自己發生：每天把不健康的部位清掉。
    const ids = [...open.keys()];
    const values = await chunked(ids, 50, (id) => exchange.getPositionValue(id) as Promise<bigint>);
    await forEach(sender.parallel, ids, async (id, i) => {
      const p = open.get(id)!;
      if (!shouldLiquidate(values[i], p.margin, p.leverage, maintenanceBps[p.asset])) return;
      // getPositionValue 用的是封頂後的損益，清算閘門用的是結算損益；邊界上兩者會不一致
      // （完整回放遇過一次 PositionIsHealthy）。先 staticCall 問合約本身，它肯清才送。
      track(await step(`liquidate:${id}`, `liquidate ${id}`, async () => {
        const accepted = await exchange.connect(deployer.signer).getFunction("liquidatePosition").staticCall(id).then(() => true, () => false);
        return accepted ? contractCall(deployer, exchange, "liquidatePosition", [id]) : null;
      }));
    }, CONCURRENCY);

    await forEach(sender.parallel, rebalancing, async (t) => {
      const rebalance = t.rebalances.find((r) => r.date === day.date)!;
      const w = t.wallet;
      const held = await journal.plan(`held:${t.index}`, () => exchange.getUserPositions(w.address) as Promise<bigint[]>,
        idsCodec.encode, idsCodec.decode);
      // 平倉彼此獨立：公開鏈上同一個帳號連發，全部上鏈後再發布與開倉。
      await forEach(sender.parallel, held, async (id) => {
        track(await step(`close:${t.index}:${id}`, `close ${id}`, () => contractCall(w, exchange, "closePosition", [id])));
      }, CONCURRENCY);
      // 質押被罰沒到門檻以下的交易者不能再發布；他照樣換倉，只是鏈上的策略停在上一版。
      await step(`publish:${t.index}`, `publish ${t.name} ${day.date}`, async () => {
        if (await registry.isEligibleTrader(w.address)) {
          return contractCall(w, registry, "publishStrategy", [rebalance.legs.map((l) => ({
            asset: assetId(l.asset), weight: l.weightBps, isLong: l.isLong, leverage: l.leverage,
          }))]);
        }
        journal.skip(`publish:${day.date}:${t.index}`, `publish ${t.name} ${day.date}: stake below the minimum`);
        return null;
      });
      const orders = await journal.plan(`opens:${t.index}`,
        async () => planOpens((await exchange.freeMargin(w.address)) as bigint, rebalance.legs, feeBps),
        orderCodec.encode, orderCodec.decode);
      await forEach(sender.parallel, orders, async (order, k) => {
        track(await step(`open:${t.index}:${k}`, `open ${t.name} ${order.asset}`, () =>
          contractCall(w, exchange, "openPosition", [assetId(order.asset), order.isLong, order.margin, order.leverage], executionFee)));
      }, CONCURRENCY);
    }, CONCURRENCY);

    await forEach(sender.parallel, acting, async (f) => {
      for (const [k, action] of f.actions.entries()) {
        if (action.date !== day.date) continue;
        const trader = traderByIndex.get(action.traderIndex)!.wallet.address;
        if (action.type === "follow") {
          if (!journal.entry(`follow:${f.index}:${k}`) && !(await registry.isEligibleTrader(trader))) {
            journal.skip(`follow:${day.date}:${f.index}:${k}`, `follow ${f.index}->${action.traderIndex} ${day.date}: trader not eligible`);
            continue;
          }
          const amount = usd(action.amountUsd!);
          await step(`approve-follow:${f.index}:${k}`, `approve follow ${f.index}`, () => contractCall(f.wallet, usdc, "approve", [A.CopyTracker, amount]));
          track(await step(`follow:${f.index}:${k}`, `follow ${f.index}->${action.traderIndex}`, async () => {
            const [allocations] = await registry.getLatestStrategy(trader);
            return contractCall(f.wallet, copy, "followTrader", [trader, amount], executionFee * BigInt(allocations.length));
          }));
        } else {
          track(await step(`unfollow:${f.index}:${k}`, `unfollow ${f.index}->${action.traderIndex}`, async () => {
            const records: { trader: string; active: boolean }[] = await copy.getCopyRecords(f.wallet.address);
            const index = records.findIndex((r) => r.active && r.trader.toLowerCase() === trader.toLowerCase());
            if (index < 0) return null; // 跟隨那一步失敗過，沒有紀錄可取消
            return contractCall(f.wallet, copy, "unfollowAndCloseAll", [index]);
          }));
        }
      }
    }, CONCURRENCY);

    // 一天的換倉與跟單都做完之後，造市帳號把每個資產的多空名目拉平。
    await forEach(sender.parallel, schedule.assets, async (symbol) => {
      const id = assetId(symbol);
      const hedge = await journal.plan(`hedge:${symbol}`, async (): Promise<Hedge> => {
        const total = {
          long: (await exchange.globalLongNotional(id)) as bigint,
          short: (await exchange.globalShortNotional(id)) as bigint,
        };
        const mine = [...open.entries()].filter(([, p]) => p.owner === maker.address.toLowerCase() && p.asset === symbol);
        const held = { long: 0n, short: 0n };
        for (const [, p] of mine) held[p.isLong ? "long" : "short"] += p.margin * p.leverage;
        const order = planHedge(total, held);
        return order && { closeIds: mine.map(([positionId]) => positionId), open: order.open };
      }, hedgeCodec.encode, hedgeCodec.decode);
      if (!hedge) return;
      await forEach(sender.parallel, hedge.closeIds, async (positionId) => {
        track(await step(`maker-close:${positionId}`, `maker close ${positionId}`, () => contractCall(maker, exchange, "closePosition", [positionId])));
      }, CONCURRENCY);
      if (hedge.open) {
        const { isLong, margin } = hedge.open;
        track(await step(`maker-open:${symbol}`, `maker open ${symbol}`, () =>
          contractCall(maker, exchange, "openPosition", [id, isLong, margin, 1n], executionFee)));
      }
    }, CONCURRENCY);

    // 一個月的跟單費與績效費都進來之後，退役在這個月的最後一天發生，紀錄帶著模擬月份的時間。
    if (isLastDayOfMonth(dates, n)) await crankCarbonMonth(day.date, deployer);
    await recycleExecutionFees("recycle");

    const toBlock = await provider.getBlockNumber();
    journal.finishDay(toBlock, (await provider.getBlock(toBlock))!.timestamp, encodeOpen());
    const s = journal.doc.stats;
    if (n % 30 === 0 || PUBLIC) console.log(`${day.date}  open=${open.size}  sent=${s.sent}  failed=${s.failed}`);
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

  // 本機：整條鏈只有這次回放，一次查完。公開鏈：只查這次回放自己的區塊，分段查（節點限制單次範圍）。
  const ranges: { fromBlock: number; toBlock: number | "latest" }[] = [];
  if (PUBLIC) {
    const last = journal.doc.days[journal.doc.days.length - 1].toBlock;
    for (let from = journal.doc.setupFromBlock!; from <= last; from += LOG_CHUNK) {
      ranges.push({ fromBlock: from, toBlock: Math.min(from + LOG_CHUNK - 1, last) });
    }
  } else {
    ranges.push({ fromBlock: 0, toBlock: "latest" });
  }
  const events = [];
  for (const contract of [exchange, registry, copy, splitter, retirement]) {
    const address = await contract.getAddress();
    const logs: ethers.Log[] = [];
    for (const range of ranges) logs.push(...(await provider.getLogs({ address, ...range })));
    for (const log of logs) {
      const parsed = contract.interface.parseLog(log);
      if (!parsed) continue;
      const fields: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        const value = parsed.args[i];
        fields[input.name] = input.name === "asset" ? symbolOf.get(value)
          : typeof value === "bigint" ? value.toString() : value;
      });
      if (parsed.name === "PositionOpened") {
        // 開倉時凍結的費率：分析估算未平倉部位的價值時要扣平倉手續費與借款費
        const position = await exchange.getPosition(parsed.args.positionId);
        fields.tradingFeeBps = position.tradingFeeBps.toString();
        fields.borrowFeeBpsPerHour = position.borrowFeeBpsPerHour.toString();
      }
      if (parsed.name === "StrategyPublished") {
        const [legs] = await registry.getStrategyVersion(parsed.args.trader, parsed.args.versionId);
        fields.legs = legs.map((l: { asset: string; weight: bigint; isLong: boolean; leverage: bigint }) => ({
          asset: symbolOf.get(l.asset), weightBps: Number(l.weight), isLong: l.isLong, leverage: Number(l.leverage),
        }));
      }
      events.push({ name: parsed.name, block: log.blockNumber, logIndex: log.index, timestamp: 0, tx: log.transactionHash, args: fields });
    }
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const blocks = [...new Set(events.map((e) => e.block))];
  const stamps = new Map(await chunked(blocks, 100, async (b) => [b, (await provider.getBlock(b))!.timestamp] as const));
  for (const e of events) e.timestamp = stamps.get(e.block)!;

  const stats = journal.doc.stats;
  writeFileSync(args.outPath, JSON.stringify({
    // 2：加上 timeCompressed 與 days（每個模擬日的區塊範圍）。
    schemaVersion: 2, chainId: Number(chainId), range: { from: schedule.start, to: schedule.end },
    // 公開鏈上的區塊時間是回放當天：分析要用 days 還原模擬日期（#344）。
    timeCompressed: PUBLIC, days: journal.doc.days,
    marketMaker: maker.address, stats, traders: traderDocs, events,
    // 對帳用：鏈上的累計退役噸數（1e18 = 1 公噸模擬碳權）要等於 CarbonRetired 事件的總和。
    carbon: {
      retirement: A.CarbonRetirement,
      totalRetiredTonnes: ((await retirement.totalRetiredTonnes()) as bigint).toString(),
    },
  }) + "\n");

  const ratio = stats.sent === 0 ? 0 : stats.failed / stats.sent;
  console.log(`replayed ${schedule.days.length} days: ${stats.sent} tx, ${stats.failed} failed (${(ratio * 100).toFixed(2)}%), ${events.length} events -> ${args.outPath}`);
  for (const line of stats.failures.slice(0, 10)) console.log(`  failed: ${line}`);
  if (PUBLIC) console.log(`deployer ${deployer.address}: ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH left`);
  if (ratio > 0.01) {
    console.error("more than 1% of transactions failed: this replay does not count");
    process.exit(1);
  }
}

/**
 * 公開鏈：送出任何交易之前先核對（全部唯讀），再要求輸入確認字句。
 * 交易所讀的 oracle 必須是部署者持有的專用 MockOracle（ORACLE_KIND=fresh）——寫 2024 年的價格
 * 不能寫到共用的那一顆，否則公開站的價格會亂跳幾個小時。
 */
async function preflightPublic(deployer: Account, firstDay: number, totalDays: number): Promise<void> {
  const ownerOf = (address: string) => new ethers.Contract(address, OWNABLE, provider).owner() as Promise<string>;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const exchangeOracle = (await new ethers.Contract(A.PerpetualExchange, ["function oracle() view returns (address)"], provider).oracle()) as string;
  const problems: string[] = [];
  if (!same(exchangeOracle, A.MockOracle)) problems.push(`exchange reads oracle ${exchangeOracle}, addresses file says ${A.MockOracle}`);
  if (same(A.MockOracle, SHARED_MOCK_ORACLE)) problems.push("the exchange reads the SHARED MockOracle: redeploy with ORACLE_KIND=fresh");
  for (const [name, address] of [["MockOracle", A.MockOracle], ["KYCRegistry", A.KYCRegistry], ["MockUSDC", A.MockUSDC]] as const) {
    const owner = await ownerOf(address);
    if (!same(owner, deployer.address)) problems.push(`${name} ${address} is owned by ${owner}, not the deployer ${deployer.address}`);
  }
  if (problems.length) throw new Error(`refusing to replay:\n  - ${problems.join("\n  - ")}`);

  const url = new URL(RPC);
  console.log([
    "",
    "=== public-chain replay (#344) ===",
    `chain      : 84532 (Base Sepolia) via ${url.host}`,
    `deployer   : ${deployer.address}  ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`,
    `exchange   : ${A.PerpetualExchange}`,
    `oracle     : ${A.MockOracle} (dedicated, owned by the deployer)`,
    `schedule   : ${schedule.start} .. ${schedule.end}, ${schedule.traders.length} traders, ${schedule.followers.length} followers`,
    `progress   : ${args.progressPath} — ${firstDay === 0 && !journal.doc.setupDone ? "new run" : `resume at day ${firstDay + 1}/${totalDays}`}`,
    "Every transaction is real and public. Prices on this exchange's oracle will be 2024's until the replay ends.",
    "",
  ].join("\n"));
  const answer = await ask(`type "${CONFIRM_PHRASE}" to start: `);
  if (answer === null || !confirmed(answer)) throw new Error("not confirmed: nothing was sent");
}

// 明確結束：provider 的連線會讓行程掛著不退出，後面的腳本就等不到它。
main().then(() => { closePrompts(); process.exit(0); }).catch((e) => { closePrompts(); console.error(e); process.exit(1); });
