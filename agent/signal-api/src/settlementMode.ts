// x402 分潤結算模式（docs/ADR-021-signal-api-shared-state.md §3）。
//
// 平台的付費端點在確認收款後，把 70/20/10 分潤推進 Upstash 結算佇列，由 x402-settlement-worker.yml
// 的單一 worker 送 FeeRouter.routeExternalRevenue（回應 settled:true＝已入列）。但「設了 Upstash」不等於
// 「有結算目標」：專屬租戶（例如 rwa-poc）為了 KYA 花費帳與防重放設了自己的 Upstash，卻沒有自己的
// x402 FeeRouter、沒有結算金鑰、也沒有租戶結算 worker（docs/TENANT_OPERATIONS.md §2.1）。以前這時照樣
// 入列並回 settled:true——佇列永遠不會被處理，回應卻說「已排入結算」。
//
// X402_SETTLEMENT_MODE：
//   queue（預設）  與以前相同：入列，settled 代表「已排入結算佇列」（平台）。
//   off            本部署沒有分潤結算目標：不入列、不記 v2 結果不明的對帳列，回應 settled:false，
//                  settleError 以 `revenue_sharing_off` 開頭說明款項已直接付到 payTo、不會有分潤上鏈。
// 其他值：印 ::error::，照 queue 處理（保留資料、行為與以前相同；不會因為打錯字就丟掉平台的分潤列）。
import { recordUnknownSettlement, type RecordUnknownResult } from "./ledger.ts";

export type X402SettlementMode = "queue" | "off";

/** off 模式回應的 settleError（前綴是給程式判斷的原因代碼）。 */
export const REVENUE_SHARING_OFF_ERROR =
  "revenue_sharing_off：本部署沒有分潤結算目標（X402_SETTLEMENT_MODE=off）。" +
  "款項已由 facilitator 直接付到 payTo；沒有排入分潤佇列，也不會有分潤交易上鏈";

let warnedInvalid = false;

/** 每次呼叫時讀 env（與 ledger.ts 的 isLedgerEnabled 相同；測試可切換）。 */
export function resolveX402SettlementMode(env: NodeJS.ProcessEnv = process.env): X402SettlementMode {
  const raw = env.X402_SETTLEMENT_MODE?.trim().toLowerCase();
  if (!raw || raw === "queue") return "queue";
  if (raw === "off") return "off";
  if (!warnedInvalid) {
    warnedInvalid = true;
    console.error(`::error::[x402] X402_SETTLEMENT_MODE=${raw} 無法辨識（只接受 queue／off），照 queue 處理`);
  }
  return "queue";
}

export function isRevenueSharingOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveX402SettlementMode(env) === "off";
}

/** off 模式下 `GET /` 的 revenueModel：只描述實際發生的那一筆（沒有分潤）。 */
export function revenueModelWithoutSharing(payTo: string, facilitatorUrl: string): string {
  return (
    `x402 付款直接進 payTo（${payTo}），這筆 EIP-3009 交易由 facilitator（${facilitatorUrl}）送出並支付 gas。` +
    "本部署沒有分潤結算目標（X402_SETTLEMENT_MODE=off）：不排入分潤佇列、不會有 FeeRouter 分潤交易，" +
    "付費回應的 settled 一律為 false，settleError 以 revenue_sharing_off 開頭說明。"
  );
}

/**
 * v2 結算結果不明的付款：queue 模式交給 ledger 的對帳佇列（結算 worker 核對後補分潤）；
 * off 模式沒有 worker、也沒有分潤可補，不入列，只寫一行 log（付款資料都是鏈上公開資訊）。
 */
export async function recordUnknownSettlementUnlessOff(
  record: object,
  deps: { env?: NodeJS.ProcessEnv; record?: (r: object) => Promise<RecordUnknownResult> } = {},
): Promise<RecordUnknownResult | "skipped"> {
  if (isRevenueSharingOff(deps.env)) {
    console.warn(`[x402v2] settlement_unknown（X402_SETTLEMENT_MODE=off：不入對帳佇列）：${JSON.stringify(record)}`);
    return "skipped";
  }
  return (deps.record ?? recordUnknownSettlement)(record);
}
