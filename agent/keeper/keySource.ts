// keeper 金鑰來源：明文 KEEPER_PRIVATE_KEY（GitHub Actions secret，平台 workflow 的預設），
// 或加密 keystore（KEEPER_KEYSTORE＋KEEPER_KEYSTORE_PASSWORD_FILE，本機長時間執行用，
// 私鑰只在這個行程的記憶體裡解開，不經過環境變數、指令列或任何檔案）。
//
// 兩者互斥：同時設定代表操作者搞不清楚是哪一把在簽，直接拒絕。
// 錯誤訊息只帶環境變數名稱與 keystore 路徑，絕不帶密碼、私鑰或 keystore 內容。
//
// 泛用版 keySpecFromEnv／loadWalletFromSpec 以變數名前綴區分角色，發證者 CLI（issuer/cli.ts）
// 用 ISSUER_ 前綴共用同一套規則。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ethers } from "ethers";

export type KeeperKeySpec =
  | { kind: "privateKey"; key: string }
  | {
      kind: "keystore";
      path: string;
      passwordFile: string;
      /** 訊息裡可以印的說法：使用者給的是絕對路徑或 ~/ 路徑時才印路徑，否則只印環境變數名稱（值可能是誤填的秘密）。 */
      pathLabel: string;
      passwordFileLabel: string;
    };

/** Foundry 的 keystore 名稱（~/.foundry/keystores/<name>）。 */
const KEYSTORE_NAME = /^[A-Za-z0-9._-]+$/;
/** 誤把私鑰（或其他 32 位元組 hex）填進路徑欄位。 */
const LOOKS_LIKE_KEY = /^(0[xX])?[0-9a-fA-F]{64}$/;
/** 看起來像路徑的值（絕對路徑或 ~/）才能出現在訊息裡；其他可能是誤填的秘密。 */
const printablePath = (v: string) => v.startsWith("/") || v.startsWith("~/");

function expandHome(p: string, home: string): string {
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/**
 * 從環境變數決定金鑰來源（泛用版）。`prefix` 決定變數名：`<prefix>_PRIVATE_KEY`、`<prefix>_KEYSTORE`、
 * `<prefix>_KEYSTORE_PASSWORD_FILE`（keeper 用 "KEEPER"，發證者 CLI 用 "ISSUER"）。
 * 回傳 `{ error }` 時呼叫端應 exit 1。
 * `<prefix>_KEYSTORE` 含路徑分隔或以 ~ 開頭時當作檔案路徑，否則當作 ~/.foundry/keystores 下的名稱。
 */
export function keySpecFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
  home: string = homedir(),
): { spec: KeeperKeySpec } | { error: string } {
  const PK = `${prefix}_PRIVATE_KEY`;
  const KS = `${prefix}_KEYSTORE`;
  const PWF = `${prefix}_KEYSTORE_PASSWORD_FILE`;
  const pk = (env[PK] ?? "").trim();
  const ks = (env[KS] ?? "").trim();
  const pwf = (env[PWF] ?? "").trim();
  if (pk && ks) return { error: `${PK} 與 ${KS} 只能設定一個` };
  if (ks) {
    if (LOOKS_LIKE_KEY.test(ks)) return { error: `${KS} 看起來是私鑰，不是 keystore 名稱或路徑；請改用 keystore` };
    if (!pwf) return { error: `設定 ${KS} 時必須同時設定 ${PWF}` };
    if (LOOKS_LIKE_KEY.test(pwf)) return { error: `${PWF} 看起來是私鑰，不是密碼檔路徑` };
    if ((ks.startsWith("~") && !ks.startsWith("~/")) || (pwf.startsWith("~") && !pwf.startsWith("~/"))) {
      return { error: `${KS}／${PWF} 只支援 ~/ 開頭的家目錄路徑` };
    }
    let path: string;
    let pathLabel: string;
    if (ks.includes("/")) {
      path = resolve(expandHome(ks, home));
      pathLabel = printablePath(ks) ? path : KS;
    } else if (KEYSTORE_NAME.test(ks)) {
      path = join(home, ".foundry", "keystores", ks);
      pathLabel = `${KS}（~/.foundry/keystores 下的名稱）`;
    } else return { error: `${KS} 不是合法的 keystore 名稱或路徑` };
    const pw = expandHome(pwf, home);
    const passwordFile = isAbsolute(pw) ? pw : resolve(pw);
    const passwordFileLabel = printablePath(pwf) ? passwordFile : PWF;
    return { spec: { kind: "keystore", path, passwordFile, pathLabel, passwordFileLabel } };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { error: `${PK} 未設或格式錯誤` };
  return { spec: { kind: "privateKey", key: pk } };
}

/** keeper 的金鑰來源：KEEPER_PRIVATE_KEY 或 KEEPER_KEYSTORE＋KEEPER_KEYSTORE_PASSWORD_FILE。 */
export function keeperKeySpec(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): { spec: KeeperKeySpec } | { error: string } {
  return keySpecFromEnv(env, "KEEPER", home);
}

/** 去掉密碼檔結尾的換行（與 `cast --password-file` 相同；密碼中間的空白保留）。 */
export function passwordFromFile(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/**
 * 依 spec 建出錢包（未連 provider）。keystore 解密失敗時的錯誤不含密碼與內容。
 * `role` 只用在錯誤訊息（例如 "keeper"、"issuer"）。
 */
export async function loadWalletFromSpec(
  spec: KeeperKeySpec,
  role: string,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<ethers.Wallet> {
  if (spec.kind === "privateKey") return new ethers.Wallet(spec.key);
  let json: string;
  let password: string;
  try {
    json = readFile(spec.path);
  } catch {
    throw new Error(`讀不到 ${role} keystore：${spec.pathLabel}`);
  }
  try {
    password = passwordFromFile(readFile(spec.passwordFile));
  } catch {
    throw new Error(`讀不到 ${role} keystore 密碼檔：${spec.passwordFileLabel}`);
  }
  let w: ethers.Wallet | ethers.HDNodeWallet;
  try {
    w = await ethers.Wallet.fromEncryptedJson(json, password);
  } catch {
    throw new Error(`${role} keystore 解密失敗（密碼不符或檔案損壞）：${spec.pathLabel}`);
  }
  return new ethers.Wallet(w.privateKey);
}

/** keeper 版：錯誤訊息以 "keeper keystore" 開頭（行為與泛化前相同）。 */
export async function loadKeeperWallet(
  spec: KeeperKeySpec,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<ethers.Wallet> {
  return loadWalletFromSpec(spec, "keeper", readFile);
}
