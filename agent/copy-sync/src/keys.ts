// 執行者金鑰：一把獨立、只放少量 gas ETH 的熱錢包。
//
// 自託管的界線：這個程式**永遠不需要、也不接受**任何跟隨者的私鑰。跟隨者在自己的錢包裡簽
// setAutoSync／depositSyncGas，之後誰來按 resyncFor 都只能把部位調成交易者鏈上最新版
// （ADR-024）。執行者金鑰外洩的最壞情況，是別人用它觸發「合約本來就允許任何人觸發」的同步，
// 再加上損失熱錢包裡那一點 gas ETH——沒有任何跟隨者資金風險。
//
// 金鑰來源（比照 keeper/keySource.ts，變數前綴 COPY_SYNC）：
//   - 加密 keystore（公開鏈的預設）：COPY_SYNC_KEYSTORE＝檔案路徑或 ~/.foundry/keystores 下的名稱；
//     密碼三選一：COPY_SYNC_KEYSTORE_PASSWORD_FILE（檔案）、COPY_SYNC_KEYSTORE_PASSWORD（環境變數，
//     給 CI secret）、都沒設時在終端機互動輸入（不回顯）。
//   - 明文 COPY_SYNC_PRIVATE_KEY：只允許本機 Anvil（chainId 31337），或明確加上
//     --allow-plaintext-key（例如 GitHub Actions secret）。
//   - Anvil 公開的十把測試金鑰：在 31337 以外的鏈一律拒絕（公開鏈上出現它們就是事故）。
// 錯誤訊息只帶變數名稱與可印的路徑，絕不帶私鑰、密碼或 keystore 內容。
//
// keystore 與密碼檔不得放在 repo 目錄裡（例如 COPY_SYNC_KEYSTORE=./exec.json）：`git add -A` 會把加密 keystore
// 與明文密碼一起收進版本庫。.gitignore 只擋得住常見檔名，所以這裡直接拒絕啟動，請使用者移到 repo 外。
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { keySpecFromEnv, loadWalletFromSpec, passwordFromFile, type KeeperKeySpec } from "../../keeper/keySource.ts";
import { ANVIL_MNEMONIC } from "../../heroes/keystore.ts";

export const KEY_PREFIX = "COPY_SYNC";
export const ENV_PRIVATE_KEY = `${KEY_PREFIX}_PRIVATE_KEY`;
export const ENV_KEYSTORE = `${KEY_PREFIX}_KEYSTORE`;
export const ENV_PASSWORD_FILE = `${KEY_PREFIX}_KEYSTORE_PASSWORD_FILE`;
export const ENV_PASSWORD = `${KEY_PREFIX}_KEYSTORE_PASSWORD`;

export const ANVIL_CHAIN_ID = 31337;

export type PasswordSource =
  | { kind: "file"; path: string; label: string }
  | { kind: "env"; name: string }
  | { kind: "prompt" };

export type ExecutorKeySpec =
  | { kind: "privateKey"; key: string }
  | { kind: "keystore"; path: string; pathLabel: string; password: PasswordSource };

/** keySpecFromEnv 要求密碼檔；沒有密碼檔時借一個不會被讀的值，只為了沿用它的路徑解析與檢查。 */
const UNUSED_PASSWORD_FILE = "~/.copy-sync-password-not-used";

/** repo 根目錄：此檔在 agent/copy-sync/src/keys.ts，往上三層。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 解開符號連結後的絕對路徑（macOS 的 /var → /private/var）。檔案還不存在時，解開最近一層存在的上層目錄，
 * 再接回其餘部分——不然「還沒建立的 keystore」會和已解開的 repo 根目錄對不上。
 */
function realPath(x: string): string {
  const abs = resolve(x);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail);
    } catch {
      const up = dirname(head);
      if (up === head) return abs;
      tail.unshift(head.slice(up.length).replace(/^[\\/]+/, ""));
      head = up;
    }
  }
}

/** `p` 是否位在 `root` 底下（含 root 本身）。兩邊都先解開符號連結。 */
export function isInsideDir(p: string, root: string): boolean {
  const rel = relative(realPath(root), realPath(p));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 從環境變數決定執行者金鑰來源。回傳 `{ error }` 時呼叫端應 exit 1。 */
export function executorKeySpec(
  env: Record<string, string | undefined>,
  home: string = homedir(),
  repoRoot: string = REPO_ROOT,
): { spec: ExecutorKeySpec } | { error: string } {
  const ks = (env[ENV_KEYSTORE] ?? "").trim();
  const pwf = (env[ENV_PASSWORD_FILE] ?? "").trim();
  const pwEnv = env[ENV_PASSWORD];
  if (!ks) {
    if (pwf || pwEnv) return { error: `設定了 ${pwf ? ENV_PASSWORD_FILE : ENV_PASSWORD} 卻沒有設定 ${ENV_KEYSTORE}` };
    const r = keySpecFromEnv(env, KEY_PREFIX, home);
    if ("error" in r) return { error: `${r.error}（或改設 ${ENV_KEYSTORE} 使用加密 keystore）` };
    return { spec: { kind: "privateKey", key: (r.spec as { key: string }).key } };
  }
  if (pwf && pwEnv !== undefined && pwEnv !== "") return { error: `${ENV_PASSWORD_FILE} 與 ${ENV_PASSWORD} 只能設定一個` };
  const r = keySpecFromEnv({ ...env, [ENV_PASSWORD_FILE]: pwf || UNUSED_PASSWORD_FILE }, KEY_PREFIX, home);
  if ("error" in r) return { error: r.error };
  const s = r.spec as Extract<KeeperKeySpec, { kind: "keystore" }>;
  const inRepo = [
    isInsideDir(s.path, repoRoot) ? `keystore（${s.pathLabel}）` : null,
    pwf && isInsideDir(s.passwordFile, repoRoot) ? `密碼檔（${s.passwordFileLabel}）` : null,
  ].filter(Boolean);
  if (inRepo.length > 0) {
    return {
      error:
        `執行者的${inRepo.join("與")}放在 repo 目錄裡：\`git add\` 可能把它收進版本庫。請移到 repo 外` +
        `（例如 ~/.foundry/keystores/<名稱>、~/.copy-sync-password；GitHub Actions 請寫到 $RUNNER_TEMP）`,
    };
  }
  const password: PasswordSource = pwf
    ? { kind: "file", path: s.passwordFile, label: s.passwordFileLabel }
    : pwEnv !== undefined && pwEnv !== ""
      ? { kind: "env", name: ENV_PASSWORD }
      : { kind: "prompt" };
  return { spec: { kind: "keystore", path: s.path, pathLabel: s.pathLabel, password } };
}

/** Anvil 預設助記詞推導出來的前十把位址（anvil 啟動時印出的那十個帳號）。 */
export const ANVIL_ADDRESSES: ReadonlySet<string> = new Set(
  Array.from({ length: 10 }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).address.toLowerCase(),
  ),
);

/**
 * 金鑰來源與鏈的組合是否允許。在解開金鑰「之前」檢查（明文金鑰）與「之後」檢查（位址是否為
 * Anvil 測試帳號）兩段都用這個函式；`address` 未知時傳 null。
 */
export function keyPolicyError(a: {
  spec: ExecutorKeySpec;
  chainId: number;
  allowPlaintextKey: boolean;
  address: string | null;
}): string | null {
  const local = a.chainId === ANVIL_CHAIN_ID;
  if (a.spec.kind === "privateKey" && !local && !a.allowPlaintextKey) {
    return (
      `chainId ${a.chainId} 不是本機 Anvil：公開鏈請改用加密 keystore（${ENV_KEYSTORE}）。` +
      `確定要用明文私鑰（例如 GitHub Actions secret）時，請明確加上 --allow-plaintext-key`
    );
  }
  if (a.address && !local && ANVIL_ADDRESSES.has(a.address.toLowerCase())) {
    return `執行者金鑰是 Anvil 公開的測試金鑰（${a.address}），不得用在 chainId ${a.chainId}`;
  }
  return null;
}

/**
 * 載入的執行者金鑰其實是某位跟隨者的主錢包嗎？不論 public／personal 模式都檢查：這個程式「永遠不需要、
 * 也不接受」跟隨者的私鑰，而跟隨者主錢包持有 USDC 部位與油箱，不是只放少量 gas ETH 的熱錢包。
 * 判斷依據是執行者位址在 tracker 上的足跡（chain.ts 的 followerFootprint）：有任何跟單紀錄（含已結束的）
 * 或油箱有餘額，就拒絕啟動。回傳 null 表示可以用。
 */
export function executorFollowerError(a: { address: string; tracker: string; records: number; syncGasWei: bigint }): string | null {
  if (a.records === 0 && a.syncGasWei === 0n) return null;
  const what = [
    a.records > 0 ? `${a.records} 筆跟單紀錄` : null,
    a.syncGasWei > 0n ? `同步油箱餘額 ${ethers.formatEther(a.syncGasWei)} ETH` : null,
  ].filter(Boolean).join("、");
  return (
    `執行者位址 ${a.address} 在 CopyTracker ${a.tracker} 上有${what}：這是跟隨者的主錢包，不是執行者熱錢包。` +
    `程式不接受任何跟隨者的私鑰（不論 public 或 personal 模式）；請另外產生一把只放少量 gas ETH 的執行者熱錢包` +
    `（README「金鑰模型」）。只想收到通知、不送交易的話用 --notify-only，完全不需要金鑰`
  );
}

export interface PasswordIo {
  readFile?: (p: string) => string;
  env?: Record<string, string | undefined>;
  prompt?: (question: string) => Promise<string>;
}

/** 依來源取得 keystore 密碼。錯誤訊息不含密碼。 */
export async function resolvePassword(src: PasswordSource, io: PasswordIo = {}): Promise<string> {
  if (src.kind === "file") {
    try {
      return passwordFromFile((io.readFile ?? ((p) => readFileSync(p, "utf8")))(src.path));
    } catch {
      throw new Error(`讀不到執行者 keystore 密碼檔：${src.label}`);
    }
  }
  if (src.kind === "env") {
    const v = (io.env ?? process.env)[src.name];
    if (!v) throw new Error(`${src.name} 是空的`);
    return v;
  }
  const ask = io.prompt ?? promptHidden;
  return ask("執行者 keystore 密碼：");
}

/**
 * 在終端機讀一行密碼，不回顯。stdin 不是 TTY（cron、CI、管線）時直接丟錯——
 * 那種環境請改用密碼檔或 COPY_SYNC_KEYSTORE_PASSWORD。
 */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(
      new Error(`沒有互動式終端機可以輸入 keystore 密碼：請改設 ${ENV_PASSWORD_FILE} 或 ${ENV_PASSWORD}`),
    );
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    let buf = "";
    const done = (err: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(null);
        if (ch === "\u0003") return done(new Error("已取消輸入密碼"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** 依 spec 解開執行者錢包（未連 provider，也還沒套白名單；見 guard.ts 的 ExecutorWallet）。 */
export async function loadExecutorKey(spec: ExecutorKeySpec, io: PasswordIo = {}): Promise<ethers.SigningKey> {
  if (spec.kind === "privateKey") return new ethers.SigningKey(spec.key);
  const password = await resolvePassword(spec.password, io);
  // 沿用 keeper 的解密路徑（錯誤訊息不含密碼與內容）；密碼直接在記憶體裡傳，不落地。
  const w = await loadWalletFromSpec(
    { kind: "keystore", path: spec.path, passwordFile: "(memory)", pathLabel: spec.pathLabel, passwordFileLabel: "(memory)" },
    "執行者",
    (p) => (p === "(memory)" ? password : (io.readFile ?? ((f) => readFileSync(f, "utf8")))(p)),
  );
  return w.signingKey;
}

/** 日誌用：說明金鑰從哪裡來（不含任何秘密）。 */
export function describeKeySource(spec: ExecutorKeySpec): string {
  if (spec.kind === "privateKey") return `明文 ${ENV_PRIVATE_KEY}`;
  const pw = spec.password.kind === "file" ? `密碼檔 ${spec.password.label}` : spec.password.kind === "env" ? `密碼 ${ENV_PASSWORD}` : "互動輸入密碼";
  return `keystore ${spec.pathLabel}（${pw}）`;
}
