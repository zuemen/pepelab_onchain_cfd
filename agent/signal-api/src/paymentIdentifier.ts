// x402 v2 的 `payment-identifier` 擴充（冪等）——只放純函式與常數，不依賴任何 x402 套件。
//
// 規格：x402-foundation/x402 specs/extensions/payment_identifier.md
//   - 伺服器在 PaymentRequired.extensions["payment-identifier"] 宣告 { info: { required }, schema }。
//   - client 付款時在 PaymentPayload.extensions["payment-identifier"].info.id 帶一個自己產生的 id
//     （16–128 字元，英數、底線、連字號；建議 `pay_` + UUID v4 去掉連字號）。
//   - 同一個 id 代表同一筆「邏輯上的付款」。
//
// 這裡的常數與 @x402/extensions 2.28.0 的 payment-identifier 模組逐一核對過
// （PAYMENT_ID_MIN_LENGTH=16、PAYMENT_ID_MAX_LENGTH=128、PAYMENT_ID_PATTERN=/^[a-zA-Z0-9_-]+$/）。
// 不直接依賴 @x402/extensions：它會把 ajv、siwe、jose、tweetnacl 帶進 Vercel bundle，
// 而我們需要的只有下面這幾十行（見 docs/ADR-009-x402-v2-migration.md）。

export const PAYMENT_IDENTIFIER = "payment-identifier";
export const PAYMENT_ID_MIN_LENGTH = 16;
export const PAYMENT_ID_MAX_LENGTH = 128;
export const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 伺服器宣告用的 JSON Schema（與 @x402/extensions 的 paymentIdentifierSchema 相同）。 */
export const PAYMENT_IDENTIFIER_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    required: { type: "boolean" },
    id: {
      type: "string",
      minLength: PAYMENT_ID_MIN_LENGTH,
      maxLength: PAYMENT_ID_MAX_LENGTH,
      pattern: "^[a-zA-Z0-9_-]+$",
    },
  },
  required: ["required"],
} as const;

export function isValidPaymentId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= PAYMENT_ID_MIN_LENGTH &&
    id.length <= PAYMENT_ID_MAX_LENGTH &&
    PAYMENT_ID_PATTERN.test(id)
  );
}

/**
 * 伺服器端宣告。`required: false`：不帶 id 的 v2 client 照樣能付款（帳本改用結算 tx hash 當鍵）。
 * 設成 true 會讓沒有註冊這個擴充的官方 @x402/fetch client 付不了款，所以不這麼做。
 */
export function declarePaymentIdentifierExtension(required = false): {
  info: { required: boolean };
  schema: typeof PAYMENT_IDENTIFIER_SCHEMA;
} {
  return { info: { required }, schema: PAYMENT_IDENTIFIER_SCHEMA };
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
 *   - 帶了 id 但格式不合 → { id: null, valid: false }（伺服器回 400，不送 facilitator）
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
