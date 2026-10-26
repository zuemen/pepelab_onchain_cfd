// copy-sync 的純函式：參數解析、錯誤分類、簽章白名單、日誌遮蔽、通知。完全離線。
//   cd agent && npx tsx copy-sync/src/units.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { parseCli } from "./args.ts";
import { CATEGORY_LABEL, classifyRevert, isRevert, MAX_RETRY_SEC, nextRetryAt, revertDataOf } from "./errors.ts";
import { assertResyncTransaction, ExecutorGuardError, ExecutorWallet, RESYNC_FOR_SELECTOR } from "./guard.ts";
import { errText, makeRedactor, urlSecretParts } from "./log.ts";
import { makeWebhookNotifier, webhookUrlError, type NotifyPayload } from "./notify.ts";
import { REVERT_DECODE_ABI } from "./abi.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const A = ethers.getAddress("0x" + "a1".repeat(20));
const B = ethers.getAddress("0x" + "b2".repeat(20));
const TRACKER = ethers.getAddress("0x" + "7c".repeat(20));
const RPC = "https://base-sepolia.example.com/v2/SuperSecretRpcKey1234567890";
const ENV = { COPY_SYNC_RPC_URL: RPC };

// ── args ─────────────────────────────────────────────────────────────────────
{
  const c = parseCli([], ENV);
  assert.equal(c.mode, "public");
  assert.deepEqual(c.followers, []);
  assert.equal(c.rpcUrl, RPC);
  assert.equal(c.confirmations, null);
  assert.equal(c.intervalSec, 30);
  assert.equal(c.minTipWei, 0n);
  assert.equal(c.maxGasPriceWei, null);
  assert.equal(c.dryRun, false);
  assert.equal(c.once, false);
  ok("預設：public 模式、RPC 取自 COPY_SYNC_RPC_URL");

  const p = parseCli(["--followers", `${A},${A.toLowerCase()} ${B}`, "--once", "--dry-run", "--max-gas-gwei=1.5"], ENV);
  assert.equal(p.mode, "personal");
  assert.deepEqual(p.followers, [A.toLowerCase(), B.toLowerCase()]);
  assert.ok(p.once && p.dryRun);
  assert.equal(p.maxGasPriceWei, 1_500_000_000n);
  ok("給 --followers 就是 personal，地址去重、轉小寫；--flag=value 也接受");

  assert.throws(() => parseCli(["--mode", "personal"], ENV), /需要 --followers/);
  assert.throws(() => parseCli(["--mode", "public", "--followers", A], ENV), /不需要 --followers/);
  assert.throws(() => parseCli(["--followers", "0x1234"], ENV), /不合法的地址/);
  assert.throws(() => parseCli(["--followers", ethers.ZeroAddress], ENV), /零地址/);
  assert.throws(() => parseCli([], {}), /缺少 RPC/);
  assert.throws(() => parseCli(["--bogus"], ENV), /不認得的參數/);
  assert.throws(() => parseCli(["--interval-sec", "0"], ENV), /介於/);
  assert.throws(() => parseCli(["--min-tip-wei", "-1"], ENV), /非負整數/);
  assert.throws(() => parseCli(["--tracker"], ENV), /需要一個值/);
  assert.throws(() => parseCli(["--rpc-url", "file:///etc/passwd"], {}), /只接受 http/);
  ok("不合法的參數一律拒絕");

  try {
    parseCli(["--rpc-url", "not a url SuperSecretRpcKey"], {});
    assert.fail("應該丟錯");
  } catch (e) {
    assert.ok(!(e as Error).message.includes("SuperSecret"), "錯誤訊息不得帶 RPC 值");
  }
  ok("RPC 格式錯誤時，訊息不帶網址本身");

  assert.equal(parseCli(["--allow-plaintext-key"], ENV).allowPlaintextKey, true);
  assert.equal(parseCli([], { ...ENV, COPY_SYNC_ALLOW_PLAINTEXT_KEY: "1" }).allowPlaintextKey, true);
  assert.equal(parseCli([], { BASE_SEPOLIA_RPC_URL: RPC }).rpcUrl, RPC);
  assert.equal(parseCli(["--help"], {}).help, true);
  ok("--allow-plaintext-key／BASE_SEPOLIA_RPC_URL 退回／--help 不需要 RPC");

  const no = parseCli(["--notify-only", "--followers", A, "--once"], ENV);
  assert.ok(no.notifyOnly && !no.dryRun && no.mode === "personal");
  assert.equal(parseCli(["--followers", A], { ...ENV, COPY_SYNC_NOTIFY_ONLY: "1" }).notifyOnly, true);
  assert.equal(parseCli(["--followers", A], ENV).notifyOnly, false);
  assert.throws(() => parseCli(["--notify-only"], ENV), /personal 模式/);
  assert.throws(() => parseCli(["--notify-only", "--mode", "public"], ENV), /personal 模式/);
  assert.throws(() => parseCli(["--notify-only", "--dry-run", "--followers", A], ENV), /擇一/);
  ok("--notify-only：只限 personal 模式、與 --dry-run 擇一、env COPY_SYNC_NOTIFY_ONLY=1");
}

// ── errors ───────────────────────────────────────────────────────────────────
const ERR = new ethers.Interface(REVERT_DECODE_ABI as unknown as string[]);
const enc = (name: string, args: unknown[] = []) => ERR.encodeErrorResult(name, args);
{
  assert.equal(classifyRevert(enc("AlreadySynced", [1, 1])).category, "synced");
  assert.equal(classifyRevert(enc("AutoSyncDisabled")).category, "dropped");
  assert.equal(classifyRevert(enc("RecordAlreadyInactive")).category, "dropped");
  const notMine = classifyRevert(enc("NotSyncExecutor", [A]));
  assert.equal(notMine.category, "dropped", "跟隨者指定了別的執行者");
  assert.match(notMine.detail, /NotSyncExecutor\(executor=0x/);
  const kyc = classifyRevert(enc("NotKycVerified", [A]));
  assert.equal(kyc.category, "kyc");
  assert.match(kyc.detail, /NotKycVerified\(user=0x/);
  assert.match(kyc.detail, /KYC/);
  assert.equal(classifyRevert(enc("AssetNotActive", [ethers.id("sAAPL"), 1])).category, "market");
  assert.equal(classifyRevert(enc("AssetHalted", [ethers.id("sAAPL")])).category, "market");
  assert.equal(classifyRevert(enc("EnforcedPause")).category, "market");
  assert.equal(classifyRevert(enc("PositionStillOpen", [7])).category, "market");
  assert.equal(classifyRevert(enc("OpenInterestCapExceeded", [ethers.id("sBTC"), true, 1, 0])).category, "capacity");
  assert.equal(classifyRevert(enc("InsufficientSyncGas", [10, 1])).category, "gas");
  const fc = classifyRevert(enc("ExecutionFeeAboveCap", [2n * 10n ** 14n, 10n ** 14n]));
  assert.equal(fc.category, "consent");
  assert.match(fc.detail, /fee=200000000000000, cap=100000000000000/);
  assert.equal(classifyRevert(enc("TraderNotEligible", [A])).category, "trader");
  assert.equal(classifyRevert(enc("NotCopyTracker")).category, "config");
  assert.equal(classifyRevert(enc("EthTransferFailed")).category, "config");
  assert.equal(classifyRevert(enc("NothingToRedeploy")).category, "capacity");
  assert.equal(classifyRevert(enc("SyncDisturbedOtherPositions")).category, "market");
  assert.match(classifyRevert(enc("AlreadySynced", [2, 2])).detail, /recordVersion=2, latestVersion=2/);
  const cd = classifyRevert(enc("SyncCooldown", [1_700_000_000]));
  assert.equal(cd.category, "cooldown");
  assert.equal(cd.readyAt, 1_700_000_000);
  ok("合約與交易所的錯誤依名稱分類（KYC、休市、油箱、執行費同意上限、冷卻、資格、授權）");

  const reqStr = new ethers.Interface(["error Error(string)"]).encodeErrorResult("Error", ["StrategyRegistry: no strategies"]);
  assert.equal(classifyRevert(reqStr).category, "trader");
  const unknownSel = classifyRevert("0xdeadbeef");
  assert.equal(unknownSel.category, "unknown");
  assert.equal(unknownSel.name, "0xdeadbeef");
  assert.equal(classifyRevert({ code: "CALL_EXCEPTION", data: "0x" }).category, "unknown");
  ok("require 字串、未知 selector、空 revert 都有合理分類");

  // ethers 包裝過的錯誤：data 在 info.error.data
  const wrapped = { code: "CALL_EXCEPTION", info: { error: { data: enc("AlreadySynced", [1, 1]) } } };
  assert.equal(revertDataOf(wrapped), enc("AlreadySynced", [1, 1]));
  assert.ok(isRevert(wrapped));
  assert.ok(!isRevert(new Error("ECONNRESET")));
  assert.ok(!isRevert({ code: "NETWORK_ERROR", message: "x" }));
  ok("從 ethers 錯誤的各種包裝裡找到 revert data；RPC 錯誤不算 revert");

  const now = 1_000_000;
  assert.equal(nextRetryAt({ category: "cooldown", readyAt: now + 50 }, now, 1), now + 51);
  assert.equal(nextRetryAt({ category: "market" }, now, 1), now + 600);
  assert.equal(nextRetryAt({ category: "market" }, now, 2), now + 1200);
  assert.equal(nextRetryAt({ category: "market" }, now, 99), now + 600 * 32);
  assert.equal(nextRetryAt({ category: "kyc" }, now, 99), now + MAX_RETRY_SEC);
  assert.equal(nextRetryAt({ category: "synced" }, now, 1), Number.POSITIVE_INFINITY);
  assert.equal(nextRetryAt({ category: "consent" }, now, 1), now + 3600);
  assert.ok(Object.keys(CATEGORY_LABEL).length === 11);
  ok("重試排程：冷卻用 readyAt、其餘指數退避、上限 6 小時");
}

// ── guard ────────────────────────────────────────────────────────────────────
const RESYNC = new ethers.Interface(["function resyncFor(address follower, uint256 recordIdx)"]);
const goodTx = () => ({ to: TRACKER, data: RESYNC.encodeFunctionData("resyncFor", [A, 3]), value: 0n, chainId: 84532n });
const cfg = { copyTracker: TRACKER, chainId: 84532 };
const expectGuard = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => e instanceof ExecutorGuardError && e.reasonCode === code, `應為 ${code}`);
{
  const r = assertResyncTransaction(goodTx(), cfg);
  assert.equal(r.follower, A);
  assert.equal(r.recordIdx, 3n);
  assert.equal(RESYNC_FOR_SELECTOR, RESYNC.getFunction("resyncFor")!.selector);
  ok("白名單：對 CopyTracker 的 resyncFor、value 0、chainId 相符 → 放行");

  expectGuard(() => assertResyncTransaction({ ...goodTx(), to: B }, cfg), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), to: undefined }, cfg), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), chainId: 1n }, cfg), "TX_CHAIN_ID_INVALID");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), chainId: undefined }, cfg), "TX_CHAIN_ID_INVALID");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), value: 1n }, cfg), "TX_VALUE_NOT_ZERO");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), type: 4 }, cfg), "EIP7702_FORBIDDEN");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), authorizationList: [{}] }, cfg), "EIP7702_FORBIDDEN");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), data: goodTx().data + "00" }, cfg), "TX_NOT_ALLOWLISTED");
  const erc20 = new ethers.Interface(["function transfer(address,uint256)", "function approve(address,uint256)"]);
  expectGuard(() => assertResyncTransaction({ ...goodTx(), data: erc20.encodeFunctionData("transfer", [B, 1]) }, cfg), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertResyncTransaction({ ...goodTx(), data: erc20.encodeFunctionData("approve", [B, 1]) }, cfg), "TX_NOT_ALLOWLISTED");
  ok("白名單：別的合約、別的函式、附 ETH、錯鏈、7702、尾端夾帶資料 → 拒絕");

  const w = new ExecutorWallet(ethers.Wallet.createRandom().privateKey, cfg);
  const signed = await w.signTransaction({ ...goodTx(), nonce: 0, gasLimit: 300_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 });
  assert.equal(ethers.Transaction.from(signed).to, TRACKER);
  await assert.rejects(w.signTransaction({ to: B, value: 1n, chainId: 84532n, nonce: 0, gasLimit: 21_000n, gasPrice: 1n }), ExecutorGuardError);
  await assert.rejects(w.signMessage(), /MESSAGE_FORBIDDEN/);
  assert.throws(() => w.signMessageSync(), /MESSAGE_FORBIDDEN/);
  await assert.rejects(w.signTypedData(), /TYPED_DATA_FORBIDDEN/);
  await assert.rejects(w.authorize(), /EIP7702_FORBIDDEN/);
  assert.throws(() => w.authorizeSync(), /EIP7702_FORBIDDEN/);
  const reconnected = w.connect(null);
  assert.ok(reconnected instanceof ExecutorWallet);
  await assert.rejects(reconnected.signTransaction({ to: B, value: 1n, chainId: 84532n, nonce: 0, gasLimit: 21_000n, gasPrice: 1n }), ExecutorGuardError);
  ok("ExecutorWallet：只簽得出 resyncFor；轉帳、訊息、EIP-712、7702 全拒；connect() 後仍受限");
}

// ── log 遮蔽 ────────────────────────────────────────────────────────────────
{
  const hook = "https://hooks.slack.com/services/T000/B000/XXXXsecretXXXX";
  const red = makeRedactor([RPC, hook]);
  const line = red(`連線失敗 ${RPC} 與 ${hook}；requestUrl="${RPC}"`);
  assert.ok(!line.includes("SuperSecretRpcKey"), line);
  assert.ok(!line.includes("XXXXsecretXXXX"), line);
  assert.ok(urlSecretParts(RPC).includes("SuperSecretRpcKey1234567890"));
  const err = Object.assign(new Error(`could not coalesce error (info={ "requestUrl": "${RPC}" })`), {});
  assert.ok(!errText(err, red).includes("SuperSecret"));
  assert.ok(errText({ shortMessage: "x".repeat(500) }, red).length <= 201);
  // 私鑰安全網（shared/redact.ts：所有 *_PRIVATE_KEY）
  const pk = ethers.Wallet.createRandom().privateKey;
  process.env.COPY_SYNC_PRIVATE_KEY = pk;
  assert.ok(!red(`key=${pk} upper=${pk.toUpperCase().replace("0X", "0x")}`).toLowerCase().includes(pk.slice(2).toLowerCase()));
  delete process.env.COPY_SYNC_PRIVATE_KEY;
  ok("日誌遮蔽：指令列的 RPC、webhook、ethers requestUrl、私鑰都不會印出");
}

// ── notify ───────────────────────────────────────────────────────────────────
{
  assert.equal(webhookUrlError("https://example.com/hook"), null);
  assert.equal(webhookUrlError("http://localhost:8080/x"), null);
  assert.equal(webhookUrlError("http://127.0.0.1/x"), null);
  assert.match(webhookUrlError("http://example.com/x")!, /https/);
  assert.match(webhookUrlError("ftp://x")!, /https/);
  assert.match(webhookUrlError("nope")!, /合法/);

  const calls: Array<{ url: string; body: NotifyPayload; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const payload: NotifyPayload = {
    source: "pepefi-copy-sync", kind: "blocked", chainId: 31337, copyTracker: TRACKER, follower: A, recordIdx: 0,
    trader: B, fromVersion: 0, toVersion: 1, category: "kyc", autoSync: true, message: "x", txHash: null, executor: null, retryAt: null,
    at: new Date(0).toISOString(),
  };
  const errs: string[] = [];
  await makeWebhookNotifier("https://example.com/hook", { fetchImpl: fakeFetch, onError: (m) => errs.push(m) })(payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].body.category, "kyc");
  assert.deepEqual(errs, []);

  const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
  await makeWebhookNotifier("https://example.com/hook", { fetchImpl: failing, onError: (m) => errs.push(m) })(payload);
  const hanging = ((_u: string, init: RequestInit) =>
    new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
  await makeWebhookNotifier("https://example.com/hook", { fetchImpl: hanging, timeoutMs: 20, onError: (m) => errs.push(m) })(payload);
  assert.equal(errs.length, 2);
  assert.match(errs[0], /HTTP 500/);
  assert.match(errs[1], /逾時/);
  assert.ok(errs.every((m) => !m.includes("example.com")), "通知錯誤不印 webhook 網址");
  ok("webhook：只收 https（本機例外）、POST JSON、不跟隨轉址、失敗與逾時只記錄不中斷");
}

console.log(`copy-sync units: ${n} ok`);
