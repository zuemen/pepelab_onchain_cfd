// 純函式測試：從 forge 的 broadcast 紀錄取位址、改寫前端位址表的本機鏈區塊。
//   cd agent && npx tsx heroes/addresses.test.ts
import assert from "node:assert";
import { addressesFromBroadcast, renderAnvilBlock, replaceAnvilBlock, FRONTEND_FIELDS, ZERO } from "./addresses.ts";

// 位址只用十進位數字組成：沒有英文字母，checksum 格式就不會改變大小寫，斷言好寫。
const created = (contractName: string, n: number) => ({
  transactionType: "CREATE", contractName, contractAddress: "0x" + String(n).padStart(40, "0"),
});
const BROADCAST = {
  transactions: [
    created("MockUSDC", 1), created("MockSwapRouter", 2), created("MockOracle", 3), created("ESGRegistryV2", 4),
    { transactionType: "CALL", contractName: "ESGRegistryV2", contractAddress: "0x" + "9".repeat(40) },
    created("TraderStake", 5), created("InsuranceVault", 6), created("FeeRouter", 7), created("PerpetualExchange", 8),
    created("StrategyRegistry", 9), created("CopyTracker", 10), created("AgentSessionManager", 11), created("KYCRegistry", 12),
    created("MockCarbonCredit", 13), created("CarbonRetirement", 14), created("PlatformFeeSplitter", 15),
  ],
};

// ── 取位址 ──────────────────────────────────────────────────────────────────
const found = addressesFromBroadcast(BROADCAST);
assert.equal(found.MockUSDC, "0x0000000000000000000000000000000000000001");
// 前端的 ESGRegistry 欄位指向 ESGRegistryV2（與 Base Sepolia 相同）
assert.equal(found.ESGRegistry, "0x0000000000000000000000000000000000000004");
assert.equal(found.AgentSessionManager, "0x0000000000000000000000000000000000000011");
// #333：回放每個模擬月份觸發分流與退役，也從退役合約匯出事件
assert.equal(found.CarbonRetirement, "0x0000000000000000000000000000000000000014");
assert.equal(found.PlatformFeeSplitter, "0x0000000000000000000000000000000000000015");
assert.equal(found.MockCarbonCredit, "0x0000000000000000000000000000000000000013");
// 這次沒部署的合約是 0x0，前端的「未部署」判斷靠它
assert.equal(found.PepeAMM, ZERO);
assert.equal(found.AssetVault, ZERO);
// 位址一律轉成 checksum 格式
assert.equal(
  addressesFromBroadcast({ transactions: [...BROADCAST.transactions.slice(1), {
    transactionType: "CREATE", contractName: "MockUSDC", contractAddress: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  }] }).MockUSDC,
  "0x5FbDB2315678afecb367f032d93F642f64180aa3",
);
// 少了一個必要的合約就報錯，不寫出半套位址
assert.throws(
  () => addressesFromBroadcast({ transactions: BROADCAST.transactions.filter((t) => t.contractName !== "CopyTracker") }),
  /no CREATE for CopyTracker/,
);

// ── 產生區塊 ────────────────────────────────────────────────────────────────
const block = renderAnvilBlock(found);
assert.ok(block.startsWith("const ANVIL: ChainAddresses = {\n"));
assert.ok(block.endsWith("\n}"));
for (const field of FRONTEND_FIELDS) assert.ok(block.includes(`  ${field}:`), `缺欄位 ${field}`);
assert.ok(!block.includes("AgentSessionManager"), "ChainAddresses 沒有這個欄位，寫進去會讓型別檢查失敗");
assert.ok(!block.includes("CarbonRetirement"), "前端從 FeeRouter 的平台收款人找到退役合約，不進位址表");

// ── 改寫：只動本機鏈區塊 ────────────────────────────────────────────────────
const SOURCE = [
  "export interface ChainAddresses {\n  MockUSDC: string\n}",
  "// ── Anvil local (chainId 31337) ──",
  'const ANVIL: ChainAddresses = {\n  MockUSDC:          "0x610178dA211FEF7D417bC0e6FeD39F05609AD788",\n}',
  'const SEPOLIA: ChainAddresses = {\n  MockUSDC:           "0x167Bacef1925184f0df34A3196F834C0622Cfd36",\n}',
].join("\n\n");
const rewritten = replaceAnvilBlock(SOURCE, block);
assert.ok(rewritten.includes(block));
assert.ok(rewritten.includes('const SEPOLIA: ChainAddresses = {\n  MockUSDC:           "0x167Bacef1925184f0df34A3196F834C0622Cfd36",\n}'));
assert.ok(rewritten.includes("export interface ChainAddresses {\n  MockUSDC: string\n}"));
assert.ok(!rewritten.includes("0x610178dA211FEF7D417bC0e6FeD39F05609AD788"));
assert.equal(replaceAnvilBlock(rewritten, block), rewritten, "重跑一次不該再改動檔案");
assert.throws(() => replaceAnvilBlock("const SEPOLIA = {}", block), /ANVIL block not found/);

console.log("addresses.test.ts ✓");
