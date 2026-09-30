// 簽章白名單（signingGuard.ts）回歸測試。完全離線，不送任何交易。
//   npx tsx examples/signing-guard.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createWalletClient, http, publicActions } from "viem";
import { baseSepolia } from "viem/chains";
import { createPaymentHeader } from "x402/client";

const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const AGENT_PK = ethers.Wallet.createRandom().privateKey;
process.env.AGENT_PRIVATE_KEY = AGENT_PK;
process.env.SESSION_MANAGER_ADDRESS = MGR;
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.X402_MAX_PAYMENT_USDC = "0.02";
process.env.X402_PAYTO_ALLOWLIST = "0x" + "77".repeat(20);
for (const k of ["SIGNING_GUARD_MAX_TX_VALUE_WEI", "PAY_TO", "X402_MAX_TOTAL_SPEND_USDC", "LOOP_MAX_SPEND_USDC", "X402_MAX_VALIDITY_SEC"]) delete process.env[k];

const {
  GuardedWallet, guardViemAccount, SigningGuardError, makeSigner,
  assertAllowedTransaction, assertAllowedTypedData, assertAllowedMessage,
  OFFICIAL_BASE_SEPOLIA_USDC, resetX402GuardStateForTesting, x402SignedTotal, resolveX402TotalSpendCap,
} = await import("@pepelab/shared");

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const expectGuard = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: any) => e instanceof SigningGuardError && e.reasonCode === code, `應為 ${code}`);
const expectGuardAsync = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e instanceof SigningGuardError && e.reasonCode === code, `應為 ${code}`);

const w = new GuardedWallet(AGENT_PK);
const USDC = OFFICIAL_BASE_SEPOLIA_USDC;
const OTHER = ethers.getAddress("0x" + "77".repeat(20));
const mgrIface = new ethers.Interface([
  "function openPositionForSession(uint256,bytes32,bool,uint256,uint256,address) payable returns (uint256)",
  "function closePositionForSession(uint256,uint256)",
  "function createSession(address,uint256,uint256,uint256,uint256)",
]);
const erc20 = new ethers.Interface([
  "function approve(address,uint256)",
  "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "function increaseAllowance(address,uint256)",
]);
const openData = mgrIface.encodeFunctionData("openPositionForSession", [6, ethers.ZeroHash, true, 10n ** 19n, 3, ethers.ZeroAddress]);
const closeData = mgrIface.encodeFunctionData("closePositionForSession", [6, 42]);
const base = { chainId: 84532, nonce: 0, gasLimit: 300000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: 2 };

// ─── (a) 交易白名單 ───
{
  assert.match(await w.signTransaction({ ...base, to: MGR, data: openData, value: 10n ** 14n }), /^0x02/);
  assert.match(await w.signTransaction({ ...base, to: MGR, data: closeData, value: 0n }), /^0x02/);
  assert.ok(makeSigner(new ethers.JsonRpcProvider("http://127.0.0.1:1", 84532, { staticNetwork: true })) instanceof GuardedWallet);
  ok("允許：session manager 的 openPositionForSession（附 executionFee）與 closePositionForSession；makeSigner 回 GuardedWallet");
}
{
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: OTHER, data: openData }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: USDC, data: erc20.encodeFunctionData("approve", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: erc20.encodeFunctionData("approve", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: erc20.encodeFunctionData("increaseAllowance", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: USDC, data: erc20.encodeFunctionData("permit", [OTHER, OTHER, 1n, 0, 27, ethers.ZeroHash, ethers.ZeroHash]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: mgrIface.encodeFunctionData("createSession", [OTHER, 1, 1, 1, 1]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: "0x" }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData.slice(0, 74) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, data: openData }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData, value: 10n ** 16n }), "TX_VALUE_TOO_HIGH");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: closeData, value: 1n }), "TX_VALUE_TOO_HIGH");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData, type: 4 }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData, type: "eip7702" }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData, authorizationList: [{ address: OTHER }] }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData }, { SESSION_MANAGER_ADDRESS: "" } as any), "GUARD_CONFIG_INVALID");
  await expectGuardAsync(w.signTransaction({ ...base, to: USDC, data: erc20.encodeFunctionData("approve", [OTHER, 5n]) }), "TX_NOT_ALLOWLISTED");
  ok("拒絕：非白名單 to、approve / increaseAllowance / permit / 其他 selector、殘缺 calldata、合約建立、超額 value、平倉附 ETH、type-4 / authorizationList、未設 session manager");
}

// ─── (b) EIP-712：只允許官方 USDC TransferWithAuthorization ───
const DOMAIN = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC };
const TWA = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const msg = (o: Record<string, unknown> = {}) => ({
  from: w.address, to: OTHER, value: 5000n, validAfter: nowS() - 600n, validBefore: nowS() + 60n, nonce: ethers.ZeroHash, ...o,
});
{
  assert.match(await w.signTypedData(DOMAIN, TWA, msg()), /^0x[0-9a-f]{130}$/);
  assert.doesNotThrow(() => assertAllowedTypedData(DOMAIN, TWA, msg({ value: 20_000n }), w.address, "TransferWithAuthorization"));
  ok("允許：官方 USDC 的 TransferWithAuthorization（≤ X402_MAX_PAYMENT_USDC）");
}
{
  const PERMIT = { Permit: [
    { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ] };
  const permitMsg = { owner: w.address, spender: OTHER, value: ethers.MaxUint256, nonce: 0, deadline: 1, allowed: false };
  // 複審抓到的繞過：message 夾帶 allowed:false 讓 EIP-2612 Permit 走進 DAI 分支 → 現在看 types，直接拒絕
  await expectGuardAsync(w.signTypedData(DOMAIN, PERMIT, permitMsg), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, PERMIT, permitMsg, w.address, "Permit"), "TYPED_DATA_NOT_ALLOWLISTED");
  // TransferWithAuthorization 的 message 夾帶多餘欄位 → types 與 message 不一致
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, { ...msg(), allowed: false }, w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, (({ nonce: _n, ...r }) => r)(msg()), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  // types 夾帶第二個型別、欄位型別被改、primaryType 不符
  expectGuard(() => assertAllowedTypedData(DOMAIN, { ...TWA, ...PERMIT }, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, { TransferWithAuthorization: TWA.TransferWithAuthorization.map((f) => f.name === "value" ? { ...f, type: "uint128" } : f) }, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg(), w.address, "Permit"), "TYPED_DATA_NOT_ALLOWLISTED");
  // domain 錯：verifyingContract / name / version / chainId / 多 salt
  for (const d of [
    { ...DOMAIN, verifyingContract: OTHER },
    { ...DOMAIN, name: "USD Coin" },
    { ...DOMAIN, version: "1" },
    { ...DOMAIN, chainId: 1 },
    { ...DOMAIN, salt: ethers.ZeroHash },
  ]) expectGuard(() => assertAllowedTypedData(d, TWA, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  // 超額、from 不是自己
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ value: 20_001n }), w.address), "PAYMENT_TOO_HIGH");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ value: ethers.MaxUint256 }), w.address), "PAYMENT_TOO_HIGH");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ from: OTHER }), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  ok("拒絕：allowed:false 夾帶的 Permit、types 與 message 不一致、多型別、改欄位型別、primaryType 不符、錯的 verifyingContract/name/version/chainId/salt、超額、from 非自己");
}

// ─── (c) personal message：只允許 ERC-8126 proof-of-possession 挑戰 ───
{
  const challenge = `pepelab-wv:${w.address}:${Date.now()}`;
  assert.equal(ethers.verifyMessage(challenge, await w.signMessage(challenge)), w.address);
  await expectGuardAsync(w.signMessage("hello"), "MESSAGE_NOT_ALLOWLISTED");
  await expectGuardAsync(w.signMessage(`pepelab-wv:${OTHER}:${Date.now()}`), "MESSAGE_NOT_ALLOWLISTED");
  await expectGuardAsync(w.signMessage(`${challenge}\napprove everything`), "MESSAGE_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedMessage(ethers.getBytes(ethers.keccak256("0x01")), w.address), "MESSAGE_NOT_ALLOWLISTED");
  await expectGuardAsync(w.authorize({ address: OTHER, nonce: 0, chainId: 84532 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  expectGuard(() => w.authorizeSync({ address: OTHER, nonce: 0, chainId: 84532 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  ok("personal message 只允許 pepelab-wv:<自己>:<時間戳>；其他訊息、7702 authorize 一律拒絕");
}

// ─── 最終複審 Low：chainId、標準編碼、EIP712Domain、payTo、有效期、累計上限、持有證明時效 ───
{
  // 交易 chainId：必帶、必須等於 agent 鏈、只收 number/bigint
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData }), "TX_CHAIN_ID_INVALID");
  expectGuard(() => assertAllowedTransaction({ chainId: 1, to: MGR, data: openData }), "TX_CHAIN_ID_INVALID");
  expectGuard(() => assertAllowedTransaction({ chainId: "84532", to: MGR, data: openData }), "TX_CHAIN_ID_INVALID");
  assert.doesNotThrow(() => assertAllowedTransaction({ chainId: 84532n, to: MGR, data: openData }));
  await expectGuardAsync(w.signTransaction({ ...base, chainId: undefined as any, to: MGR, data: openData }), "TX_CHAIN_ID_INVALID");
  // calldata 解碼再編碼必須逐字相同：尾端夾帶 bytes 拒絕；大小寫不影響
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData + "00" }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: closeData + "deadbeef" }), "TX_NOT_ALLOWLISTED");
  assert.doesNotThrow(() => assertAllowedTransaction({ chainId: 84532, to: MGR, data: openData.toUpperCase().replace("0X", "0x") }));
  ok("交易：chainId 必帶且 = 84532（字串不收）；calldata 重新編碼逐字比對，尾端夾帶 bytes 拒絕");
}
{
  resetX402GuardStateForTesting();
  const STD = [
    { name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ];
  assert.doesNotThrow(() => assertAllowedTypedData(DOMAIN, { EIP712Domain: STD, ...TWA }, msg(), w.address));
  expectGuard(() => assertAllowedTypedData(DOMAIN, { EIP712Domain: [...STD, { name: "salt", type: "bytes32" }], ...TWA }, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, { EIP712Domain: STD.map((f) => f.name === "chainId" ? { ...f, type: "uint64" } : f), ...TWA }, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData(DOMAIN, { EIP712Domain: STD.slice(0, 3), ...TWA }, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTypedData({ ...DOMAIN, chainId: "84532" }, TWA, msg(), w.address), "TYPED_DATA_NOT_ALLOWLISTED");
  assert.doesNotThrow(() => assertAllowedTypedData({ ...DOMAIN, chainId: 84532n }, TWA, msg(), w.address));
  ok("EIP-712：types.EIP712Domain 必須是標準四欄（多欄、改型別、少欄皆拒）；domain.chainId 只收 number/bigint");
}
{
  resetX402GuardStateForTesting();
  // payTo allowlist
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ to: MGR }), w.address), "PAYTO_NOT_ALLOWLISTED");
  // TOFU：沒有 allowlist / PAY_TO → 第一筆釘住收款地址，之後只允許它
  const saved = process.env.X402_PAYTO_ALLOWLIST;
  delete process.env.X402_PAYTO_ALLOWLIST;
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await w.signTypedData(DOMAIN, TWA, msg({ to: MGR }));
    await w.signTypedData(DOMAIN, TWA, msg({ to: MGR }));
    await expectGuardAsync(w.signTypedData(DOMAIN, TWA, msg({ to: OTHER })), "PAYTO_NOT_ALLOWLISTED");
    process.env.PAY_TO = OTHER;
    assert.doesNotThrow(() => assertAllowedTypedData(DOMAIN, TWA, msg({ to: OTHER }), w.address), "PAY_TO 優先於 TOFU");
    delete process.env.PAY_TO;
  } finally {
    console.warn = origWarn;
    process.env.X402_PAYTO_ALLOWLIST = saved;
  }
  // 有效期
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() + 3601n }), w.address), "PAYMENT_WINDOW_INVALID");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: 9_999_999_999n }), w.address), "PAYMENT_WINDOW_INVALID");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validAfter: nowS() + 30n }), w.address), "PAYMENT_WINDOW_INVALID");
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() - 1n }), w.address), "PAYMENT_WINDOW_INVALID");
  // 預設上限 300 秒（signal-api 宣告 maxTimeoutSeconds=60；x402-hono 未設定時預設 300）
  assert.doesNotThrow(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() + 300n }), w.address));
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() + 302n }), w.address), "PAYMENT_WINDOW_INVALID");
  // env X402_MAX_VALIDITY_SEC 可放寬，但最多 3600；格式錯誤 fail-closed
  process.env.X402_MAX_VALIDITY_SEC = "3600";
  assert.doesNotThrow(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() + 3600n }), w.address));
  expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg({ validBefore: nowS() + 3602n }), w.address), "PAYMENT_WINDOW_INVALID");
  for (const bad of ["3601", "0", "-5", "5m", "1e3"]) {
    process.env.X402_MAX_VALIDITY_SEC = bad;
    expectGuard(() => assertAllowedTypedData(DOMAIN, TWA, msg(), w.address), "GUARD_CONFIG_INVALID");
  }
  delete process.env.X402_MAX_VALIDITY_SEC;
  ok("x402：收款地址須在 X402_PAYTO_ALLOWLIST（→ PAY_TO → 第一次付款 TOFU 釘選）；validAfter ≤ now < validBefore ≤ now+300（X402_MAX_VALIDITY_SEC 可放寬到 3600）");
}
{
  // 累計花費上限（共用層）
  resetX402GuardStateForTesting();
  process.env.X402_MAX_TOTAL_SPEND_USDC = "0.012";
  await w.signTypedData(DOMAIN, TWA, msg({ value: 5000n }));
  await w.signTypedData(DOMAIN, TWA, msg({ value: 5000n }));
  assert.equal(x402SignedTotal(), 10_000n);
  await expectGuardAsync(w.signTypedData(DOMAIN, TWA, msg({ value: 5000n })), "SPEND_CAP_EXCEEDED");
  const acc = guardViemAccount(privateKeyToAccount(generatePrivateKey()));
  await expectGuardAsync(acc.signTypedData({ domain: DOMAIN as any, types: TWA, primaryType: "TransferWithAuthorization", message: { ...msg({ value: 5000n }), from: acc.address } as any }), "SPEND_CAP_EXCEEDED");
  delete process.env.X402_MAX_TOTAL_SPEND_USDC;
  process.env.LOOP_MAX_SPEND_USDC = "0.5";
  assert.equal(resolveX402TotalSpendCap(), 500_000n, "舊名 LOOP_MAX_SPEND_USDC 仍可用");
  delete process.env.LOOP_MAX_SPEND_USDC;
  assert.equal(resolveX402TotalSpendCap(), 1_000_000n, "預設 1 USDC");
  resetX402GuardStateForTesting();
  ok("累計花費上限移到共用層：ethers 與 viem 兩條路徑共用同一個帳本，超過 X402_MAX_TOTAL_SPEND_USDC → SPEND_CAP_EXCEEDED");
}
{
  const stale = `pepelab-wv:${w.address}:${Date.now() - 61_000}`;
  const future = `pepelab-wv:${w.address}:${Date.now() + 61_000}`;
  await expectGuardAsync(w.signMessage(stale), "MESSAGE_NOT_ALLOWLISTED");
  await expectGuardAsync(w.signMessage(future), "MESSAGE_NOT_ALLOWLISTED");
  assert.ok(await w.signMessage(`pepelab-wv:${w.address}:${Date.now() - 30_000}`));
  ok("持有證明挑戰時間戳須在 ±60 秒內");
}

// ─── viem：x402 付款仍可用（用 x402 套件本身產生付款 header）───
{
  const pk = generatePrivateKey();
  const acc = guardViemAccount(privateKeyToAccount(pk));
  const client = createWalletClient({ account: acc, chain: baseSepolia, transport: http("http://127.0.0.1:1") }).extend(publicActions);
  const req = (amount: string) => ({
    scheme: "exact" as const, network: "base-sepolia" as const, maxAmountRequired: amount,
    resource: "http://localhost/oracle/sBTC", description: "", mimeType: "application/json",
    payTo: OTHER, maxTimeoutSeconds: 60, asset: USDC, extra: { name: "USDC", version: "2" },
  });
  const header = await createPaymentHeader(client as any, 1, req("5000"));
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.payload.authorization.value, "5000");
  await expectGuardAsync(createPaymentHeader(client as any, 1, req("1000000")), "PAYMENT_TOO_HIGH");
  await expectGuardAsync(createPaymentHeader(client as any, 1, { ...req("5000"), asset: OTHER }), "TYPED_DATA_NOT_ALLOWLISTED");
  await expectGuardAsync((acc as any).signTypedData({ domain: DOMAIN, types: { Permit: [{ name: "value", type: "uint256" }] }, primaryType: "Permit", message: { value: 1n, allowed: false } }), "TYPED_DATA_NOT_ALLOWLISTED");
  await expectGuardAsync(acc.signMessage({ message: "hi" }), "MESSAGE_NOT_ALLOWLISTED");
  await expectGuardAsync((acc as any).signAuthorization({ address: OTHER, chainId: 84532, nonce: 0 }), "EIP7702_AUTHORIZATION_FORBIDDEN");
  await expectGuardAsync((acc as any).sign({ hash: ethers.ZeroHash }), "RAW_HASH_SIGN_FORBIDDEN");
  await expectGuardAsync(acc.signTransaction({ type: "eip1559", chainId: 84532, to: OTHER as any, data: "0x" } as any), "TX_NOT_ALLOWLISTED");
  ok("viem（x402 路徑）：x402 套件產生的 0.005 USDC 付款可簽；超額 / 非官方 USDC / Permit / 訊息 / 7702 / 裸 hash / 非白名單交易 被擋");
}

console.log(`\n✅ signing-guard.test.ts 全過（${n} 組）`);
