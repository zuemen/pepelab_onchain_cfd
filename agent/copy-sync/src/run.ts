// 跟單自動同步執行者（ADR-024）。
//
//   cd agent
//   npm run copy-sync -- --once --dry-run                      # 只模擬，不需要金鑰
//   npm run copy-sync -- --once --notify-only --followers 0x.. --notify-webhook https://…
//                                                              # 只通知本人、不送交易、不需要金鑰（可掛 cron）
//   npm run copy-sync -- --mode personal --followers 0x..      # 只服務自己的跟隨地址
//   npm run copy-sync                                          # public：服務所有開了自動同步的人
//
// 說明、金鑰模型與 cron 範例見 agent/copy-sync/README.md。
import "../../shared/src/autoload-env.ts";

import { ethers } from "ethers";
import { getAddresses } from "../../../frontend/src/contracts/addresses.ts";
import { LocalNonceSigner } from "../../keeper/nonceSigner.ts";
import { parseCli, USAGE, type CliConfig } from "./args.ts";
import {
  followerFootprint,
  makeChainReads,
  makeExecutor,
  supportsAutoSync,
  supportsSyncExecutor,
  trackerRegistry,
} from "./chain.ts";
import { CopySyncEngine, exitCodeOf, summarize } from "./engine.ts";
import { ExecutorWallet } from "./guard.ts";
import {
  ANVIL_CHAIN_ID,
  describeKeySource,
  executorFollowerError,
  executorKeySpec,
  keyPolicyError,
  loadExecutorKey,
} from "./keys.ts";
import { consoleLogger, errText, makeRedactor, type Logger } from "./log.ts";
import { makeWebhookNotifier, noopNotifier, webhookUrlError } from "./notify.ts";
import {
  acquireProcessLock,
  bindingMismatch,
  defaultStatePath,
  emptyState,
  loadState,
  saveState,
  scopeOf,
} from "./state.ts";

/** 公開鏈上，熱錢包餘額超過這個值就提醒（執行者只需要少量 gas ETH）。 */
const HOT_WALLET_WARN_WEI = ethers.parseEther("0.05");

/** main() 之外的例外處理也要遮蔽指令列給的 RPC／webhook。 */
let activeRedact = makeRedactor([process.env.COPY_SYNC_RPC_URL, process.env.COPY_SYNC_NOTIFY_WEBHOOK]);

function die(log: Logger, msg: string): never {
  log.error(msg);
  process.exit(1);
}

async function main(): Promise<void> {
  let cli: CliConfig;
  const bootRedact = makeRedactor([]);
  const bootLog = consoleLogger(bootRedact);
  try {
    cli = parseCli(process.argv.slice(2), process.env);
  } catch (e) {
    die(bootLog, (e as Error).message);
  }
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  const redact = makeRedactor([cli.rpcUrl, cli.notifyWebhook ?? undefined]);
  activeRedact = redact;
  const log = consoleLogger(redact);
  if (cli.notifyWebhook) {
    const why = webhookUrlError(cli.notifyWebhook);
    if (why) die(log, why);
  } else if (cli.notifyOnly) {
    log.warn("--notify-only 沒有搭配 --notify-webhook：通知只會寫進日誌");
  }
  // 不送交易的兩種模式：dry-run（試跑，不寫狀態檔）與只通知（寫狀態檔、可排程）。兩者都不讀金鑰。
  const sends = !cli.dryRun && !cli.notifyOnly;

  // ── 鏈 ──
  const probe = new ethers.JsonRpcProvider(cli.rpcUrl, undefined, { batchMaxCount: 1 });
  let chainId: number;
  try {
    chainId = Number((await probe.getNetwork()).chainId);
  } catch (e) {
    die(log, `連不上 RPC：${errText(e, redact)}`);
  } finally {
    probe.destroy();
  }
  if (cli.chainId !== null && cli.chainId !== chainId) die(log, `RPC 回報 chainId ${chainId}，與 --chain-id ${cli.chainId} 不符`);
  // batchMaxCount: 1：公開節點對 JSON-RPC batch 的處理不穩（同 shared/provider.ts）。
  const provider = new ethers.JsonRpcProvider(cli.rpcUrl, ethers.Network.from(chainId), { batchMaxCount: 1, staticNetwork: true });

  const tracker = cli.tracker ?? (getAddresses(chainId)?.CopyTracker ? ethers.getAddress(getAddresses(chainId)!.CopyTracker) : null);
  if (!tracker) die(log, `chainId ${chainId} 沒有登記 CopyTracker 位址，請用 --tracker 指定`);
  if (!(await supportsAutoSync(provider, tracker))) {
    die(
      log,
      `CopyTracker ${tracker} 不是自動同步版（讀不到 totalSyncGas）：這條鏈上還沒部署 ADR-024 的 tracker，` +
        `或 --tracker 指錯了。部署步驟見 docs/OWNER_ACTIONS.md「部署自動同步版 CopyTracker」`,
    );
  }
  let hasSyncExecutor: boolean;
  try {
    hasSyncExecutor = await supportsSyncExecutor(provider, tracker);
  } catch (e) {
    die(log, `讀不到 tracker.syncExecutor()：${errText(e, redact)}`);
  }
  if (!hasSyncExecutor) {
    log.warn(
      `CopyTracker ${tracker} 沒有 syncExecutor（指定執行者之前的版本）：每筆跟單一律視為「任何人都能代為同步」；` +
        `personal 模式無法只讓自己的 agent 執行，建議照 docs/OWNER_ACTIONS.md 第 8 步部署最新版`,
    );
  }
  let registry: string;
  try {
    const onChain = await trackerRegistry(provider, tracker);
    if (cli.registry && cli.registry !== onChain) {
      die(log, `--registry ${cli.registry} 與 tracker.registry() ${onChain} 不同：執行者必須監聽 tracker 實際讀的那一個 registry`);
    }
    registry = onChain;
  } catch (e) {
    die(log, `讀不到 tracker.registry()：${errText(e, redact)}`);
  }

  // ── 金鑰（dry-run／只通知模式完全不碰金鑰）──
  let signer: LocalNonceSigner | null = null;
  let wallet: ExecutorWallet | null = null;
  let executorAddress: string | null = null;
  if (sends) {
    const r = executorKeySpec(process.env);
    if ("error" in r) die(log, r.error);
    const before = keyPolicyError({ spec: r.spec, chainId, allowPlaintextKey: cli.allowPlaintextKey, address: null });
    if (before) die(log, before);
    let key: ethers.SigningKey;
    try {
      key = await loadExecutorKey(r.spec);
    } catch (e) {
      die(log, (e as Error).message);
    }
    wallet = new ExecutorWallet(key, { copyTracker: tracker, chainId }, provider);
    executorAddress = wallet.address;
    const after = keyPolicyError({ spec: r.spec, chainId, allowPlaintextKey: cli.allowPlaintextKey, address: wallet.address });
    if (after) die(log, after);
    if (cli.followers.includes(wallet.address.toLowerCase())) {
      die(
        log,
        `執行者位址 ${wallet.address} 就是你要服務的跟隨者：這代表你把跟隨者主錢包的私鑰交給了 bot。` +
          `請另外產生一把只放少量 gas ETH 的執行者熱錢包（README「金鑰模型」）`,
      );
    }
    // 不論模式：這把金鑰在 tracker 上有任何跟單紀錄或油箱餘額，就是某位跟隨者的主錢包（持有 USDC 部位與
    // 油箱），不是只放 gas 的熱錢包——拒絕啟動。讀不到就不啟動（無法確認時不讓它常駐）。
    try {
      const fp = await followerFootprint(provider, tracker, wallet.address);
      const why = executorFollowerError({ address: wallet.address, tracker, ...fp });
      if (why) die(log, why);
    } catch (e) {
      die(log, `讀不到執行者位址在 tracker 上的跟單紀錄與油箱，無法確認這把金鑰不是跟隨者的主錢包：${errText(e, redact)}`);
    }
    log.info(`執行者 ${wallet.address}（${describeKeySource(r.spec)}；只能簽 ${tracker}.resyncFor）`);
    const bal = await provider.getBalance(wallet.address);
    log.info(`執行者餘額 ${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) die(log, "執行者錢包餘額為 0，無法送出任何交易（請轉入少量 gas ETH）");
    if (chainId !== ANVIL_CHAIN_ID && bal > HOT_WALLET_WARN_WEI) {
      log.warn(`執行者熱錢包餘額 ${ethers.formatEther(bal)} ETH 偏高：它只需要少量 gas，多的請轉走`);
    }
    signer = new LocalNonceSigner(wallet);
  } else if (cli.notifyOnly) {
    log.info("notify-only：只通知、不送交易、不讀任何金鑰；狀態檔照常寫（每一版只通知一次）");
  } else {
    log.info("dry-run：只模擬、不送交易、不寫狀態檔、不讀任何金鑰");
  }

  // ── 狀態 ──
  const scope = scopeOf(cli.mode, cli.followers, cli.notifyOnly);
  const binding = { chainId, copyTracker: tracker, registry, scope };
  const statePath = cli.stateFile ?? defaultStatePath(chainId, tracker, scope);
  let release: () => void = () => {};
  const writesState = !cli.dryRun;
  if (writesState) {
    try {
      release = acquireProcessLock(statePath);
    } catch (e) {
      die(log, (e as Error).message);
    }
  }
  let state;
  try {
    state = loadState(statePath) ?? emptyState(binding);
  } catch (e) {
    release();
    die(log, `狀態檔 ${statePath} 讀取失敗：${(e as Error).message}（確認無誤後可刪除它重新開始）`);
  }
  const mismatch = bindingMismatch(state, binding);
  if (mismatch) {
    release();
    die(log, `${mismatch}；請用另一個 --state-file，或確認後刪除 ${statePath}`);
  }

  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    log.info("收到停止訊號：這一筆處理完就結束（再按一次立即結束）");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const engine = new CopySyncEngine({
    cfg: {
      mode: cli.mode,
      followers: cli.followers,
      chainId,
      copyTracker: tracker,
      registry,
      // 只通知模式也不送交易：引擎沿用 dry-run 的路徑，另外在模擬成功時通知本人。
      dryRun: !sends,
      notifyOnly: cli.notifyOnly,
      confirmations: cli.confirmations ?? (chainId === ANVIL_CHAIN_ID ? 0 : 2),
      startBlock: cli.fromBlock,
      lookbackBlocks: cli.lookbackBlocks,
      rescanIntervalSec: cli.rescanSec,
      minTipWei: cli.minTipWei,
      maxGasPriceWei: cli.maxGasPriceWei,
      maxSendsPerRound: cli.maxSendsPerRound,
      txTimeoutMs: cli.txTimeoutSec * 1000,
    },
    reads: makeChainReads(provider, tracker, registry, { hasSyncExecutor }),
    exec: makeExecutor({
      provider,
      tracker,
      signer,
      address: executorAddress,
      // nonce 在本機遞增（keeper/nonceSigner.ts 的事故說明）；放棄等待狀態未知的交易時換一個新的重新對齊。
      renewSigner: wallet ? () => new LocalNonceSigner(wallet!) : undefined,
    }),
    state,
    persist: writesState ? (s) => saveState(statePath, s) : () => {},
    log,
    redact,
    notify: cli.notifyWebhook ? makeWebhookNotifier(cli.notifyWebhook, { onError: (m) => log.warn(m) }) : noopNotifier,
    shouldStop: () => stopping,
  });

  log.info(
    `copy-sync 啟動：mode=${cli.mode}${cli.mode === "personal" ? `（${cli.followers.length} 個地址）` : ""} chainId=${chainId} ` +
      `tracker=${tracker} registry=${registry}${cli.dryRun ? " dry-run" : ""}${cli.notifyOnly ? " notify-only" : ""}` +
      `${cli.once ? " once" : ""}${cli.notifyWebhook ? " notify=webhook" : ""}${writesState ? ` state=${statePath}` : ""}`,
  );

  let failures = 0;
  for (;;) {
    let code = 0;
    try {
      const rep = await engine.runRound();
      log.info(summarize(rep));
      code = exitCodeOf(rep);
      failures = 0;
    } catch (e) {
      code = 1;
      failures += 1;
      log.error(`這一輪中止：${errText(e, redact)}`);
    }
    if (cli.once || stopping) {
      release();
      provider.destroy();
      process.exit(cli.once ? code : 0);
    }
    // 連續整輪失敗（RPC 掛了）時拉長間隔，最多 10 分鐘。
    const waitMs = Math.min(cli.intervalSec * 1000 * 2 ** Math.min(failures, 5), 600_000);
    const until = Date.now() + waitMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
    if (stopping) {
      release();
      provider.destroy();
      process.exit(0);
    }
  }
}

main().catch((e) => {
  console.error(`::error::copy-sync 未預期地中止：${errText(e, activeRedact, 400)}`);
  process.exit(1);
});
