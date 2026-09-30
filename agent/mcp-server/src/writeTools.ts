// MCP 寫入工具的 human-in-the-loop 確認流程（純邏輯＋依賴注入，可離線測試）。
//
// MCP 規格要求寫入工具要有 human in the loop。預設流程：
//   1. 第一次呼叫 open_position / close_position（不帶 confirmationCode）→ **不送交易**，
//      回一張摘要（標的、方向、保證金、槓桿、名目、估計手續費、policy gate 預檢）
//      與一次性確認碼（120 秒有效）。
//   2. 呼叫端（由人類看過摘要後）帶同一組參數＋確認碼再呼叫一次 → 才真的送出，
//      送出仍經 write.ts 的 VC 閘、風險閘、policy gate、簽章守門。
// 確認碼綁「工具名＋完整參數」的摘要：換了任何參數（保證金、方向、VC…）碼就失效，
// 不能先拿一張小額摘要的碼去確認一筆大額單。碼一次性：比對成功或失敗都立刻作廢。
//
// 關閉：MCP_WRITE_REQUIRE_CONFIRM=false（僅限測試／受控環境），關閉時啟動與每次寫入
// 都在 stderr 印警告。
//
// 誠實邊界：確認碼回給 MCP client，理論上 LLM 可以自己帶碼重呼叫。真正的「人」要
// 靠 host 對 destructiveHint 工具逐次跳出核可（Claude Desktop 等會這樣做）——兩步流程
// 保證核可畫面上看到的是完整摘要與參數，而不是一筆已經送出的交易。
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";

export const CONFIRM_TTL_MS = 120_000;

/** MCP tool annotations（規格 2025-03-26 起）。寫入工具標 destructive、非冪等。 */
export const TOOL_ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  open_position: {
    title: "開倉（需人類確認）",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  close_position: {
    title: "平倉（需人類確認）",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;

export function writeConfirmRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_WRITE_REQUIRE_CONFIRM?.trim().toLowerCase() !== "false";
}

export const CONFIRM_DISABLED_WARNING =
  "[mcp] ⚠ MCP_WRITE_REQUIRE_CONFIRM=false：寫入工具（open_position / close_position）" +
  "的人類確認已關閉，工具呼叫會直接送出鏈上交易。僅限測試或受控環境。";

/** 參數指紋：key 排序後 keccak，與欄位順序無關。 */
export function paramsFingerprint(tool: string, params: Record<string, unknown>): string {
  const keys = Object.keys(params).filter((k) => params[k] !== undefined).sort();
  return ethers.id(JSON.stringify([tool, keys.map((k) => [k, params[k]])]));
}

interface Pending {
  tool: string;
  fingerprint: string;
  expiresAt: number;
}

export type ConsumeResult =
  | { ok: true }
  | { ok: false; reasonCode: "CONFIRM_CODE_UNKNOWN" | "CONFIRM_CODE_EXPIRED" | "CONFIRM_PARAMS_MISMATCH" };

/** 一次性確認碼。以碼為鍵；碼 = 10 個 hex 字元（40 bits），猜中的機率可忽略。 */
export class WriteConfirmStore {
  private pending = new Map<string, Pending>();
  constructor(
    private ttlMs = CONFIRM_TTL_MS,
    private now: () => number = () => Date.now(),
  ) {}

  create(tool: string, params: Record<string, unknown>): { code: string; expiresAt: number } {
    this.prune();
    const code = randomBytes(5).toString("hex").toUpperCase();
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(code, { tool, fingerprint: paramsFingerprint(tool, params), expiresAt });
    return { code, expiresAt };
  }

  consume(code: string, tool: string, params: Record<string, unknown>): ConsumeResult {
    const key = code.trim().toUpperCase();
    const p = this.pending.get(key);
    if (!p) return { ok: false, reasonCode: "CONFIRM_CODE_UNKNOWN" };
    this.pending.delete(key); // 一次性：不論結果都作廢
    if (this.now() > p.expiresAt) return { ok: false, reasonCode: "CONFIRM_CODE_EXPIRED" };
    if (p.tool !== tool || p.fingerprint !== paramsFingerprint(tool, params))
      return { ok: false, reasonCode: "CONFIRM_PARAMS_MISMATCH" };
    return { ok: true };
  }

  size(): number {
    this.prune();
    return this.pending.size;
  }

  private prune() {
    const t = this.now();
    for (const [k, p] of this.pending) if (t > p.expiresAt) this.pending.delete(k);
  }
}

// ── 摘要 ─────────────────────────────────────────────────────────────────────
export interface FeeInputs {
  /** 交易費率（bps）；讀不到為 null。 */
  tradingFeeBps: number | null;
  /** 開倉 execution fee（ETH，人類單位字串）；讀不到為 null。 */
  executionFeeEth: string | null;
}

export interface OpenArgs {
  sessionId: number;
  asset: string;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  authVcJson: string;
}

export interface CloseArgs {
  sessionId: number;
  positionId: number;
  authVcJson: string;
}

export interface PositionView {
  asset: string | null;
  isLong: boolean | null;
  marginUsdc: number | null;
  leverage: number | null;
  isOpen: boolean | null;
}

export interface PolicyPreview {
  allowed: boolean;
  reasonCode: string;
  message: string;
}

/** 手續費估計：交易費 = 名目 × bps / 10000（USDC，平倉時收）＋ 開倉 execution fee（ETH）。 */
export function estimateFees(notionalUsdc: number | null, fee: FeeInputs) {
  const tradingFeeUsdc =
    notionalUsdc !== null && fee.tradingFeeBps !== null
      ? Math.round(notionalUsdc * fee.tradingFeeBps) / 10_000
      : null;
  return {
    tradingFeeBps: fee.tradingFeeBps,
    tradingFeeUsdc,
    executionFeeEth: fee.executionFeeEth,
    note: "估計值：交易費依名目與開倉時凍結的費率計，於平倉時收取；另有 borrow fee 與 funding 依持倉時間計，未含在內。",
  };
}

export interface WriteToolDeps {
  requireConfirm: boolean;
  store: WriteConfirmStore;
  /** 真正送出（write.ts）。 */
  open: (a: OpenArgs) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
  close: (a: CloseArgs) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>;
  /** 讀手續費參數（唯讀 RPC）。 */
  readFees: (asset: string | null) => Promise<FeeInputs>;
  /** 讀部位（平倉摘要用）。 */
  readPosition: (positionId: number) => Promise<PositionView>;
  /** policy gate 預檢（不預留額度、不寫狀態）；沒有 agent 金鑰時可回 null。 */
  policyPreview: (req: {
    action: "open" | "close";
    sessionId: number;
    symbol?: string;
    isLong?: boolean;
    marginUsdc?: number;
    leverage?: number;
    positionId?: number;
  }) => PolicyPreview | null;
  warn: (msg: string) => void;
}

export type ToolReply =
  | { kind: "ok"; data: unknown }
  | { kind: "fail"; message: string };

function parseVc(json: string): string | null {
  try {
    JSON.parse(json);
    return null;
  } catch (e) {
    return `authVcJson 解析失敗：${(e as Error).message}`;
  }
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/**
 * 建立 open/close 的 handler。回傳中性的 ToolReply，由 index.ts 轉成 MCP content。
 */
export function createWriteHandlers(deps: WriteToolDeps) {
  const confirmBlock = (tool: string, params: Record<string, unknown>) => {
    const { code, expiresAt } = deps.store.create(tool, params);
    return {
      confirmationCode: code,
      expiresAt: new Date(expiresAt).toISOString(),
      ttlSec: Math.round(CONFIRM_TTL_MS / 1000),
      howToConfirm: `請人類確認上方摘要後，以**完全相同的參數**加上 confirmationCode="${code}" 再呼叫一次 ${tool}。碼一次性、${Math.round(CONFIRM_TTL_MS / 1000)} 秒內有效，參數有任何改變即失效。`,
    };
  };

  async function openPosition(args: OpenArgs & { confirmationCode?: string }): Promise<ToolReply> {
    const { confirmationCode, ...params } = args;
    const vcErr = parseVc(params.authVcJson);
    if (vcErr) return { kind: "fail", message: vcErr };

    if (!deps.requireConfirm) {
      deps.warn(CONFIRM_DISABLED_WARNING);
      return send(() => deps.open(params));
    }

    if (!confirmationCode) {
      const fees = await safe(deps.readFees(params.asset), { tradingFeeBps: null, executionFeeEth: null });
      const notional = params.marginUsdc * params.leverage;
      return {
        kind: "ok",
        data: {
          status: "confirmation_required",
          txSent: false,
          summary: {
            action: "open_position",
            sessionId: params.sessionId,
            asset: params.asset,
            direction: params.isLong ? "long" : "short",
            marginUsdc: params.marginUsdc,
            leverage: params.leverage,
            notionalUsdc: notional,
            estimatedFees: estimateFees(notional, fees),
            policyPreview: deps.policyPreview({
              action: "open",
              sessionId: params.sessionId,
              symbol: params.asset,
              isLong: params.isLong,
              marginUsdc: params.marginUsdc,
              leverage: params.leverage,
            }),
          },
          ...confirmBlock("open_position", params),
        },
      };
    }

    const c = deps.store.consume(confirmationCode, "open_position", params);
    if (!c.ok) return { kind: "fail", message: confirmFailMessage(c.reasonCode) };
    return send(() => deps.open(params));
  }

  async function closePosition(args: CloseArgs & { confirmationCode?: string }): Promise<ToolReply> {
    const { confirmationCode, ...params } = args;
    const vcErr = parseVc(params.authVcJson);
    if (vcErr) return { kind: "fail", message: vcErr };

    if (!deps.requireConfirm) {
      deps.warn(CONFIRM_DISABLED_WARNING);
      return send(() => deps.close(params));
    }

    if (!confirmationCode) {
      const pos = await safe(deps.readPosition(params.positionId), {
        asset: null, isLong: null, marginUsdc: null, leverage: null, isOpen: null,
      });
      const fees = await safe(deps.readFees(pos.asset), { tradingFeeBps: null, executionFeeEth: null });
      const notional = pos.marginUsdc !== null && pos.leverage !== null ? pos.marginUsdc * pos.leverage : null;
      return {
        kind: "ok",
        data: {
          status: "confirmation_required",
          txSent: false,
          summary: {
            action: "close_position",
            sessionId: params.sessionId,
            positionId: params.positionId,
            asset: pos.asset,
            direction: pos.isLong === null ? null : pos.isLong ? "long" : "short",
            marginUsdc: pos.marginUsdc,
            leverage: pos.leverage,
            notionalUsdc: notional,
            isOpen: pos.isOpen,
            estimatedFees: { ...estimateFees(notional, fees), executionFeeEth: null },
            policyPreview: deps.policyPreview({ action: "close", sessionId: params.sessionId, positionId: params.positionId }),
          },
          ...confirmBlock("close_position", params),
        },
      };
    }

    const c = deps.store.consume(confirmationCode, "close_position", params);
    if (!c.ok) return { kind: "fail", message: confirmFailMessage(c.reasonCode) };
    return send(() => deps.close(params));
  }

  return { openPosition, closePosition };
}

async function send(
  fn: () => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>,
): Promise<ToolReply> {
  const res = await fn();
  return res.ok ? { kind: "ok", data: res } : { kind: "fail", message: res.error ?? "寫入失敗" };
}

function confirmFailMessage(code: string): string {
  const why: Record<string, string> = {
    CONFIRM_CODE_UNKNOWN: "確認碼不存在或已使用過",
    CONFIRM_CODE_EXPIRED: "確認碼已過期（120 秒）",
    CONFIRM_PARAMS_MISMATCH: "參數與取得確認碼時的摘要不一致",
  };
  return `${code}：${why[code] ?? "確認失敗"}。未送出任何交易；請不帶 confirmationCode 重新呼叫以取得新摘要。`;
}
