// keeper 金鑰來源（明文 env 或加密 keystore）。keystore 在測試內以隨機錢包產生，不碰任何真的金鑰。
//   cd agent && npx tsx keeper/keySource.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { keeperKeySpec, loadKeeperWallet, passwordFromFile } from "./keySource.ts";

const HOME = "/home/op";
const PK = "0x" + "11".repeat(32);

// 1. 環境變數解析
{
  const ok = keeperKeySpec({ KEEPER_PRIVATE_KEY: ` ${PK} ` }, HOME);
  assert.deepStrictEqual(ok, { spec: { kind: "privateKey", key: PK } });

  for (const bad of [undefined, "", "0x1234", "11".repeat(32), "0x" + "zz".repeat(32)]) {
    const r = keeperKeySpec({ KEEPER_PRIVATE_KEY: bad }, HOME);
    assert.ok("error" in r && /KEEPER_PRIVATE_KEY 未設或格式錯誤/.test(r.error), String(bad));
  }

  const both = keeperKeySpec({ KEEPER_PRIVATE_KEY: PK, KEEPER_KEYSTORE: "k", KEEPER_KEYSTORE_PASSWORD_FILE: "/p" }, HOME);
  assert.ok("error" in both && /只能設定一個/.test(both.error));
  assert.ok(!JSON.stringify(both).includes(PK), "錯誤訊息不得帶私鑰");

  const noPw = keeperKeySpec({ KEEPER_KEYSTORE: "pepelab-rwa-keeper" }, HOME);
  assert.ok("error" in noPw && /KEEPER_KEYSTORE_PASSWORD_FILE/.test(noPw.error));

  assert.deepStrictEqual(
    keeperKeySpec({ KEEPER_KEYSTORE: "pepelab-rwa-keeper", KEEPER_KEYSTORE_PASSWORD_FILE: "~/.foundry/pepelab-rwa-keeper.password" }, HOME),
    {
      spec: {
        kind: "keystore",
        path: "/home/op/.foundry/keystores/pepelab-rwa-keeper",
        passwordFile: "/home/op/.foundry/pepelab-rwa-keeper.password",
        pathLabel: "KEEPER_KEYSTORE（~/.foundry/keystores 下的名稱）",
        passwordFileLabel: "/home/op/.foundry/pepelab-rwa-keeper.password",
      },
    },
  );
  assert.deepStrictEqual(
    keeperKeySpec({ KEEPER_KEYSTORE: "~/ks/k.json", KEEPER_KEYSTORE_PASSWORD_FILE: "/etc/pw" }, HOME),
    { spec: { kind: "keystore", path: "/home/op/ks/k.json", passwordFile: "/etc/pw", pathLabel: "/home/op/ks/k.json", passwordFileLabel: "/etc/pw" } },
  );
  const badName = keeperKeySpec({ KEEPER_KEYSTORE: "a b", KEEPER_KEYSTORE_PASSWORD_FILE: "/pw" }, HOME);
  assert.ok("error" in badName && /不是合法/.test(badName.error));
  // 誤填：私鑰塞進路徑欄位 → 拒絕，訊息不帶值。
  const RAW = "ab".repeat(32);
  for (const v of [PK, RAW]) {
    const r1 = keeperKeySpec({ KEEPER_KEYSTORE: v, KEEPER_KEYSTORE_PASSWORD_FILE: "/pw" }, HOME);
    assert.ok("error" in r1 && /看起來是私鑰/.test(r1.error) && !r1.error.includes(v.replace(/^0x/, "")));
    const r2 = keeperKeySpec({ KEEPER_KEYSTORE: "k", KEEPER_KEYSTORE_PASSWORD_FILE: v }, HOME);
    assert.ok("error" in r2 && /看起來是私鑰/.test(r2.error) && !r2.error.includes(v.replace(/^0x/, "")));
  }
  // 相對路徑（可能是誤填的秘密）不出現在標籤裡；~foo 不支援。
  const rel = keeperKeySpec({ KEEPER_KEYSTORE: "secretish/value", KEEPER_KEYSTORE_PASSWORD_FILE: "hunter2-pw" }, HOME);
  assert.ok("spec" in rel && rel.spec.kind === "keystore");
  if ("spec" in rel && rel.spec.kind === "keystore") {
    assert.strictEqual(rel.spec.pathLabel, "KEEPER_KEYSTORE");
    assert.strictEqual(rel.spec.passwordFileLabel, "KEEPER_KEYSTORE_PASSWORD_FILE");
  }
  for (const env of [
    { KEEPER_KEYSTORE: "~foo/k", KEEPER_KEYSTORE_PASSWORD_FILE: "/pw" },
    { KEEPER_KEYSTORE: "k", KEEPER_KEYSTORE_PASSWORD_FILE: "~foo" },
  ]) {
    const r = keeperKeySpec(env, HOME);
    assert.ok("error" in r && /只支援 ~\//.test(r.error), JSON.stringify(env));
  }
  console.log("✓ 1. 環境變數：明文／keystore 名稱／路徑、互斥、缺密碼檔、格式錯誤、私鑰誤填、~foo、標籤不帶疑似秘密");
}

// 2. 密碼檔只去掉結尾一個換行
assert.strictEqual(passwordFromFile("abc\n"), "abc");
assert.strictEqual(passwordFromFile("abc\r\n"), "abc");
assert.strictEqual(passwordFromFile(" a b "), " a b ");
console.log("✓ 2. 密碼檔結尾換行處理");

// 3. keystore 解密（測試內產生，低 scrypt 成本）
{
  const w = ethers.Wallet.createRandom();
  const password = "test-only-" + ethers.hexlify(ethers.randomBytes(8));
  const json = ethers.encryptKeystoreJsonSync({ address: w.address, privateKey: w.privateKey }, password, { scrypt: { N: 1 << 10 } });
  const files: Record<string, string> = { "/ks/k": json, "/ks/pw": password + "\n", "/ks/wrong": "nope\n" };
  const read = (p: string) => {
    if (!(p in files)) throw new Error("ENOENT " + p);
    return files[p];
  };

  const ks = (path: string, passwordFile: string) =>
    ({ kind: "keystore", path, passwordFile, pathLabel: path, passwordFileLabel: passwordFile }) as const;
  const got = await loadKeeperWallet(ks("/ks/k", "/ks/pw"), read);
  assert.strictEqual(got.address, w.address);

  const fromPk = await loadKeeperWallet({ kind: "privateKey", key: w.privateKey });
  assert.strictEqual(fromPk.address, w.address);

  const fails = async (spec: Parameters<typeof loadKeeperWallet>[0], re: RegExp) => {
    let msg = "";
    try {
      await loadKeeperWallet(spec, read);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.ok(re.test(msg), `${msg} !~ ${re}`);
    for (const secret of [password, w.privateKey, w.privateKey.slice(2), json]) assert.ok(!msg.includes(secret), "錯誤訊息不得帶秘密");
  };
  await fails(ks("/ks/k", "/ks/wrong"), /解密失敗/);
  await fails(ks("/ks/missing", "/ks/pw"), /讀不到 keeper keystore：/);
  await fails(ks("/ks/k", "/ks/none"), /讀不到 keeper keystore 密碼檔/);
  await fails(ks("/ks/pw", "/ks/pw"), /解密失敗/);
  // 標籤是環境變數名稱時，讀檔失敗訊息只帶名稱。
  await fails(
    { kind: "keystore", path: "/ks/nope", passwordFile: "/ks/pw", pathLabel: "KEEPER_KEYSTORE", passwordFileLabel: "KEEPER_KEYSTORE_PASSWORD_FILE" },
    /^讀不到 keeper keystore：KEEPER_KEYSTORE$/,
  );
  console.log("✓ 3. keystore 解密成功、密碼錯／缺檔／內容損壞都拒絕且不洩漏秘密");
}

console.log("\n✅ keySource.test.ts 全過（3 組）");
