import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** 統一從 agent/.env 載入環境變數（不論從哪個 workspace 啟動）。 */
export function loadEnv(): void {
  // 此檔在 agent/shared/src/env.ts → 往上三層到 agent/
  const here = dirname(fileURLToPath(import.meta.url));
  const agentRoot = resolve(here, "../../");
  config({ path: resolve(agentRoot, ".env") });
}

/** 取得 PAY_TO：env 優先，否則回退到 addresses 的 FeeRouter（依專案決策）。 */
export function resolvePayTo(feeRouter: string): string {
  const fromEnv = process.env.PAY_TO?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : feeRouter;
}

/**
 * 官方 Base Sepolia USDC（Circle, EIP-3009, 6-dec）。x402 付款與結算的預設幣別。
 *
 * 稽核 2026-08-06（四·Medium）：這個常數原本在 app.ts 與 settlement.ts 各寫一份，
 * 而且**預設值不同**（app.ts 是官方 USDC、settlement.ts 回退到 MockUSDC）。
 * 於是 `_assertCurrencyMatch` 比對的是 settlement.ts 那份、對外宣告的卻是 app.ts
 * 那份，兩邊永遠不會互相抓到錯配。單一來源在此，任何地方都不准再寫死。
 */
export const OFFICIAL_BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * 結算/付款 token 的單一解析點：`X402_SETTLEMENT_TOKEN` 優先，
 * 否則一律回退到官方 Base Sepolia USDC（**不再**依呼叫端不同而回退到 MockUSDC）。
 */
export function resolveSettlementToken(): string {
  const fromEnv = process.env.X402_SETTLEMENT_TOKEN?.trim();
  return fromEnv && /^0x[0-9a-fA-F]{40}$/.test(fromEnv)
    ? fromEnv
    : OFFICIAL_BASE_SEPOLIA_USDC;
}
