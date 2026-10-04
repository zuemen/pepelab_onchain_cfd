import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * 傳給 dotenv `config()` 的選項。每一項都**明確寫出**，不留給 dotenv 的預設值決定：
 *
 * - dotenv 17 起 `quiet` 預設 false，18 起會在 stderr 印 `◇ injected env (N) from <path>`；
 *   keeper／CI／Vercel 的 log 不該出現任何跟 .env 有關的輸出。
 * - dotenv 17.2 起 `config()` 會從 process.env（以及剛讀進來的 .env）讀
 *   `DOTENV_QUIET`／`DOTENV_DEBUG`／`DOTENV_OVERRIDE`／`DOTENV_FAST`／`DOTENV_ENCODING`
 *   （與 `DOTENV_CONFIG_*`）當預設值；程式碼有寫的選項才會蓋過它們。不寫死的話，環境裡
 *   一個 `DOTENV_OVERRIDE=true` 就會讓 .env 蓋過已注入的 secret，`DOTENV_DEBUG=true`
 *   會把每個 key 名印到 stdout。
 *
 * 這組值等於 dotenv 16.6.1 的行為：不印 log、不覆寫既有變數、UTF-8、預設 parser。
 */
export function dotenvLoadOptions(path: string) {
  return { path, quiet: true, override: false, debug: false, fast: false, encoding: "utf8" } as const;
}

/** 統一從 agent/.env 載入環境變數（不論從哪個 workspace 啟動）。 */
export function loadEnv(): void {
  // 此檔在 agent/shared/src/env.ts → 往上三層到 agent/
  const here = dirname(fileURLToPath(import.meta.url));
  const agentRoot = resolve(here, "../../");
  config(dotenvLoadOptions(resolve(agentRoot, ".env")));
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
