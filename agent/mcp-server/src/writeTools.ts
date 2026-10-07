// MCP 寫入工具（open_position / close_position）與 human-in-the-loop 確認。
//
// 人類確認走 **MCP elicitation**（`elicitation/create`，SDK `server.elicitInput`）：
// server 在送交易之前，把摘要（標的、方向、保證金、槓桿、名目、估計手續費、policy 預檢）
// 直接交給 **client 的介面**問人「是否送出」。答案由 client 回給 server，**不經過模型**，
// tool result 裡也不含任何確認碼 —— 模型無法替人按確認。
//   - client 未宣告 elicitation 能力 → 一律拒絕寫入（ELICITATION_UNSUPPORTED），不退回任何
//     「模型自己確認」的路徑。
//   - 人類拒絕 / 取消 / 未勾選確認 → HUMAN_DECLINED，不送交易。
//   - elicitation 失敗或逾時（120 秒）→ ELICITATION_FAILED，不送交易。
//   - 人類確認後仍經 write.ts 的 VC 閘、風險閘、policy gate、簽章守門。
// 唯一的關閉方式：MCP_WRITE_REQUIRE_CONFIRM=false（僅限測試／受控環境），關閉時啟動與
// 每次寫入都在 stderr 警告。
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonSafe, redactSecrets } from "@pepelab/shared";

export const ELICIT_TIMEOUT_MS = 120_000;

/** MCP tool annotations（規格 2025-03-26 起）。寫入工具標 destructive、非冪等。 */
export const TOOL_ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  open_position: {
    title: "開倉（送出前由 client 以 MCP elicitation 詢問人類確認）",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  close_position: {
    title: "平倉（送出前由 client 以 MCP elicitation 詢問人類確認）",
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
  "的人類確認（MCP elicitation）已關閉，工具呼叫會直接送出鏈上交易。僅限測試或受控環境。";

// ── elicitation 介面 ─────────────────────────────────────────────────────────
export type HumanAnswer = "accept" | "decline" | "cancel";

export interface ElicitPort {
  /** client 是否宣告支援 form 模式 elicitation。 */
  supported(): boolean;
  /** 向人類提問；回 accept 代表人類明確勾選「確認送出」。 */
  ask(message: string): Promise<HumanAnswer>;
}

const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: {
      type: "boolean" as const,
      title: "確認送出這筆鏈上交易",
      description: "勾選並接受才會送出；拒絕、取消或不勾選都不會送出。",
    },
  },
  required: ["confirm"],
};

/** 以 SDK 的 `server.elicitInput` 實作 ElicitPort。 */
export function elicitPortFromServer(server: McpServer): ElicitPort {
  return {
    supported: () => Boolean(server.server.getClientCapabilities()?.elicitation?.form),
    ask: async (message) => {
      const r = await server.server.elicitInput(
        { mode: "form", message, requestedSchema: CONFIRM_SCHEMA },
        { timeout: ELICIT_TIMEOUT_MS },
      );
      if (r.action !== "accept") return r.action;
      return (r.content as { confirm?: unknown } | undefined)?.confirm === true ? "accept" : "decline";
    },
  };
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

type WriteRes = { ok: boolean; error?: string; [k: string]: unknown };

export interface WriteToolDeps {
  requireConfirm: boolean;
  elicit: ElicitPort;
  /** 真正送出（write.ts）。 */
  open: (a: OpenArgs) => Promise<WriteRes>;
  close: (a: CloseArgs) => Promise<WriteRes>;
  /** 讀手續費參數（唯讀 RPC）。 */
  readFees: (asset: string | null) => Promise<FeeInputs>;
  /** 讀部位（平倉摘要用）。 */
  readPosition: (positionId: number) => Promise<PositionView>;
  /** 讀鏈上 session.user（摘要顯示「這筆是替誰下的」）；讀不到回 null。 */
  readSessionUser: (sessionId: number) => Promise<string | null>;
  /** policy gate 預檢（不預留額度、不寫狀態）；沒有 agent 金鑰時可回 null。 */
  policyPreview: (req: {
    action: "open" | "close";
    sessionId: number;
    symbol?: string;
    isLong?: boolean;
    marginUsdc?: number;
    leverage?: number;
    positionId?: number;
  }) => PolicyPreview | null | Promise<PolicyPreview | null>;
  warn: (msg: string) => void;
  /**
   * VC 撤銷狀態預覽（ADR-016，選用）：送出前給人類看「清單快到期」等警告，或「送出時會被拒」的原因。
   * 不影響是否送出——強制點仍是 write.ts。回 null＝略過。
   */
  vcStatusPreview?: (authVcJson: string) => Promise<{ warnings: string[]; problem: string | null } | null>;
}

export type ToolReply =
  | { kind: "ok"; data: unknown }
  | { kind: "fail"; reasonCode: string; message: string };

function parseVc(json: string): string | null {
  try {
    JSON.parse(json);
    return null;
  } catch (e) {
    return `authVcJson 解析失敗：${(e as Error).message}`;
  }
}

/** VC 簽發者地址（did:pkh:eip155:<chain>:<address> 的最後一段）；格式不符回 null。 */
export function vcIssuerAddress(json: string): string | null {
  try {
    const iss = String((JSON.parse(json) as { issuer?: unknown }).issuer ?? "");
    const m = /^did:pkh:eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(iss);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 摘要裡的「替誰下單」：鏈上 session.user 與 VC 簽發者，並標出兩者是否一致。 */
async function whoFields(deps: WriteToolDeps, sessionId: number, authVcJson: string) {
  const sessionUser = await safe(deps.readSessionUser(sessionId), null);
  const vcIssuer = vcIssuerAddress(authVcJson);
  const vcStatus = deps.vcStatusPreview ? await safe(deps.vcStatusPreview(authVcJson), null) : null;
  return {
    sessionUser,
    vcIssuer,
    vcStatus,
    vcIssuerMatchesSessionUser:
      sessionUser && vcIssuer ? sessionUser.toLowerCase() === vcIssuer.toLowerCase() : null,
  };
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

function summaryText(s: Record<string, any>): string {
  const fee = s.estimatedFees ?? {};
  const pv = s.policyPreview;
  return [
    `PepeFi agent 要求送出鏈上交易：${s.action === "open_position" ? "開倉" : "平倉"}`,
    `session #${s.sessionId}${s.positionId !== undefined ? `・position #${s.positionId}` : ""}`,
    `session 使用者（鏈上）：${s.sessionUser ?? "(讀不到)"}`,
    `VC 簽發者：${s.vcIssuer ?? "(讀不到)"}` +
      (s.vcIssuerMatchesSessionUser === false ? "　⚠ 與 session 使用者不一致（送出時會被拒絕）" : ""),
    `標的 ${s.asset ?? "(讀不到)"}・方向 ${s.direction ?? "(讀不到)"}`,
    `保證金 ${s.marginUsdc ?? "(讀不到)"} USDC・槓桿 ${s.leverage ?? "(讀不到)"}x・名目 ${s.notionalUsdc ?? "(讀不到)"} USDC`,
    `估計交易費 ${fee.tradingFeeUsdc ?? "(讀不到)"} USDC（${fee.tradingFeeBps ?? "?"} bps）` +
      (fee.executionFeeEth ? `・execution fee ${fee.executionFeeEth} ETH` : ""),
    pv ? `policy 預檢：${pv.allowed ? "通過" : `不通過（${pv.reasonCode}）`}` : "policy 預檢：略過（未設 agent 金鑰）",
    ...(s.vcStatus?.problem ? [`⚠ VC 撤銷狀態：${s.vcStatus.problem}（送出時會被拒絕）`] : []),
    ...((s.vcStatus?.warnings ?? []) as string[]).map((w) => `⚠ ${w}`),
    "確認無誤才勾選並接受；拒絕或取消都不會送出。",
  ].join("\n");
}

/**
 * 建立 open/close 的 handler（純邏輯，依賴注入）。回傳中性的 ToolReply。
 */
export function createWriteHandlers(deps: WriteToolDeps) {
  /** 取得人類確認；回 null＝已確認，否則回拒絕結果。 */
  async function confirm(summary: Record<string, unknown>): Promise<ToolReply | null> {
    if (!deps.elicit.supported()) {
      return {
        kind: "fail",
        reasonCode: "ELICITATION_UNSUPPORTED",
        message:
          "ELICITATION_UNSUPPORTED：此 MCP client 未宣告 elicitation 能力，無法在送出前由人類確認，寫入已拒絕、未送出任何交易。" +
          "請改用支援 MCP elicitation 的 client。",
      };
    }
    let answer: HumanAnswer;
    try {
      answer = await deps.elicit.ask(summaryText(summary));
    } catch {
      return {
        kind: "fail",
        reasonCode: "ELICITATION_FAILED",
        message: "ELICITATION_FAILED：人類確認沒有完成（失敗或逾時），未送出任何交易。",
      };
    }
    if (answer !== "accept") {
      return {
        kind: "fail",
        reasonCode: "HUMAN_DECLINED",
        message: `HUMAN_DECLINED：人類未確認（${answer}），未送出任何交易。`,
      };
    }
    return null;
  }

  async function openPosition(params: OpenArgs): Promise<ToolReply> {
    const vcErr = parseVc(params.authVcJson);
    if (vcErr) return { kind: "fail", reasonCode: "VC_JSON_INVALID", message: vcErr };

    if (!deps.requireConfirm) {
      deps.warn(CONFIRM_DISABLED_WARNING);
      return send(() => deps.open(params), false);
    }

    const fees = await safe(deps.readFees(params.asset), { tradingFeeBps: null, executionFeeEth: null });
    const notional = params.marginUsdc * params.leverage;
    const summary = {
      action: "open_position",
      sessionId: params.sessionId,
      ...(await whoFields(deps, params.sessionId, params.authVcJson)),
      asset: params.asset,
      direction: params.isLong ? "long" : "short",
      marginUsdc: params.marginUsdc,
      leverage: params.leverage,
      notionalUsdc: notional,
      estimatedFees: estimateFees(notional, fees),
      policyPreview: await safe(Promise.resolve(deps.policyPreview({
        action: "open",
        sessionId: params.sessionId,
        symbol: params.asset,
        isLong: params.isLong,
        marginUsdc: params.marginUsdc,
        leverage: params.leverage,
      })), null),
    };
    const rejected = await confirm(summary);
    if (rejected) return rejected;
    return send(() => deps.open(params), true);
  }

  /** 平倉失敗（人類主動拒絕除外）一律附上「直接在鏈上平倉」的指引。 */
  async function closePosition(params: CloseArgs): Promise<ToolReply> {
    const r = await closePositionInner(params);
    if (r.kind === "fail" && r.reasonCode !== "HUMAN_DECLINED" && !r.message.includes("closePosition(")) {
      return { ...r, message: `${r.message} ${CLOSE_FALLBACK_HINT}` };
    }
    return r;
  }

  async function closePositionInner(params: CloseArgs): Promise<ToolReply> {
    const vcErr = parseVc(params.authVcJson);
    if (vcErr) return { kind: "fail", reasonCode: "VC_JSON_INVALID", message: vcErr };

    if (!deps.requireConfirm) {
      deps.warn(CONFIRM_DISABLED_WARNING);
      return send(() => deps.close(params), false);
    }

    const pos = await safe(deps.readPosition(params.positionId), {
      asset: null, isLong: null, marginUsdc: null, leverage: null, isOpen: null,
    });
    const fees = await safe(deps.readFees(pos.asset), { tradingFeeBps: null, executionFeeEth: null });
    const notional = pos.marginUsdc !== null && pos.leverage !== null ? pos.marginUsdc * pos.leverage : null;
    const summary = {
      action: "close_position",
      sessionId: params.sessionId,
      ...(await whoFields(deps, params.sessionId, params.authVcJson)),
      positionId: params.positionId,
      asset: pos.asset,
      direction: pos.isLong === null ? null : pos.isLong ? "long" : "short",
      marginUsdc: pos.marginUsdc,
      leverage: pos.leverage,
      notionalUsdc: notional,
      isOpen: pos.isOpen,
      estimatedFees: { ...estimateFees(notional, fees), executionFeeEth: null },
      policyPreview: await safe(Promise.resolve(deps.policyPreview({ action: "close", sessionId: params.sessionId, positionId: params.positionId })), null),
    };
    const rejected = await confirm(summary);
    if (rejected) return rejected;
    return send(() => deps.close(params), true);
  }

  return { openPosition, closePosition };
}

async function send(fn: () => Promise<WriteRes>, humanConfirmed: boolean): Promise<ToolReply> {
  const res = await fn();
  return res.ok
    ? { kind: "ok", data: { ...res, humanConfirmed } }
    : { kind: "fail", reasonCode: String(res.reasonCode ?? "WRITE_FAILED"), message: res.error ?? "寫入失敗" };
}

// ── MCP 註冊 ─────────────────────────────────────────────────────────────────
export function toCallToolResult(r: ToolReply) {
  if (r.kind === "ok") {
    return { content: [{ type: "text" as const, text: JSON.stringify(jsonSafe(r.data), null, 2) }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${redactSecrets(r.message)}` }] };
}

const OPEN_DESC =
  "【寫・需人類確認】在指定 session 限額內為 session 使用者開一筆受限部位（受 per-trade cap / budget / leverage cap / expiry 與營運方 policy gate 約束）。" +
  "送出前 server 會以 MCP elicitation 在 client 介面向**人類**顯示摘要（標的、方向、保證金、槓桿、估計手續費、policy 預檢）並詢問是否送出；" +
  "人類拒絕或 client 不支援 elicitation 時不會送出。**必須**帶 authVcJson（使用者簽發的授權 VC）。成功回傳 tx hash 與 positionId。";

const CLOSE_DESC =
  "【寫・需人類確認】平掉指定 session 使用者的一筆部位（會實現損益，授權要求與開倉對稱）。" +
  "送出前以 MCP elicitation 在 client 介面向人類顯示部位摘要並詢問是否送出；人類拒絕或 client 不支援 elicitation 時不會送出。需 authVcJson。成功回傳 tx hash。" +
  "若因 VC 無效／過期或 client 不支援 elicitation 而無法平倉：請直接在鏈上用錢包呼叫 PerpetualExchange.closePosition(positionId)——合約不需要 VC。";

/** 平倉失敗時附在錯誤訊息的指引（與 write.ts 的 CLOSE_ONCHAIN_HINT 同義）。 */
export const CLOSE_FALLBACK_HINT =
  "若需立即平倉，請直接在鏈上用錢包呼叫 PerpetualExchange.closePosition(positionId)——合約不需要 VC。";

/** 在 McpServer 上註冊兩個寫入工具。elicit 預設接 server 自己的 elicitInput。 */
export function registerWriteTools(
  server: McpServer,
  deps: Omit<WriteToolDeps, "elicit"> & { elicit?: ElicitPort },
) {
  const h = createWriteHandlers({ ...deps, elicit: deps.elicit ?? elicitPortFromServer(server) });
  const guard = async (fn: () => Promise<ToolReply>) => {
    try {
      return toCallToolResult(await fn());
    } catch (err) {
      return toCallToolResult({ kind: "fail", reasonCode: "INTERNAL", message: (err as Error).message });
    }
  };

  server.tool(
    "open_position",
    OPEN_DESC,
    {
      sessionId: z.number().int().nonnegative().describe("鏈上 session id"),
      asset: z.string().describe("資產代號，如 sBTC / sETH / sAAPL"),
      isLong: z.boolean().describe("true=做多，false=做空"),
      marginUsdc: z.number().positive().describe("保證金（USDC，人類單位）"),
      leverage: z.number().int().positive().describe("槓桿（受 session.maxLeverage 約束）"),
      // 稽核 A-3：必填，缺 VC 連呼叫都組不起來。
      authVcJson: z.string().min(1).describe("使用者簽發的授權 VC JSON 字串（必填；v2 授權 VC 或 v3 委託憑證 AgentDelegationCredential）；下單前必須驗證通過"),
    },
    TOOL_ANNOTATIONS.open_position,
    async (args) => guard(() => h.openPosition(args)),
  );

  server.tool(
    "close_position",
    CLOSE_DESC,
    {
      sessionId: z.number().int().nonnegative().describe("鏈上 session id"),
      positionId: z.number().int().nonnegative().describe("要平的倉位 ID"),
      // 稽核 A-4：平倉會實現虧損，授權要求與開倉對稱。
      authVcJson: z.string().min(1).describe("使用者簽發的授權 VC JSON 字串（必填；v2 或 v3）；平倉前必須驗證通過"),
    },
    TOOL_ANNOTATIONS.close_position,
    async (args) => guard(() => h.closePosition(args)),
  );
  return h;
}
