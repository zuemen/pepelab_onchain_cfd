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
