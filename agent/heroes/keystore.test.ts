// 公開鏈回放的金鑰（#344）：新產生、加密、讀回同一組；絕不是 Anvil 的測試金鑰；在 repo 裡必須被 git 忽略。
//   cd agent && npx tsx heroes/keystore.test.ts
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ANVIL_MNEMONIC, createKeystore, loadKeystore, loadOrCreateKeystore, unignoredReason } from "./keystore.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const anvil = (i: number) => ethers.HDNodeWallet.fromPhrase(ANVIL_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).address;

const dir = mkdtempSync(join(tmpdir(), "heroes-keys-"));
try {
  const path = join(dir, "keys.json");
  const { keys, created } = await loadOrCreateKeystore(path, "correct horse");
  assert.ok(created);
  // 與本機回放相同的 index，但不是 Anvil 公開的那一組
  for (const i of [1, 10, 33, 40, 99]) assert.notEqual(keys.wallet(i).address, anvil(i), `index ${i} is an Anvil test key`);
  assert.notEqual(keys.wallet(10).address, keys.wallet(11).address);

  const again = await loadOrCreateKeystore(path, "correct horse");
  assert.ok(!again.created);
  assert.equal(again.keys.fingerprint, keys.fingerprint);
  assert.equal(again.keys.wallet(31).address, keys.wallet(31).address, "resume reads the same keys");
  await assert.rejects(loadKeystore(path, "wrong password"));
  await assert.rejects(createKeystore(path, "correct horse"), /already exists/);
  await assert.rejects(createKeystore(join(dir, "short.json"), "short"), /at least 8/);

  // Anvil 的助記詞（例如有人手動把它加密成金鑰檔）一律拒絕
  const anvilEntropy = ethers.getBytes(ethers.Mnemonic.fromPhrase(ANVIL_MNEMONIC).entropy);
  await assert.rejects(createKeystore(join(dir, "anvil.json"), "correct horse", anvilEntropy), /Anvil test mnemonic/);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// repo 裡：沒被 git 忽略的位置拒絕寫入；heroes/keys/ 與 heroes/out/ 被忽略，可以。
assert.match(unignoredReason(join(REPO, "agent", "heroes", "keys.json"))!, /not git-ignored/);
assert.equal(unignoredReason(join(REPO, "heroes", "keys", "84532.json")), null);
assert.equal(unignoredReason(join(REPO, "heroes", "out", "keys.json")), null);
await assert.rejects(createKeystore(join(REPO, "agent", "heroes", "keys.json"), "correct horse"), /not git-ignored/);
assert.ok(!existsSync(join(REPO, "agent", "heroes", "keys.json")));

console.log("keystore: ok");
