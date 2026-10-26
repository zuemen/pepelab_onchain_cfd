// copy-sync 的金鑰來源、狀態檔、分段 getLogs。完全離線（暫存目錄、記憶體假節點）。
//   cd agent && npx tsx copy-sync/src/io.test.ts
import assert from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ethers } from "ethers";
import { describeBadValue, parseCli } from "./args.ts";
import {
  ANVIL_ADDRESSES,
  describeKeySource,
  executorKeySpec,
  isInsideDir,
  keyPolicyError,
  REPO_ROOT,
  loadExecutorKey,
  resolvePassword,
} from "./keys.ts";
import { scanLogs, type LogFilter, type RawLog } from "./logs.ts";
import {
  acquireProcessLock,
  bindingMismatch,
  defaultStatePath,
  emptyState,
  loadState,
  parseState,
  pruneState,
  recordKey,
  saveState,
  scopeOf,
} from "./state.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const dir = mkdtempSync(join(tmpdir(), "copy-sync-io-"));
const HOME = join(dir, "home");

try {
  // ── 金鑰來源 ─────────────────────────────────────────────────────────────
  const pk = ethers.Wallet.createRandom().privateKey;
  {
    const r = executorKeySpec({ COPY_SYNC_PRIVATE_KEY: pk }, HOME);
    assert.ok("spec" in r && r.spec.kind === "privateKey");
    assert.match((executorKeySpec({}, HOME) as { error: string }).error, /COPY_SYNC_PRIVATE_KEY 未設/);
    assert.match((executorKeySpec({ COPY_SYNC_PRIVATE_KEY: "0x1234" }, HOME) as { error: string }).error, /格式錯誤/);
    assert.match(
      (executorKeySpec({ COPY_SYNC_PRIVATE_KEY: pk, COPY_SYNC_KEYSTORE: "exec" }, HOME) as { error: string }).error,
      /只能設定一個/,
    );
    assert.match((executorKeySpec({ COPY_SYNC_KEYSTORE_PASSWORD: "x" }, HOME) as { error: string }).error, /沒有設定 COPY_SYNC_KEYSTORE/);
    const errKs = executorKeySpec({ COPY_SYNC_KEYSTORE: pk.slice(2) }, HOME) as { error: string };
    assert.match(errKs.error, /看起來是私鑰/);
    assert.ok(!errKs.error.includes(pk.slice(2)), "錯誤訊息不帶私鑰");
    ok("明文金鑰、互斥、格式錯誤與「把私鑰填進 keystore 欄位」都有明確錯誤，訊息不帶秘密");

    // 跟隨者把主錢包私鑰貼進「只填地址」的欄位（personal 模式最容易發生的混淆）：錯誤訊息會進
    // stderr、cron 日誌與 CI 日誌，而這把私鑰不在環境變數裡、redactSecrets 遮不到。
    const bare = pk.slice(2);
    const RPC = { COPY_SYNC_RPC_URL: "http://127.0.0.1:8545" };
    const leaks: Array<[string, () => unknown]> = [
      ["--followers 0x…", () => parseCli(["--followers", pk], RPC)],
      ["--followers 不含 0x", () => parseCli(["--followers", bare], RPC)],
      ["--followers 混在合法地址後面", () => parseCli(["--followers", `0x${"a1".repeat(20)},${pk}`], RPC)],
      ["COPY_SYNC_FOLLOWERS", () => parseCli([], { ...RPC, COPY_SYNC_FOLLOWERS: bare })],
      ["--tracker", () => parseCli(["--tracker", pk], RPC)],
      ["--registry=", () => parseCli([`--registry=${bare}`], RPC)],
      ["COPY_SYNC_TRACKER", () => parseCli([], { ...RPC, COPY_SYNC_TRACKER: pk })],
      ["位置參數（不認得的參數）", () => parseCli([pk], RPC)],
      ["--chain-id", () => parseCli(["--chain-id", bare], RPC)],
      ["--mode", () => parseCli(["--mode", pk], RPC)],
      ["--min-tip-wei", () => parseCli(["--min-tip-wei", pk], RPC)],
      ["--max-gas-gwei", () => parseCli(["--max-gas-gwei", pk], RPC)],
    ];
    for (const [label, f] of leaks) {
      assert.throws(f, (e: Error) => {
        const m = e.message.toLowerCase();
        assert.ok(!m.includes(bare.toLowerCase()), `${label}：錯誤訊息不得帶出 64 hex 的私鑰（${e.message}）`);
        assert.ok(!m.includes(bare.slice(0, 16).toLowerCase()), `${label}：連片段都不行`);
        return true;
      });
    }
    assert.throws(() => parseCli(["--followers", pk], RPC), /看起來像私鑰.*已拒絕且不顯示/);
    assert.throws(() => parseCli([pk], RPC), /不認得的參數：（看起來像私鑰/);
    // 其他不合法的值只顯示前 6 碼與長度；打錯的旗標名稱照印，方便找出錯字
    assert.throws(() => parseCli(["--followers", "0x1234567890abcdef"], RPC), (e: Error) =>
      /「0x1234…」（18 個字元）/.test(e.message) && !e.message.includes("567890abcdef"));
    assert.throws(() => parseCli(["--folowers", "x"], RPC), /不認得的參數：--folowers/);
    assert.equal(describeBadValue(" 0X" + bare.toUpperCase() + " ").includes(bare.toUpperCase()), false);
    ok("私鑰貼進 --followers／--tracker／--registry／位置參數／數值欄位：拒絕且錯誤訊息不帶任何片段；其他值只印前 6 碼");

    const byName = executorKeySpec({ COPY_SYNC_KEYSTORE: "copy-sync-exec" }, HOME);
    assert.ok("spec" in byName && byName.spec.kind === "keystore");
    if ("spec" in byName && byName.spec.kind === "keystore") {
      assert.equal(byName.spec.path, join(HOME, ".foundry", "keystores", "copy-sync-exec"));
      assert.deepEqual(byName.spec.password, { kind: "prompt" });
    }
    const byEnv = executorKeySpec({ COPY_SYNC_KEYSTORE: "/k/exec.json", COPY_SYNC_KEYSTORE_PASSWORD: "pw" }, HOME);
    assert.ok("spec" in byEnv && byEnv.spec.kind === "keystore" && byEnv.spec.password.kind === "env");
    const byFile = executorKeySpec({ COPY_SYNC_KEYSTORE: "~/k.json", COPY_SYNC_KEYSTORE_PASSWORD_FILE: "~/pw.txt" }, HOME);
    assert.ok("spec" in byFile && byFile.spec.kind === "keystore" && byFile.spec.password.kind === "file");
    if ("spec" in byFile && byFile.spec.kind === "keystore" && byFile.spec.password.kind === "file") {
      assert.equal(byFile.spec.path, join(HOME, "k.json"));
      assert.equal(byFile.spec.password.path, join(HOME, "pw.txt"));
    }
    assert.match(
      (executorKeySpec({ COPY_SYNC_KEYSTORE: "x", COPY_SYNC_KEYSTORE_PASSWORD_FILE: "/p", COPY_SYNC_KEYSTORE_PASSWORD: "q" }, HOME) as { error: string }).error,
      /只能設定一個/,
    );
    ok("keystore：Foundry 名稱或路徑；密碼來自檔案、環境變數或互動輸入（三者擇一）");

    // keystore／密碼檔放在 repo 目錄裡：`git add -A` 會把它們收進版本庫 → 拒絕啟動
    const fakeRepo = join(dir, "repo");
    mkdirSync(join(fakeRepo, "agent"), { recursive: true });
    const outside = join(dir, "outside");
    const inKs = executorKeySpec(
      { COPY_SYNC_KEYSTORE: join(fakeRepo, "agent", "exec.json"), COPY_SYNC_KEYSTORE_PASSWORD_FILE: join(outside, "pw") },
      HOME,
      fakeRepo,
    ) as { error: string };
    assert.match(inKs.error, /執行者的keystore（.*exec\.json）放在 repo 目錄裡/);
    assert.match(inKs.error, /\$RUNNER_TEMP/);
    const inPw = executorKeySpec(
      { COPY_SYNC_KEYSTORE: join(outside, "exec.json"), COPY_SYNC_KEYSTORE_PASSWORD_FILE: join(fakeRepo, ".copy-sync-password") },
      HOME,
      fakeRepo,
    ) as { error: string };
    assert.match(inPw.error, /執行者的密碼檔（.*\.copy-sync-password）放在 repo 目錄裡/);
    const both = executorKeySpec(
      { COPY_SYNC_KEYSTORE: join(fakeRepo, "k.json"), COPY_SYNC_KEYSTORE_PASSWORD_FILE: join(fakeRepo, "pw") },
      HOME,
      fakeRepo,
    ) as { error: string };
    assert.match(both.error, /keystore（.*）與密碼檔（.*）放在 repo 目錄裡/);
    const fine = executorKeySpec(
      { COPY_SYNC_KEYSTORE: join(outside, "exec.json"), COPY_SYNC_KEYSTORE_PASSWORD_FILE: join(outside, "pw") },
      HOME,
      fakeRepo,
    );
    assert.ok("spec" in fine, "repo 外的 keystore 與密碼檔照常可用");
    // 密碼從環境變數來時只檢查 keystore；Foundry 名稱（~/.foundry/keystores）不在 repo 裡
    assert.ok("spec" in executorKeySpec({ COPY_SYNC_KEYSTORE: join(outside, "e.json"), COPY_SYNC_KEYSTORE_PASSWORD: "pw" }, HOME, fakeRepo));
    assert.ok("spec" in executorKeySpec({ COPY_SYNC_KEYSTORE: "copy-sync-exec" }, HOME, fakeRepo));
    // 預設的 repo 根目錄就是這個 repo：agent/ 底下的 keystore 一樣被擋
    assert.match(
      (executorKeySpec({ COPY_SYNC_KEYSTORE: join(REPO_ROOT, "agent", "exec.json") }, HOME) as { error: string }).error,
      /放在 repo 目錄裡/,
    );
    assert.ok(existsSync(join(REPO_ROOT, "agent", "copy-sync", "src", "keys.ts")), "REPO_ROOT 指向 repo 根目錄");
    assert.equal(isInsideDir(fakeRepo, fakeRepo), true);
    assert.equal(isInsideDir(join(dir, "repo-other", "x"), fakeRepo), false, "名稱前綴相同的相鄰目錄不算在裡面");
    assert.equal(isInsideDir(join(fakeRepo, "..", "outside", "x"), fakeRepo), false);
    ok("keystore 或密碼檔放在 repo 目錄裡 → 拒絕啟動（git add 會把它們收進版本庫）；repo 外照常");
  }

  {
    const plain = { kind: "privateKey" as const, key: pk };
    const ks = { kind: "keystore" as const, path: "/k", pathLabel: "/k", password: { kind: "prompt" as const } };
    assert.equal(keyPolicyError({ spec: plain, chainId: 31337, allowPlaintextKey: false, address: null }), null);
    assert.match(keyPolicyError({ spec: plain, chainId: 84532, allowPlaintextKey: false, address: null })!, /--allow-plaintext-key/);
    assert.equal(keyPolicyError({ spec: plain, chainId: 84532, allowPlaintextKey: true, address: null }), null);
    assert.equal(keyPolicyError({ spec: ks, chainId: 84532, allowPlaintextKey: false, address: null }), null);
    const anvil0 = [...ANVIL_ADDRESSES][0];
    assert.equal(ANVIL_ADDRESSES.size, 10);
    assert.ok(ANVIL_ADDRESSES.has("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"), "Anvil #0");
    assert.match(keyPolicyError({ spec: ks, chainId: 84532, allowPlaintextKey: true, address: anvil0 })!, /Anvil 公開的測試金鑰/);
    assert.equal(keyPolicyError({ spec: plain, chainId: 31337, allowPlaintextKey: false, address: anvil0 }), null);
    ok("金鑰政策：明文只限 Anvil 或明確旗標；Anvil 測試金鑰不得用在其他鏈");
  }

  {
    // 低成本 scrypt，只為了讓測試快；格式與正式 keystore 相同。
    const w = ethers.Wallet.createRandom();
    const json = await ethers.encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, "correct horse", {
      scrypt: { N: 1 << 10 },
    });
    const ksPath = join(dir, "exec.json");
    writeFileSync(ksPath, json);
    writeFileSync(join(dir, "pw.txt"), "correct horse\n");
    const fromFile = await loadExecutorKey({
      kind: "keystore", path: ksPath, pathLabel: ksPath,
      password: { kind: "file", path: join(dir, "pw.txt"), label: "pw" },
    });
    assert.equal(ethers.computeAddress(fromFile.publicKey), w.address);
    const fromPrompt = await loadExecutorKey(
      { kind: "keystore", path: ksPath, pathLabel: ksPath, password: { kind: "prompt" } },
      { prompt: async () => "correct horse" },
    );
    assert.equal(ethers.computeAddress(fromPrompt.publicKey), w.address);
    const fromEnv = await loadExecutorKey(
      { kind: "keystore", path: ksPath, pathLabel: ksPath, password: { kind: "env", name: "PW" } },
      { env: { PW: "correct horse" } },
    );
    assert.equal(ethers.computeAddress(fromEnv.publicKey), w.address);
    await assert.rejects(
      loadExecutorKey({ kind: "keystore", path: ksPath, pathLabel: ksPath, password: { kind: "prompt" } }, { prompt: async () => "wrong" }),
      (e: Error) => /解密失敗/.test(e.message) && !e.message.includes("wrong"),
    );
    await assert.rejects(resolvePassword({ kind: "env", name: "PW" }, { env: {} }), /是空的/);
    await assert.rejects(resolvePassword({ kind: "file", path: join(dir, "nope"), label: "LBL" }), /讀不到.*LBL/);
    const plainKey = await loadExecutorKey({ kind: "privateKey", key: pk });
    assert.equal(plainKey.privateKey, pk);
    assert.match(describeKeySource({ kind: "privateKey", key: pk }), /明文/);
    assert.ok(!describeKeySource({ kind: "privateKey", key: pk }).includes(pk));
    ok("keystore 解密（密碼檔／互動／環境變數）；密碼錯誤的訊息不含密碼；描述不含私鑰");
  }

  // ── 狀態檔 ───────────────────────────────────────────────────────────────
  {
    const TR = "0x" + "7c".repeat(20);
    const RG = "0x" + "9e".repeat(20);
    const A = "0x" + "a1".repeat(20);
    const scope = scopeOf("personal", [A.toUpperCase().replace("0X", "0x"), A]);
    assert.equal(scope, `personal:${A}`);
    assert.equal(scopeOf("public", [A]), "public");
    assert.notEqual(defaultStatePath(1, TR, scope), defaultStatePath(1, TR, scopeOf("personal", ["0x" + "b2".repeat(20)])));
    assert.match(defaultStatePath(84532, TR, "public"), /agent\/\.state\/copy-sync\/84532-0x(7c){20}-public\.json$/);
    // 只通知模式有自己的一份狀態（檔名也看得出來），不會與同一個地址的執行者狀態互相覆蓋
    const notify = scopeOf("personal", [A], true);
    assert.equal(notify, `notify:${scope}`);
    assert.match(defaultStatePath(84532, TR, notify), /-notify-[0-9a-f]{8}\.json$/);
    assert.notEqual(defaultStatePath(84532, TR, notify), defaultStatePath(84532, TR, scope));

    const path = join(dir, "state", "s.json");
    assert.equal(loadState(path), null);
    const s = emptyState({ chainId: 31337, copyTracker: TR, registry: RG, scope });
    s.lastBlock = 42;
    s.records[recordKey(A, 0)] = {
      follower: A, recordIdx: 0, trader: RG, autoSync: true, tipWei: "1", syncedVersion: 0, latestVersion: 1,
      status: "dropped", nextCheckAt: 0, attempts: 0, updatedAt: 0,
    };
    // 既有的狀態檔若是寬鬆權限（舊版寫的 0644），存檔後也會換成 0600
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);
    saveState(path, s);
    assert.ok(!existsSync(`${path}.${process.pid}.tmp`), "暫存檔已 rename");
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600, "狀態檔只有本人讀得到（0600）");
      const fresh = join(dir, "state-new", "nested", "s.json");
      saveState(fresh, s);
      assert.equal(statSync(fresh).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(fresh)).mode & 0o077, 0, "新建的目錄不給群組／其他人權限（0700）");
    }
    const back = loadState(path)!;
    assert.equal(back.lastBlock, 42);
    assert.equal(bindingMismatch(back, { chainId: 31337, copyTracker: TR.toUpperCase().replace("0X", "0x"), registry: RG, scope }), null);
    assert.match(bindingMismatch(back, { chainId: 84532, copyTracker: TR, registry: RG, scope })!, /chainId/);
    assert.match(bindingMismatch(back, { chainId: 31337, copyTracker: RG, registry: RG, scope })!, /CopyTracker/);
    assert.match(bindingMismatch(back, { chainId: 31337, copyTracker: TR, registry: TR, scope })!, /StrategyRegistry/);
    assert.match(bindingMismatch(back, { chainId: 31337, copyTracker: TR, registry: RG, scope: "public" })!, /服務範圍/);
    assert.throws(() => parseState('{"version":2}'), /版本/);
    assert.throws(() => parseState('{"version":1,"chainId":1,"lastBlock":0,"lastRescanAt":0,"copyTracker":"x","registry":"y","scope":"public","records":{"k":{}}}'), /record k/);
    assert.throws(() => parseState("not json"));
    ok("狀態檔：原子寫入（0600）、讀回相同；綁定 chainId／tracker／registry／服務範圍，不符就拒絕");

    assert.equal(pruneState(back, 31 * 24 * 3600), 1);
    assert.equal(Object.keys(back.records).length, 0);
    ok("結束追蹤超過 30 天的 record 會被清掉");

    const release = acquireProcessLock(path);
    assert.throws(() => acquireProcessLock(path), /另一個 copy-sync 行程/);
    release();
    const again = acquireProcessLock(path);
    again();
    // 持有者已不存在（pid 不可能存在）→ 接手
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 2 ** 30, token: "dead" }));
    const taken = acquireProcessLock(path);
    assert.ok(JSON.parse(readFileSync(`${path}.lock`, "utf8")).pid === process.pid);
    taken();
    assert.ok(!existsSync(`${path}.lock`));
    ok("行程鎖：同一份狀態檔只能有一個執行者；持有者已結束就接手");
  }

  // ── 分段 getLogs ─────────────────────────────────────────────────────────
  {
    const FILTER: LogFilter = { address: ["0x" + "7c".repeat(20)], topics: [["0x" + "11".repeat(32)]] };
    const mkLog = (b: number, i: number): RawLog => ({ address: FILTER.address[0], topics: ["0x" + "11".repeat(32)], data: "0x", blockNumber: b, index: i });
    const all = [mkLog(5, 1), mkLog(5, 0), mkLog(250, 0), mkLog(999, 3)];
    const requests: Array<[number, number]> = [];
    const node = (limit: number, failAt?: number) => ({
      async getLogs(f: LogFilter & { fromBlock: number; toBlock: number }) {
        requests.push([f.fromBlock, f.toBlock]);
        if (f.toBlock - f.fromBlock > limit) {
          throw Object.assign(new Error("bad"), { error: { code: -32614, message: `eth_getLogs is limited to a ${limit} range` } });
        }
        if (failAt !== undefined && f.fromBlock <= failAt && failAt <= f.toBlock) throw new Error("ECONNRESET");
        return all.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock).reverse();
      },
    });

    const seen: RawLog[] = [];
    const chunks: Array<[number, number]> = [];
    const r1 = await scanLogs(node(200), FILTER, 0, 999, (logs, a, b) => {
      seen.push(...logs);
      chunks.push([a, b]);
    }, { retryDelayMs: 0 });
    assert.equal(r1.scannedTo, 999);
    assert.equal(r1.error, undefined);
    assert.deepEqual(chunks[0], [0, 199]);
    assert.equal(chunks.length, 5);
    assert.deepEqual(seen.map((l) => `${l.blockNumber}:${l.index}`), ["5:0", "5:1", "250:0", "999:3"]);
    assert.ok(requests.every(([a, b]) => b - a + 1 <= 200), "每段 ≤ 200 塊");
    ok("每段 ≤ 200 塊、依區塊與 logIndex 排序、依序交給呼叫端");

    requests.length = 0;
    const r2 = await scanLogs(node(50), FILTER, 0, 399, () => {}, { retryDelayMs: 0 });
    assert.equal(r2.scannedTo, 399);
    const firstChunkReqs = requests.filter(([a]) => a < 200).length;
    const secondChunkReqs = requests.filter(([a]) => a >= 200).length;
    assert.ok(firstChunkReqs > secondChunkReqs, "第二段直接用學到的段長，不必再先被拒一次");
    assert.ok(requests.slice(-4).every(([a, b]) => b - a <= 50));
    ok("節點回「範圍太大」→ 依錯誤訊息的上限切開，之後的段直接用學到的段長");

    const got: number[] = [];
    const r3 = await scanLogs(node(200, 450), FILTER, 0, 999, (_l, _a, b) => {
      got.push(b);
    }, { retryDelayMs: 0, retries: 1 });
    assert.equal(r3.scannedTo, 399, "失敗那段之前的都處理了");
    assert.deepEqual(got, [199, 399]);
    assert.ok(r3.error instanceof Error);
    ok("某一段重試後仍失敗 → 停在前一段，回報掃到哪裡（游標不越過失敗的段）");

    const r4 = await scanLogs(node(200), FILTER, 0, 999, (_l, a) => {
      if (a === 200) throw new Error("處理失敗");
    }, { retryDelayMs: 0 });
    assert.equal(r4.scannedTo, 199);
    let calls = 0;
    const r5 = await scanLogs(node(200), FILTER, 0, 999, () => void calls++, { shouldStop: () => calls >= 2 });
    assert.equal(r5.scannedTo, 399);
    const r6 = await scanLogs(node(200), FILTER, 10, 9, () => assert.fail("空範圍不應呼叫"));
    assert.equal(r6.scannedTo, 9);
    ok("呼叫端處理失敗也不推進；收到停止訊號就在段與段之間停下；空範圍不做事");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`copy-sync io: ${n} ok`);
