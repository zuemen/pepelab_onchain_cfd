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
delete process.env.SIGNING_GUARD_MAX_TX_VALUE_WEI;

const {
  GuardedWallet, guardViemAccount, SigningGuardError, makeSigner,
  assertAllowedTransaction, assertAllowedTypedData, assertAllowedMessage,
  OFFICIAL_BASE_SEPOLIA_USDC,
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
  expectGuard(() => assertAllowedTransaction({ to: OTHER, data: openData }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: USDC, data: erc20.encodeFunctionData("approve", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: erc20.encodeFunctionData("approve", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: erc20.encodeFunctionData("increaseAllowance", [OTHER, 1n]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: USDC, data: erc20.encodeFunctionData("permit", [OTHER, OTHER, 1n, 0, 27, ethers.ZeroHash, ethers.ZeroHash]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: mgrIface.encodeFunctionData("createSession", [OTHER, 1, 1, 1, 1]) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: "0x" }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData.slice(0, 74) }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ data: openData }), "TX_NOT_ALLOWLISTED");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData, value: 10n ** 16n }), "TX_VALUE_TOO_HIGH");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: closeData, value: 1n }), "TX_VALUE_TOO_HIGH");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData, type: 4 }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData, type: "eip7702" }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData, authorizationList: [{ address: OTHER }] }), "EIP7702_TX_FORBIDDEN");
  expectGuard(() => assertAllowedTransaction({ to: MGR, data: openData }, { SESSION_MANAGER_ADDRESS: "" } as any), "GUARD_CONFIG_INVALID");
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
const msg = (o: Record<string, unknown> = {}) => ({
  from: w.address, to: OTHER, value: 5000n, validAfter: 0n, validBefore: 9_999_999_999n, nonce: ethers.ZeroHash, ...o,
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
