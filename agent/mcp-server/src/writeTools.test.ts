// MCP 寫入工具的人類確認（MCP elicitation）測試。不送任何交易、不連 RPC。
//   (a) 純邏輯：假 ElicitPort
//   (b) 協定層：真的 McpServer + Client（InMemoryTransport），client 分別宣告／不宣告 elicitation
//   npx tsx mcp-server/src/writeTools.test.ts
import assert from "node:assert";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createWriteHandlers,
  registerWriteTools,
  writeConfirmRequired,
  estimateFees,
  TOOL_ANNOTATIONS,
  CONFIRM_DISABLED_WARNING,
  type WriteToolDeps,
  type ElicitPort,
  type HumanAnswer,
} from "./writeTools.ts";

function makeDeps(elicit: ElicitPort, over: Partial<WriteToolDeps> = {}) {
  const calls = { open: 0, close: 0, warnings: [] as string[] };
  const deps: WriteToolDeps = {
    requireConfirm: true,
    elicit,
    open: async () => { calls.open++; return { ok: true, txHash: "0xabc", positionId: "9" }; },
    close: async () => { calls.close++; return { ok: true, txHash: "0xdef" }; },
    readFees: async () => ({ tradingFeeBps: 10, executionFeeEth: "0.001" }),
    readPosition: async () => ({ asset: "sETH", isLong: false, marginUsdc: 20, leverage: 3, isOpen: true }),
    policyPreview: () => ({ allowed: true, reasonCode: "OK", message: "policy gate 通過" }),
    warn: (m) => calls.warnings.push(m),
    ...over,
  };
  return { deps, calls, h: createWriteHandlers(deps) };
}
const human = (answer: HumanAnswer | Error, asked: string[] = []): ElicitPort => ({
  supported: () => true,
  ask: async (m) => { asked.push(m); if (answer instanceof Error) throw answer; return answer; },
});

const VC = JSON.stringify({ proof: { proofValue: "0x00" } });
const OPEN = { sessionId: 6, asset: "sBTC", isLong: true, marginUsdc: 50, leverage: 4, authVcJson: VC };
const CLOSE = { sessionId: 6, positionId: 42, authVcJson: VC };
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// ─────────────── (a) 純邏輯 ───────────────
{
  const asked: string[] = [];
  const { h, calls } = makeDeps(human("accept", asked));
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "ok");
  assert.equal(calls.open, 1);
  assert.equal(r.data.humanConfirmed, true);
  assert.equal(asked.length, 1);
  for (const s of ["開倉", "sBTC", "long", "50 USDC", "4x", "200 USDC", "0.2 USDC", "0.001 ETH", "policy 預檢：通過"])
    assert.ok(asked[0].includes(s), `摘要缺 ${s}：${asked[0]}`);
  assert.ok(!/confirmationCode|確認碼/.test(JSON.stringify(r)), "tool result 不可含確認碼");
  ok("人類在 client 介面接受 → 才送出；摘要含標的/方向/保證金/槓桿/名目/手續費/policy 預檢；結果無確認碼");
}
for (const a of ["decline", "cancel"] as const) {
  const { h, calls } = makeDeps(human(a));
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "fail");
  assert.equal(r.reasonCode, "HUMAN_DECLINED");
  assert.equal(calls.open, 0);
}
ok("人類拒絕 / 取消 → HUMAN_DECLINED，不送出");
{
  const { h, calls } = makeDeps(human(new Error("timeout")));
  const r: any = await h.closePosition(CLOSE);
  assert.equal(r.reasonCode, "ELICITATION_FAILED");
  assert.equal(calls.close, 0);
  ok("elicitation 失敗或逾時 → ELICITATION_FAILED，不送出");
}
{
  const { h, calls } = makeDeps({ supported: () => false, ask: async () => { throw new Error("不該被呼叫"); } });
  const r1: any = await h.openPosition(OPEN);
  const r2: any = await h.closePosition(CLOSE);
  assert.equal(r1.reasonCode, "ELICITATION_UNSUPPORTED");
  assert.equal(r2.reasonCode, "ELICITATION_UNSUPPORTED");
  assert.match(r1.message, /寫入已拒絕/);
  assert.equal(calls.open + calls.close, 0);
  ok("client 不支援 elicitation → 一律拒絕寫入（ELICITATION_UNSUPPORTED）並說明原因");
}
{
  const asked: string[] = [];
  const { h, calls } = makeDeps(human("accept", asked));
  const r: any = await h.closePosition(CLOSE);
  assert.equal(r.kind, "ok");
  assert.equal(calls.close, 1);
  for (const s of ["平倉", "position #42", "sETH", "short", "60 USDC", "0.06 USDC"]) assert.ok(asked[0].includes(s), s);
  ok("close_position：摘要含部位標的/方向/保證金/槓桿/手續費，人類接受才送出");
}
{
  const { h, calls } = makeDeps(human("accept"), { readFees: async () => { throw new Error("rpc down"); } });
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "ok");
  assert.equal(calls.open, 1);
  ok("手續費讀不到 → 摘要標示讀不到，仍可由人類決定");
}
{
  const { h, calls } = makeDeps({ supported: () => false, ask: async () => "decline" }, { requireConfirm: false });
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "ok");
  assert.equal(calls.open, 1);
  assert.equal(r.data.humanConfirmed, false);
  assert.ok(calls.warnings.includes(CONFIRM_DISABLED_WARNING));
  assert.equal(writeConfirmRequired({} as any), true, "預設開啟");
  assert.equal(writeConfirmRequired({ MCP_WRITE_REQUIRE_CONFIRM: "false" } as any), false);
  assert.equal(writeConfirmRequired({ MCP_WRITE_REQUIRE_CONFIRM: "0" } as any), true, "只有明確 false 才關");
  ok("MCP_WRITE_REQUIRE_CONFIRM=false 是唯一關閉方式，關閉時每次寫入都警告");
}
{
  const { h } = makeDeps(human("accept"), {
    open: async () => ({ ok: false, reasonCode: "LEVERAGE_EXCEEDED", error: "拒絕下單（policy gate LEVERAGE_EXCEEDED）" }),
  });
  const r: any = await h.openPosition(OPEN);
  assert.equal(r.kind, "fail");
  assert.equal(r.reasonCode, "LEVERAGE_EXCEEDED");
  ok("人類確認後仍經 write.ts 的 policy gate；被擋時回錯誤");
}
{
  const { h, calls } = makeDeps(human("accept"));
  const r: any = await h.openPosition({ ...OPEN, authVcJson: "{bad" });
  assert.equal(r.reasonCode, "VC_JSON_INVALID");
  assert.equal(calls.open, 0);
  ok("authVcJson 無法解析 → 直接拒絕，不詢問人類");
}

// ─────────────── (b) 協定層：真的 MCP client/server ───────────────
async function wire(clientCaps: Record<string, unknown>, onElicit?: (msg: string) => { action: string; content?: unknown }) {
  const server = new McpServer({ name: "t", version: "0" });
  const calls = { open: 0 };
  registerWriteTools(server, {
    requireConfirm: true,
    open: async () => { calls.open++; return { ok: true, txHash: "0xabc" }; },
    close: async () => ({ ok: true }),
    readFees: async () => ({ tradingFeeBps: 10, executionFeeEth: "0.001" }),
    readPosition: async () => ({ asset: "sETH", isLong: false, marginUsdc: 20, leverage: 3, isOpen: true }),
    policyPreview: () => null,
    warn: () => {},
  });
  const client = new Client({ name: "c", version: "0" }, { capabilities: clientCaps });
  const seen: string[] = [];
  if (onElicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      seen.push(String((req.params as any).message));
      return onElicit(String((req.params as any).message)) as any;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, calls, seen, close: () => client.close() };
}
{
  const w = await wire({ elicitation: {} }, () => ({ action: "accept", content: { confirm: true } }));
  const tools = await w.client.listTools();
  const open = tools.tools.find((t) => t.name === "open_position")!;
  assert.equal(open.annotations?.destructiveHint, true);
  assert.ok(!("confirmationCode" in (open.inputSchema.properties ?? {})), "不再有帶碼再呼叫的參數");
  assert.match(open.annotations?.title ?? "", /elicitation/);
  const r: any = await w.client.callTool({ name: "open_position", arguments: OPEN });
  assert.equal(r.isError, undefined);
  assert.equal(w.calls.open, 1);
  assert.equal(w.seen.length, 1, "server 經 elicitation/create 問 client");
  assert.match(w.seen[0], /sBTC/);
  assert.ok(!r.content[0].text.includes(w.seen[0].split("\n")[0]), "詢問內容走 client 介面，不出現在 tool result");
  await w.close();
  ok("協定層：client 宣告 elicitation 且人類接受 → server 發 elicitation/create、送出一次");
}
{
  const w = await wire({ elicitation: {} }, () => ({ action: "accept", content: { confirm: false } }));
  const r: any = await w.client.callTool({ name: "open_position", arguments: OPEN });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HUMAN_DECLINED/);
  assert.equal(w.calls.open, 0);
  await w.close();
  const w2 = await wire({ elicitation: {} }, () => ({ action: "decline" }));
  const r2: any = await w2.client.callTool({ name: "open_position", arguments: OPEN });
  assert.match(r2.content[0].text, /HUMAN_DECLINED/);
  assert.equal(w2.calls.open, 0);
  await w2.close();
  ok("協定層：人類拒絕或未勾選確認 → isError HUMAN_DECLINED，不送出");
}
{
  const w = await wire({});
  const r: any = await w.client.callTool({ name: "open_position", arguments: OPEN });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ELICITATION_UNSUPPORTED/);
  assert.equal(w.calls.open, 0);
  await w.close();
  ok("協定層：client 未宣告 elicitation → isError ELICITATION_UNSUPPORTED，不送出");
}

// annotations 與費用估計
{
  for (const t of ["open_position", "close_position"] as const) {
    const a = TOOL_ANNOTATIONS[t];
    assert.equal(a.destructiveHint, true);
    assert.equal(a.readOnlyHint, false);
    assert.equal(a.idempotentHint, false);
  }
  assert.equal(TOOL_ANNOTATIONS.read.readOnlyHint, true);
  assert.equal(estimateFees(null, { tradingFeeBps: 10, executionFeeEth: null }).tradingFeeUsdc, null);
  ok("tool annotations：寫入 destructiveHint=true / readOnlyHint=false / idempotentHint=false；讀取 readOnlyHint=true");
}

console.log(`\n✅ mcp-server writeTools.test.ts 全過（${n} 組）`);
