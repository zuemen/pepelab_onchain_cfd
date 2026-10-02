// x402 v2 的 `payment-identifier`（client 自選的付款 id）——只放純函式與常數，不依賴任何 x402 套件。
//
// 規格：x402-foundation/x402 specs/extensions/payment_identifier.md
//   - client 付款時在 PaymentPayload.extensions["payment-identifier"].info.id 帶一個自己產生的 id
//     （16–128 字元，英數、底線、連字號）。
//   - 規格要求宣告這個擴充的伺服器做請求層冪等：同 id 同內容回快取的回應、同 id 不同內容回 409。
//
// **signal-api 不宣告這個擴充**（沒有實作上述請求層冪等）。client 帶了 id 照樣收，只讀出來當
// 中繼資料存進帳本（LedgerEntry.paymentId），不參與去重、格式不合也不報錯（直接不記）。
// 見 docs/ADR-010-x402-v2-migration.md。
//
// 這裡的常數與 @x402/extensions 2.28.0 的 payment-identifier 模組逐一核對過
// （PAYMENT_ID_MIN_LENGTH=16、PAYMENT_ID_MAX_LENGTH=128、PAYMENT_ID_PATTERN=/^[a-zA-Z0-9_-]+$/）。

export const PAYMENT_IDENTIFIER = "payment-identifier";
export const PAYMENT_ID_MIN_LENGTH = 16;
export const PAYMENT_ID_MAX_LENGTH = 128;
export const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;


export function isValidPaymentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= PAYMENT_ID_MIN_LENGTH &&
    id.length <= PAYMENT_ID_MAX_LENGTH &&
    PAYMENT_ID_PATTERN.test(id)
  );
}


/** base64 JSON → 物件；解不開回 null。x402 的 header 全部是這個編碼。 */
export function decodeBase64Json(header: string | null | undefined): Record<string, any> | null {
  if (!header) return null;
  try {
    const j: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return j !== null && typeof j === "object" ? (j as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * 讀出 PaymentPayload 帶的 payment-identifier。
 *   - 沒帶（或帶了宣告但沒有 id）→ { id: null, valid: true }
 *   - 帶了合法 id → { id, valid: true }
 *   - 帶了 id 但格式不合 → { id: null, valid: false }（伺服器不記，也不報錯）
 */
export function readPaymentIdentifier(payload: unknown): { id: string | null; valid: boolean } {
  const ext = (payload as { extensions?: Record<string, unknown> } | null)?.extensions?.[PAYMENT_IDENTIFIER];
  if (ext === undefined || ext === null) return { id: null, valid: true };
  if (typeof ext !== "object") return { id: null, valid: false };
  const info = (ext as { info?: unknown }).info;
  if (info === undefined || info === null) return { id: null, valid: true };
  if (typeof info !== "object") return { id: null, valid: false };
  const id = (info as { id?: unknown }).id;
  if (id === undefined) return { id: null, valid: true };
  return isValidPaymentId(id) ? { id, valid: true } : { id: null, valid: false };
}
