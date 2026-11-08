// x402-copy-agent.ts — 收到「交易者發布新版」通知後，用 x402 付費買訊號、確認版號，再替跟隨者同步部位。
//
//   cd agent
//   npx tsx examples/x402-copy-agent.ts --followers 0xYourFollower --dry-run   # 不付款、不送交易、不讀金鑰
//   npx tsx examples/x402-copy-agent.ts --followers 0xYourFollower             # 真跑
//
// 說明與前提見 examples/x402-copy-agent.md；判斷邏輯在 x402-copy-agent-core.ts。
import "../shared/src/autoload-env.ts";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { formatUsdcAtomic, guardViemAccount, meteredFetch, resolveSettlementToken, resolveX402MaxValue } from "@pepelab/shared";
import { getAddresses } from "../../frontend/src/contracts/addresses.ts";
import { followerFootprint, makeChainReads, makeExecutor, supportsAutoSync, supportsSyncExecutor, trackerRegistry } from "../copy-sync/src/chain.ts";
import { ExecutorWallet } from "../copy-sync/src/guard.ts";
import { describeKeySource, executorFollowerError, executorKeySpec, keyPolicyError, loadExecutorKey } from "../copy-sync/src/keys.ts";
import { errText, makeRedactor } from "../copy-sync/src/log.ts";
import { acquireProcessLock } from "../copy-sync/src/state.ts";
import { LocalNonceSigner } from "../keeper/nonceSigner.ts";
import {
  blockedLines,
  captureAuthorizations,
  createWebhookServer,
  loadLedger,
  makeRetryScheduler,
  makeSerialQueue,
  makeSignalPayer,
  processNotice,
  saveLedger,
  type AgentConfig,
  type NewVersionNotice,
  type PayAttempt,
} from "./x402-copy-agent-core.ts";

const USAGE = `用法：npx tsx examples/x402-copy-agent.ts --followers 0x..,0x.. [選項]
  --followers 0x..,0x..   只處理這些跟隨者的通知（env COPY_SYNC_FOLLOWERS）
  --dry-run               只讀鏈與模擬：不付款、不送交易、不寫狀態檔、不讀金鑰
  --port N                webhook 埠（只綁 127.0.0.1；預設 8402，env X402_COPY_AGENT_PORT）
  --tracker 0x..          CopyTracker（預設讀 frontend/src/contracts/addresses.ts）
  --state-file PATH       去重紀錄（預設 agent/.state/x402-copy-agent/<chainId>-<tracker>.json）
  --allow-plaintext-key   公開鏈上允許執行者用明文 COPY_SYNC_PRIVATE_KEY（同 copy-sync）
環境變數：COPY_SYNC_RPC_URL（或 BASE_SEPOLIA_RPC_URL）；真跑另需 X402_API_URL、AGENT_PRIVATE_KEY、
COPY_SYNC_KEYSTORE（或 COPY_SYNC_PRIVATE_KEY）；X402_MAX_PAYMENT_USDC 是單筆付費上限。
真跑只接受 Base Sepolia（chainId 84532）：x402 付款在 Base Sepolia，讀鏈、送交易、付款簽章都用同一個 RPC。`;

const die = (msg: string): never => {
  console.error(`x402-copy-agent：${msg}`);
  process.exit(1);
};

function parseFollowers(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    // 不把錯誤的值印出來：最常見的打錯是把私鑰貼到這裡。
    if (!ethers.isAddress(part) || ethers.getAddress(part) === ethers.ZeroAddress) die("--followers 含不合法的地址");
    out.add(ethers.getAddress(part).toLowerCase());
  }
  return [...out];
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        followers: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        port: { type: "string" },
        tracker: { type: "string" },
        "state-file": { type: "string" },
        "allow-plaintext-key": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values;
  } catch {
    die(`參數不對。\n${USAGE}`);
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const followers = parseFollowers(args.followers ?? process.env.COPY_SYNC_FOLLOWERS ?? "");
  if (followers.length === 0) die(`需要 --followers。\n${USAGE}`);
  const port = Number(args.port ?? process.env.X402_COPY_AGENT_PORT ?? 8402);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die("--port 必須是 1–65535");
  const dryRun = args["dry-run"]!;
  const rpcUrl = process.env.COPY_SYNC_RPC_URL?.trim() || process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
  const redact = makeRedactor([rpcUrl]);

  // ── 鏈 ──
  const probe = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
  let chainId = 0;
  try {
    chainId = Number((await probe.getNetwork()).chainId);
  } catch (e) {
    die(`連不上 RPC：${errText(e, redact)}`);
  } finally {
    probe.destroy();
  }
  // 付款錢包簽的是 Base Sepolia USDC；RPC 若指到別條鏈，付款與同步會分在兩條鏈上。
  if (!dryRun && chainId !== baseSepolia.id) die(`真跑只支援 Base Sepolia（${baseSepolia.id}），RPC 是 chainId ${chainId}`);
  const provider = new ethers.JsonRpcProvider(rpcUrl, ethers.Network.from(chainId), { batchMaxCount: 1, staticNetwork: true });
  const registered = getAddresses(chainId)?.CopyTracker;
  const trackerRaw = args.tracker ?? registered;
  if (!trackerRaw || !ethers.isAddress(trackerRaw)) return die(`chainId ${chainId} 沒有登記 CopyTracker，請用 --tracker 指定`);
  const tracker = ethers.getAddress(trackerRaw);
  if (!(await supportsAutoSync(provider, tracker))) die(`CopyTracker ${tracker} 不是自動同步版（讀不到 totalSyncGas）`);
  const hasSyncExecutor = await supportsSyncExecutor(provider, tracker);
  const registry = await trackerRegistry(provider, tracker);

  // ── 金鑰（dry-run 完全不碰）──
  let signer: LocalNonceSigner | null = null;
  let wallet: ExecutorWallet | null = null;
  let executorAddress: string | null = null;
  let pay: (trader: string) => Promise<PayAttempt> = () => Promise.reject(new Error("dry-run 不付款"));
  let authUsed: ((from: string, nonce: string) => Promise<boolean>) | undefined;
  if (!dryRun) {
    const api = process.env.X402_API_URL?.trim().replace(/\/$/, "");
    if (!api || !/^https?:\/\//.test(api)) die("真跑需要 X402_API_URL");
    const pk = process.env.AGENT_PRIVATE_KEY?.trim();
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return die("真跑需要 AGENT_PRIVATE_KEY（付款錢包，持 Base Sepolia 官方 USDC）");
    const account = guardViemAccount(privateKeyToAccount(pk as Hex));

    const spec = executorKeySpec(process.env);
    if ("error" in spec) return die(spec.error);
    const allowPlaintextKey = args["allow-plaintext-key"]!;
    const before = keyPolicyError({ spec: spec.spec, chainId, allowPlaintextKey, address: null });
    if (before) die(before);
    let key: ethers.SigningKey;
    try {
      key = await loadExecutorKey(spec.spec);
    } catch (e) {
      return die((e as Error).message);
    }
    wallet = new ExecutorWallet(key, { copyTracker: tracker, chainId }, provider);
    executorAddress = wallet.address;
    const after = keyPolicyError({ spec: spec.spec, chainId, allowPlaintextKey, address: wallet.address });
    if (after) die(after);
    // 跟隨者主錢包的私鑰不交給 agent（copy-sync README「金鑰模型」）。執行者另外查足跡，規則同 copy-sync/src/run.ts。
    for (const [label, addr] of [["執行者", wallet.address], ["付款", account.address]] as const) {
      if (followers.includes(addr.toLowerCase())) die(`${label}錢包 ${addr} 就是要服務的跟隨者：跟隨者主錢包的私鑰不該交給 agent`);
    }
    const why = executorFollowerError({ address: wallet.address, tracker, ...(await followerFootprint(provider, tracker, wallet.address)) });
    if (why) die(why);
    if (wallet.address.toLowerCase() === account.address.toLowerCase()) {
      console.warn("提醒：付款錢包與執行者熱錢包是同一把；建議分開（執行者只放少量 gas ETH）");
    }
    if ((await provider.getBalance(wallet.address)) === 0n) die("執行者熱錢包沒有 gas ETH");
    signer = new LocalNonceSigner(wallet);

    const client = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) }).extend(publicActions);
    const capture = captureAuthorizations();
    const meter = meteredFetch(capture.fetch);
    const usdc = new ethers.Contract(resolveSettlementToken(), ["function authorizationState(address,bytes32) view returns (bool)"], provider);
    authUsed = async (from, nonce) => Boolean(await usdc.getFunction("authorizationState")(from, nonce));
    const payFetch = wrapFetchWithPayment(
      meter.fetch,
      client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
      resolveX402MaxValue(),
    ) as unknown as typeof fetch;
    pay = makeSignalPayer({ api: api!, payFetch, meter, redact, drainAuthorizations: capture.drain });
    console.log(`執行者 ${wallet.address}（${describeKeySource(spec.spec)}；只能簽 resyncFor）`);
    console.log(`付款 ${account.address}  ${api}`);
  }

  // ── 狀態（去重）──
  const agentRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
  const statePath = args["state-file"] ?? resolve(agentRoot, ".state", "x402-copy-agent", `${chainId}-${tracker.toLowerCase()}.json`);
  let release = () => {};
  if (!dryRun) {
    try {
      release = acquireProcessLock(statePath);
    } catch (e) {
      die((e as Error).message);
    }
  }
  let ledger;
  try {
    ledger = loadLedger(statePath);
  } catch (e) {
    release();
    return die(`狀態檔 ${statePath} 讀取失敗：${(e as Error).message}`);
  }

  const cfg: AgentConfig = { chainId, copyTracker: tracker, followers };
  const exec = makeExecutor({
    provider,
    tracker,
    signer,
    address: executorAddress,
    renewSigner: wallet ? () => new LocalNonceSigner(wallet!) : undefined,
  });
  const print = (line: string) => console.log(redact(line));
  const explorer = chainId === 84532 ? "https://sepolia.basescan.org/tx/" : null;
  const deps = {
    reads: makeChainReads(provider, tracker, registry, { hasSyncExecutor }),
    exec,
    pay,
    ledger,
    persist: dryRun ? () => {} : (l: typeof ledger) => saveLedger(statePath, l),
    print,
    redact,
    txLink: (h: string) => (explorer ? `${explorer}${h}` : h),
    dryRun,
    txTimeoutMs: 120_000,
    authUsed,
  };

  // 冷卻中的通知：冷卻結束後自動再排入佇列（copy-sync 不會為同一版再通知一次）。
  const retries = makeRetryScheduler((n) => {
    if (!queue.push(n)) print(`冷卻結束要重試，但佇列已滿：跟隨者 ${n.follower}#${n.recordIdx} versionId ${n.toVersion} 請重新觸發`);
  });
  const queue = makeSerialQueue<NewVersionNotice>(
    async (n) => {
      const o = await processNotice(deps, n);
      if (o.code === "cooldown" && o.retryInSec !== undefined) {
        const wait = retries.schedule(n, o.retryInSec);
        if (wait !== null) print(`   已排程：約 ${Math.ceil(wait / 60)} 分鐘後（${new Date(Date.now() + wait * 1000).toLocaleString()}）自動再試，agent 要保持開著`);
      }
      print("");
    },
    (e) => print(`處理通知時發生錯誤：${errText(e, redact)}`),
  );
  const server = createWebhookServer(
    cfg,
    (n) => queue.push(n),
    (r) => print(`拒絕一則通知（HTTP ${r.status}）：${r.message}`),
    (b) => print([...blockedLines(b), ""].join("\n")),
  );

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    server.close();
    retries.cancelAll();
    // 付款或同步進行中就等它做完；再按一次立即結束（狀態檔已先記下，重啟也不會重付）。
    void queue.idle().finally(() => {
      release();
      provider.destroy();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  server.on("error", (e) => {
    release();
    die(`無法監聽 127.0.0.1:${port}：${(e as Error).message}`);
  });
  server.listen(port, "127.0.0.1", () => {
    print(`監聽 http://127.0.0.1:${port}/webhook  chainId ${chainId}  CopyTracker ${tracker}`);
    print(`跟隨者白名單 ${followers.length} 位  單筆付費上限 ${formatUsdcAtomic(resolveX402MaxValue())} USDC${dryRun ? "  [dry-run：不付款、不送交易]" : ""}`);
    print("");
  });
}

main().catch((e) => {
  console.error(`x402-copy-agent 中止：${errText(e, makeRedactor([process.env.COPY_SYNC_RPC_URL, process.env.BASE_SEPOLIA_RPC_URL]), 400)}`);
  process.exit(1);
});
