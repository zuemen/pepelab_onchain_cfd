// 指令列與環境變數解析（純函式，可單元測試）。
//
// 每個選項都可以用旗標或環境變數給，旗標優先。秘密（RPC 網址、webhook）建議用環境變數：
// 指令列參數會出現在 `ps` 與 shell history 裡。
import { ethers } from "ethers";

export interface CliConfig {
  mode: "public" | "personal";
  followers: string[];
  rpcUrl: string;
  /** 使用者宣告的 chainId；null＝以 RPC 回報的為準（仍會與位址表核對）。 */
  chainId: number | null;
  tracker: string | null;
  registry: string | null;
  fromBlock: number | null;
  lookbackBlocks: number;
  confirmations: number | null;
  intervalSec: number;
  rescanSec: number;
  minTipWei: bigint;
  maxGasPriceWei: bigint | null;
  maxSendsPerRound: number;
  txTimeoutSec: number;
  stateFile: string | null;
  notifyWebhook: string | null;
  dryRun: boolean;
  /** 只通知、不送交易、不讀金鑰；照常寫狀態檔（游標與「每一版只通知一次」的去重）。只限 personal 模式。 */
  notifyOnly: boolean;
  once: boolean;
  allowPlaintextKey: boolean;
  help: boolean;
}

export const USAGE = `用法：npm run copy-sync -- [選項]

模式
  --mode public|personal      public：服務所有開了自動同步的跟隨者（賺小費）；
                              personal：只服務 --followers 列出的地址（給跟隨者自己的 agent）。
                              有給 --followers 時預設 personal，否則 public。
  --followers 0x..,0x..       personal 模式服務的跟隨者地址（env COPY_SYNC_FOLLOWERS）

鏈與合約
  --rpc-url URL               RPC（env COPY_SYNC_RPC_URL，退回 BASE_SEPOLIA_RPC_URL）。建議用環境變數。
  --chain-id N                預期的 chainId；與 RPC 不符就拒絕啟動（env COPY_SYNC_CHAIN_ID）
  --tracker 0x..              自動同步版 CopyTracker（env COPY_SYNC_TRACKER；預設讀 frontend 位址表）
  --registry 0x..             StrategyRegistry（env COPY_SYNC_REGISTRY；預設讀 tracker.registry()）

掃描與排程
  --from-block N              第一次執行（沒有狀態檔）時從哪一塊開始掃
  --lookback-blocks N         沒給 --from-block 時往回掃幾塊（預設 43200 ≈ Base 上 24 小時）
  --confirmations N           只掃到 head−N（預設：Anvil 0、其他 2）
  --interval-sec N            常駐模式每輪間隔（預設 30）
  --rescan-sec N              多久全面重掃一次追蹤中的 record（預設 600）
  --state-file PATH           狀態檔（預設 agent/.state/copy-sync/<chainId>-<tracker>-<mode>.json）
  --once                      跑一輪就結束（cron／GitHub Actions 用）；有讀取或交易失敗時 exit 1
  --dry-run                   只模擬、不送交易、不寫狀態檔；沒有金鑰也能跑。每次都從頭掃、通知不去重，
                              只適合手動試跑；排程請用 --notify-only
  --notify-only               只通知、不送交易、不讀任何金鑰（env COPY_SYNC_NOTIFY_ONLY=1）。照常寫狀態檔，
                              交易者每發一版只通知一次、被擋原因相同也只通知一次，可以直接掛 cron。
                              只限 personal 模式（--followers 你自己的地址）；通常搭配 --notify-webhook

送出
  --min-tip-wei N             public 模式：小費低於這個值的 record 不服務（預設 0）
  --max-gas-gwei X            gas 價格上限，超過就延後（預設不限）
  --max-sends-per-round N     每輪最多送幾筆（預設 10）
  --tx-timeout-sec N          等確認的上限（預設 120）

金鑰（只放執行者自己的熱錢包，永遠不要放跟隨者的私鑰）
  COPY_SYNC_KEYSTORE＋COPY_SYNC_KEYSTORE_PASSWORD_FILE｜COPY_SYNC_KEYSTORE_PASSWORD｜互動輸入
  COPY_SYNC_PRIVATE_KEY       明文私鑰：只限本機 Anvil（31337），其他鏈需加 --allow-plaintext-key
  --allow-plaintext-key       明確允許在公開鏈使用明文私鑰（例如 GitHub Actions secret）

通知
  --notify-webhook URL        每次同步成功或被擋時 POST JSON（env COPY_SYNC_NOTIFY_WEBHOOK；只收 https）
`;

const FLAGS_WITH_VALUE = new Set([
  "--mode", "--followers", "--rpc-url", "--chain-id", "--tracker", "--registry", "--from-block",
  "--lookback-blocks", "--confirmations", "--interval-sec", "--rescan-sec", "--min-tip-wei", "--max-gas-gwei",
  "--max-sends-per-round", "--tx-timeout-sec", "--state-file", "--notify-webhook",
]);
const BOOL_FLAGS = new Set(["--dry-run", "--notify-only", "--once", "--allow-plaintext-key", "--help", "-h"]);

/** 32 bytes 的十六進位（有無 0x 皆可）：私鑰的樣子。tx hash 也長這樣，但不會出現在這些參數裡。 */
const LOOKS_LIKE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * 錯誤訊息裡怎麼提到使用者給的值。personal 模式是給跟隨者自己的 agent 用的，「把主錢包私鑰貼進
 * --followers」是最容易發生的混淆；錯誤訊息會進 stderr、cron 日誌與 CI 日誌，而跟隨者的私鑰不在
 * 環境變數裡、redactSecrets 遮不到。所以：像私鑰的值一律不顯示；其他值只顯示前 6 碼與長度。
 */
export function describeBadValue(raw: string): string {
  const v = raw.trim();
  if (LOOKS_LIKE_KEY.test(v)) return "（看起來像私鑰（32 bytes），已拒絕且不顯示；這個欄位只填地址，私鑰永遠不要交給這個程式）";
  if (v.length <= 6) return `「${v}」`;
  return `「${v.slice(0, 6)}…」（${v.length} 個字元）`;
}

function intIn(name: string, raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} 必須是整數：${describeBadValue(raw)}`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} 必須介於 ${min} 與 ${max}：${describeBadValue(raw)}`);
  return n;
}

function addressList(name: string, raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    if (!ethers.isAddress(part)) throw new Error(`${name} 含不合法的地址：${describeBadValue(part)}`);
    const a = ethers.getAddress(part).toLowerCase();
    if (a === ethers.ZeroAddress) throw new Error(`${name} 不能是零地址`);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

function address(name: string, raw: string): string {
  if (!ethers.isAddress(raw.trim())) throw new Error(`${name} 不是合法地址：${describeBadValue(raw)}`);
  return ethers.getAddress(raw.trim());
}

/** 解析 argv（不含 node 與腳本路徑）與環境變數。錯誤以 Error 丟出，訊息不含 RPC／webhook 的值。 */
export function parseCli(argv: readonly string[], env: Record<string, string | undefined>): CliConfig {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_FLAGS.has(name)) {
      bools.add(name === "-h" ? "--help" : name);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(name)) {
      // 旗標名稱照印（方便找出打錯的字）；其餘（位置參數、貼錯地方的值）一律經 describeBadValue。
      const shown = /^--[a-z][a-z0-9-]{0,40}$/.test(name) ? name : describeBadValue(name);
      throw new Error(`不認得的參數：${shown}（--help 看用法）`);
    }
    const v = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
    if (v === undefined || (eq < 0 && v.startsWith("--"))) throw new Error(`${name} 需要一個值`);
    flags.set(name, v);
  }
  const pick = (flag: string, envName?: string): string | undefined => {
    const f = flags.get(flag);
    if (f !== undefined) return f;
    const e = envName ? env[envName]?.trim() : undefined;
    return e ? e : undefined;
  };

  const help = bools.has("--help");
  const followersRaw = pick("--followers", "COPY_SYNC_FOLLOWERS");
  const followers = followersRaw ? addressList("--followers", followersRaw) : [];
  const modeRaw = pick("--mode", "COPY_SYNC_MODE");
  let mode: "public" | "personal";
  if (modeRaw === undefined) mode = followers.length > 0 ? "personal" : "public";
  else if (modeRaw === "public" || modeRaw === "personal") mode = modeRaw;
  else throw new Error(`--mode 只能是 public 或 personal：${describeBadValue(modeRaw)}`);
  if (mode === "personal" && followers.length === 0 && !help) throw new Error("personal 模式需要 --followers（你自己的跟隨者地址）");
  if (mode === "public" && followers.length > 0) throw new Error("public 模式服務所有人，不需要 --followers；要只服務自己請用 --mode personal");

  const rpcUrl = pick("--rpc-url", "COPY_SYNC_RPC_URL") ?? env.BASE_SEPOLIA_RPC_URL?.trim() ?? "";
  if (!rpcUrl && !help) throw new Error("缺少 RPC：請設 COPY_SYNC_RPC_URL（或 BASE_SEPOLIA_RPC_URL、--rpc-url）");
  if (rpcUrl) {
    try {
      const u = new URL(rpcUrl);
      if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) throw new Error("x");
    } catch {
      throw new Error("RPC 網址格式不正確（只接受 http(s)/ws(s)）");
    }
  }

  const chainIdRaw = pick("--chain-id", "COPY_SYNC_CHAIN_ID");
  const trackerRaw = pick("--tracker", "COPY_SYNC_TRACKER");
  const registryRaw = pick("--registry", "COPY_SYNC_REGISTRY");
  const fromRaw = pick("--from-block");
  const confRaw = pick("--confirmations");
  const gasRaw = pick("--max-gas-gwei", "COPY_SYNC_MAX_GAS_GWEI");
  let maxGasPriceWei: bigint | null = null;
  if (gasRaw !== undefined) {
    if (!/^\d+(\.\d{1,9})?$/.test(gasRaw)) throw new Error(`--max-gas-gwei 必須是正數：${describeBadValue(gasRaw)}`);
    maxGasPriceWei = ethers.parseUnits(gasRaw, "gwei");
    if (maxGasPriceWei <= 0n) throw new Error("--max-gas-gwei 必須大於 0");
  }
  const tipRaw = pick("--min-tip-wei", "COPY_SYNC_MIN_TIP_WEI") ?? "0";
  if (!/^\d+$/.test(tipRaw)) throw new Error(`--min-tip-wei 必須是非負整數：${describeBadValue(tipRaw)}`);

  const webhook = pick("--notify-webhook", "COPY_SYNC_NOTIFY_WEBHOOK") ?? null;
  const allowPlain = bools.has("--allow-plaintext-key") || env.COPY_SYNC_ALLOW_PLAINTEXT_KEY === "1";
  const dryRun = bools.has("--dry-run") || env.DRY_RUN === "1";
  const notifyOnly = bools.has("--notify-only") || env.COPY_SYNC_NOTIFY_ONLY === "1";
  if (notifyOnly && dryRun) throw new Error("--notify-only 與 --dry-run 擇一：前者會寫狀態檔、可排程；後者只是試跑");
  if (notifyOnly && mode !== "personal" && !help) {
    throw new Error("--notify-only 是給跟隨者本人收通知用的：請用 --followers 列出你自己的跟隨地址（personal 模式）");
  }

  return {
    mode,
    followers,
    rpcUrl,
    chainId: chainIdRaw === undefined ? null : intIn("--chain-id", chainIdRaw, 1, 2 ** 40),
    tracker: trackerRaw === undefined ? null : address("--tracker", trackerRaw),
    registry: registryRaw === undefined ? null : address("--registry", registryRaw),
    fromBlock: fromRaw === undefined ? null : intIn("--from-block", fromRaw, 0, 2 ** 48),
    lookbackBlocks: intIn("--lookback-blocks", pick("--lookback-blocks") ?? "43200", 1, 10_000_000),
    confirmations: confRaw === undefined ? null : intIn("--confirmations", confRaw, 0, 1000),
    intervalSec: intIn("--interval-sec", pick("--interval-sec", "COPY_SYNC_INTERVAL_SEC") ?? "30", 1, 86_400),
    rescanSec: intIn("--rescan-sec", pick("--rescan-sec") ?? "600", 10, 7 * 86_400),
    minTipWei: BigInt(tipRaw),
    maxGasPriceWei,
    maxSendsPerRound: intIn("--max-sends-per-round", pick("--max-sends-per-round") ?? "10", 1, 1000),
    txTimeoutSec: intIn("--tx-timeout-sec", pick("--tx-timeout-sec") ?? "120", 5, 3600),
    stateFile: pick("--state-file", "COPY_SYNC_STATE_FILE") ?? null,
    notifyWebhook: webhook,
    dryRun,
    notifyOnly,
    once: bools.has("--once"),
    allowPlaintextKey: allowPlain,
    help,
  };
}
