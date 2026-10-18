// 公開鏈回放（#344）的帳號金鑰：交易者、虛擬跟隨者、造市帳號。
//
// - 第一次執行時新產生一組助記詞，加密（ethers 的 keystore v3，scrypt）寫進金鑰檔；之後每次讀回同一組。
// - 每個帳號的推導路徑與本機回放相同（m/44'/60'/0'/0/<排程裡的 index>），只是助記詞不同。
// - 絕不用 Anvil 公開的測試助記詞；金鑰檔放在 repo 裡時必須被 git 忽略，否則拒絕寫入。
// 部署者不在這裡：它是擁有者的 Foundry keystore（見 replay.ts）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ethers } from "ethers";

/** Anvil 的預設助記詞（公開的測試金鑰）。公開鏈上出現它就是事故。 */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

export const derivationPath = (index: number) => `m/44'/60'/0'/0/${index}`;

export interface KeySet {
  /** 第一個推導出來的位址，進度檔記下它，續跑時確認讀到的是同一組金鑰。 */
  fingerprint: string;
  wallet(index: number): ethers.HDNodeWallet;
}

function keySetOf(mnemonic: ethers.Mnemonic): KeySet {
  if (mnemonic.phrase.trim() === ANVIL_MNEMONIC) throw new Error("keystore holds the public Anvil test mnemonic: never on a public chain");
  const wallet = (index: number) => ethers.HDNodeWallet.fromMnemonic(mnemonic, derivationPath(index));
  return { fingerprint: wallet(0).address, wallet };
}

/**
 * 金鑰檔若在某個 git 工作目錄裡，必須被忽略（`git check-ignore`）。不在任何 repo 裡就不檢查。
 * 回傳 null 表示可以寫，否則是拒絕的理由。
 */
export function unignoredReason(path: string): string | null {
  const dir = dirname(resolve(path));
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: existsSync(dir) ? dir : process.cwd(), encoding: "utf8" });
  if (top.status !== 0) return null; // 不在 repo 裡
  const check = spawnSync("git", ["check-ignore", "-q", resolve(path)], { cwd: top.stdout.trim(), encoding: "utf8" });
  if (check.status === 0) return null;
  return `${path} is inside the git repo ${top.stdout.trim()} and not git-ignored: keys must never be committed`;
}

/** 讀回既有的金鑰檔。密碼錯誤或檔案不是 HD 錢包都丟錯。 */
export async function loadKeystore(path: string, password: string): Promise<KeySet> {
  const wallet = await ethers.Wallet.fromEncryptedJson(readFileSync(path, "utf8"), password);
  if (!(wallet instanceof ethers.HDNodeWallet) || !wallet.mnemonic) throw new Error(`${path} has no mnemonic: not a heroes keystore`);
  return keySetOf(wallet.mnemonic);
}

/** 新產生一組金鑰並加密寫出。檔案已存在就拒絕（不會覆寫別次回放的金鑰）。 */
export async function createKeystore(path: string, password: string, entropy?: Uint8Array): Promise<KeySet> {
  if (existsSync(path)) throw new Error(`${path} already exists: load it instead of overwriting another replay's keys`);
  if (password.length < 8) throw new Error("keystore password must be at least 8 characters");
  const reason = unignoredReason(path);
  if (reason) throw new Error(reason);
  const mnemonic = ethers.Mnemonic.fromEntropy(entropy ?? ethers.randomBytes(16));
  const root = ethers.HDNodeWallet.fromMnemonic(mnemonic, derivationPath(0));
  const json = await root.encrypt(password);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  // wx：寫入當下才發現已存在也不覆寫；0600：只有自己讀得到。
  writeFileSync(path, json + "\n", { flag: "wx", mode: 0o600 });
  return keySetOf(mnemonic);
}

export async function loadOrCreateKeystore(path: string, password: string): Promise<{ keys: KeySet; created: boolean }> {
  if (existsSync(path)) return { keys: await loadKeystore(path, password), created: false };
  return { keys: await createKeystore(path, password), created: true };
}
