// keeper 金鑰來源：明文 KEEPER_PRIVATE_KEY（GitHub Actions secret，平台 workflow 的預設），
// 或加密 keystore（KEEPER_KEYSTORE＋KEEPER_KEYSTORE_PASSWORD_FILE，本機長時間執行用，
// 私鑰只在這個行程的記憶體裡解開，不經過環境變數、指令列或任何檔案）。
//
// 兩者互斥：同時設定代表操作者搞不清楚是哪一把在簽，直接拒絕。
// 錯誤訊息只帶環境變數名稱與 keystore 路徑，絕不帶密碼、私鑰或 keystore 內容。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ethers } from "ethers";

export type KeeperKeySpec =
  | { kind: "privateKey"; key: string }
  | { kind: "keystore"; path: string; passwordFile: string };

/** Foundry 的 keystore 名稱（~/.foundry/keystores/<name>）。 */
const KEYSTORE_NAME = /^[A-Za-z0-9._-]+$/;

function expandHome(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/**
 * 從環境變數決定金鑰來源。回傳 `{ error }` 時呼叫端應 exit 1。
 * `KEEPER_KEYSTORE` 含路徑分隔或以 ~ 開頭時當作檔案路徑，否則當作 ~/.foundry/keystores 下的名稱。
 */
export function keeperKeySpec(
  env: Record<string, string | undefined>,
  home: string = homedir(),
): { spec: KeeperKeySpec } | { error: string } {
  const pk = (env.KEEPER_PRIVATE_KEY ?? "").trim();
  const ks = (env.KEEPER_KEYSTORE ?? "").trim();
  const pwf = (env.KEEPER_KEYSTORE_PASSWORD_FILE ?? "").trim();
  if (pk && ks) return { error: "KEEPER_PRIVATE_KEY 與 KEEPER_KEYSTORE 只能設定一個" };
  if (ks) {
    if (!pwf) return { error: "設定 KEEPER_KEYSTORE 時必須同時設定 KEEPER_KEYSTORE_PASSWORD_FILE" };
    let path: string;
    if (ks.includes("/") || ks.startsWith("~")) path = resolve(expandHome(ks, home));
    else if (KEYSTORE_NAME.test(ks)) path = join(home, ".foundry", "keystores", ks);
    else return { error: "KEEPER_KEYSTORE 不是合法的 keystore 名稱或路徑" };
    const pw = expandHome(pwf, home);
    return { spec: { kind: "keystore", path, passwordFile: isAbsolute(pw) ? pw : resolve(pw) } };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return { error: "KEEPER_PRIVATE_KEY 未設或格式錯誤" };
  return { spec: { kind: "privateKey", key: pk } };
}

/** 去掉密碼檔結尾的換行（與 `cast --password-file` 相同；密碼中間的空白保留）。 */
export function passwordFromFile(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/** 依 spec 建出錢包（未連 provider）。keystore 解密失敗時的錯誤不含密碼與內容。 */
export async function loadKeeperWallet(
  spec: KeeperKeySpec,
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Promise<ethers.Wallet> {
  if (spec.kind === "privateKey") return new ethers.Wallet(spec.key);
  let json: string;
  let password: string;
  try {
    json = readFile(spec.path);
  } catch {
    throw new Error(`讀不到 keeper keystore：${spec.path}`);
  }
  try {
    password = passwordFromFile(readFile(spec.passwordFile));
  } catch {
    throw new Error(`讀不到 keeper keystore 密碼檔：${spec.passwordFile}`);
  }
  let w: ethers.Wallet | ethers.HDNodeWallet;
  try {
    w = await ethers.Wallet.fromEncryptedJson(json, password);
  } catch {
    throw new Error(`keeper keystore 解密失敗（密碼不符或檔案損壞）：${spec.path}`);
  }
  return new ethers.Wallet(w.privateKey);
}
