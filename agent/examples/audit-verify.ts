// audit-verify.ts — 讀一筆稽核紀錄，獨立重新驗證它「可不可被承認」。
// 證據鏈：hash chain 完整 → VC 簽章(誰授權) → 該 VC 與**本筆內容**綁定 →
//         x402 付款 tx 屬實 → 開倉 tx 真的產生了這個 positionId → 該部位屬於 session.user。
// 全部可獨立核對，不需信任 agent。
//
// 跑法：npx tsx examples/audit-verify.ts [行號]   # 預設驗最後一筆；行號從 0 起
//   需 AGENT_AUTH_VC_PATH 指向該筆用的 VC（紀錄只存摘要，不存 VC 全文）。
//
// 稽核 2026-08-06 修掉的假陽性：
//   • positionId 解析失敗（NaN/空字串）以前會掉進 catch 或被當成「本筆為 skip」，
//     然後照樣印 ✅。現在明確報 ❌。
//   • `settlementTx` 從頭到尾沒有被驗證過 —— 記錄裡填任何字串都能通過。現在會去鏈上
//     取 receipt，要求存在且 status=1。
//   • 只比對 `position.owner === session.user`，於是抄一個別人開的 positionId 也會過。
//     現在額外要求「本筆的開倉 txHash 的 receipt 裡真的有這個 positionId」。
//   • `vcId` 只綁簽章位元組，不綁紀錄內容 → 現在比對 `vc.binding`。
//   • JSONL 沒有順序保證 → 現在驗 hash chain。
import { ethers } from "ethers";
import {
  verifyAuthorizationVC, vcId, vcBinding, parseDidPkh, getSession, makeProvider, makeContracts,
  readAudit, verifyAuditChain, getSessionManagerAddress, resolveSettlementToken,
  type AuditRecord,
} from "@pepelab/shared";
import { loadVc, AUDIT_PATH } from "./vc-gate.ts";

const ok = (m: string) => console.log("  ✓ " + m);
const bad = (m: string) => console.log("  ✗ " + m);
const note = (m: string) => console.log("  · " + m);

/** 從開倉 tx 的 receipt 找出 SessionOpenedPosition 事件裡的 positionId 清單。 */
async function positionIdsFromTx(
  provider: ethers.JsonRpcProvider,
  txHash: string,
): Promise<{ ids: string[]; from: string; status: number } | { error: string }> {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return { error: `鏈上找不到 tx ${txHash}` };
    const mgrAddr = getSessionManagerAddress();
    // 事件簽章必須與 contracts/src/AgentSessionManager.sol 完全一致。
    const iface = new ethers.Interface([
      "event SessionOpenedPosition(uint256 indexed sessionId, address indexed agent, uint256 positionId, uint256 margin)",
    ]);
    const ids: string[] = [];
    for (const log of receipt.logs) {
      if (mgrAddr !== ethers.ZeroAddress && log.address.toLowerCase() !== mgrAddr.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === "SessionOpenedPosition") ids.push(parsed.args.positionId.toString());
      } catch { /* 非本事件 */ }
    }
    return { ids, from: receipt.from, status: receipt.status ?? 0 };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function main() {
  const idxArg = process.argv[2];
  const records = readAudit(AUDIT_PATH);
  if (!records.length) throw new Error(`稽核檔無紀錄：${AUDIT_PATH}（先跑 x402-autonomous/loop 產生）`);
  const idx = idxArg !== undefined ? Number(idxArg) : records.length - 1;
  if (!Number.isInteger(idx) || idx < 0) throw new Error(`行號非法：${idxArg}`);
  const rec = records[idx] as AuditRecord | undefined;
  if (!rec) throw new Error(`行號 ${idx} 超出範圍（共 ${records.length} 筆）`);

  console.log(`=== 稽核驗證：第 ${idx} 筆 / 共 ${records.length} ===`);
  console.log(JSON.stringify(rec, null, 2));
  console.log("\n獨立核對：");

  let allOk = true;

  // 0) hash chain：整個檔案沒有被事後竄改/刪除/重排。
  const chainIssues = verifyAuditChain(records);
  if (chainIssues.length === 0) {
    ok(`稽核 hash chain 完整（${records.length} 筆）`);
  } else {
    for (const i of chainIssues) bad(`hash chain 第 ${i.index} 筆：${i.problem}`);
    allOk = false;
  }

  // 1) VC 簽章（誰授權）。需 AGENT_AUTH_VC_PATH 指向該筆的 VC。
  const vc = loadVc();
  if (!vc) { bad("找不到 VC（設 AGENT_AUTH_VC_PATH 指向該筆所用的 VC）"); allOk = false; }
  else {
    const v = verifyAuthorizationVC(vc);
    if (v.valid) ok(`VC 簽章有效（issuer ${v.issuer}、holder ${v.agent}、session ${v.sessionId}）`);
    else { bad(`VC 簽章驗證失敗：${v.reason}`); allOk = false; }

    // 2) VC 摘要與紀錄相符（這筆紀錄確實對應這張 VC）。
    const id = vcId(vc);
    if (id && rec.vc.id && id === rec.vc.id) ok("VC 摘要與稽核紀錄相符");
    else { bad(`VC 摘要不符（紀錄 ${rec.vc.id} ≠ 當前 VC ${id}）→ 非同一張憑證/已竄改`); allOk = false; }

    // 2b) VC ↔ 本筆內容的綁定（防「同一張 VC、內容被改」）。
    const expected = vcBinding({
      vcIdValue: id,
      issuerDid: rec.issuerDid,
      agentDid: rec.agentDid,
      sessionId: rec.sessionId,
      research: rec.research,
      decision: rec.decision,
    });
    if (!rec.vc.binding) {
      bad("紀錄缺 vc.binding（舊格式）→ VC 未與本筆內容綁定，無法排除內容被改寫");
      allOk = false;
    } else if (rec.vc.binding === expected) {
      ok("VC 與本筆內容的綁定摘要相符（issuer/agent/session/resource/side 皆未被改）");
    } else {
      bad(`vc.binding 不符（紀錄 ${rec.vc.binding} ≠ 重算 ${expected}）→ 紀錄內容已被改寫`);
      allOk = false;
    }
  }

  const provider = makeProvider();

  // 3) x402 付款 tx 屬實（以前完全沒驗，填任何字串都會過）。
  const settlementTx = rec.research.settlementTx;
  if (!settlementTx) {
    note("本筆沒有 x402 付款 tx（未付費或 facilitator 未回 header）。");
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(settlementTx)) {
    bad(`settlementTx 格式非法：${settlementTx}`); allOk = false;
  } else {
    try {
      const r = await provider.getTransactionReceipt(settlementTx);
      if (!r) { bad(`鏈上找不到 x402 付款 tx ${settlementTx}`); allOk = false; }
      else if (r.status !== 1) { bad(`x402 付款 tx 失敗（status=${r.status}）`); allOk = false; }
      else {
        const token = resolveSettlementToken();
        const toToken = r.to && r.to.toLowerCase() === token.toLowerCase();
        ok(`x402 付款 tx 上鏈成功（block ${r.blockNumber}${toToken ? "，收款合約為結算 token" : `，to=${r.to}`}）`);
        if (!toToken) note(`提醒：付款 tx 的 to 不是設定的結算 token（${token}）——請確認 X402_SETTLEMENT_TOKEN。`);
      }
    } catch (e) { bad(`x402 付款 tx 核對失敗：${(e as Error).message}`); allOk = false; }
  }

  // 4) 鏈上：開倉的 positionId 屬於 session.user（= VC issuer），且真的由本筆的 tx 產生。
  if (rec.action.opened) {
    const rawId = rec.action.positionId;
    const posId = Number(rawId);
    if (rawId === null || rawId === "" || !Number.isInteger(posId) || posId < 0) {
      // 以前：Number(null)=0 或 NaN 掉進 catch，最壞情況是被當成 skip 卻仍印 ✅。
      bad(`opened=true 但 positionId 無法解析（${JSON.stringify(rawId)}）→ 本筆無法被承認`);
      allOk = false;
    } else {
      try {
        const sess: any = await getSession(rec.sessionId);
        const sessionUser = String(sess?.detail?.user ?? "").toLowerCase();
        const perp = makeContracts(provider).perp;
        const p: any = await perp.getPosition(posId);
        const owner = String(p?.owner ?? "").toLowerCase();
        const issuerAddr = vc ? parseDidPkh(vc.issuer).address.toLowerCase() : "";
        if (!sessionUser) { bad(`讀不到 session #${rec.sessionId} 的 user`); allOk = false; }
        else if (owner && owner === sessionUser) ok(`鏈上 position #${posId} owner == session.user（${owner}）`);
        else { bad(`position owner(${owner}) ≠ session.user(${sessionUser})`); allOk = false; }
        if (issuerAddr && issuerAddr === sessionUser) ok("VC issuer == 鏈上 session.user（授權相符）");
        else if (issuerAddr) { bad(`VC issuer(${issuerAddr}) ≠ session.user(${sessionUser})`); allOk = false; }

        // 4b) 這個 positionId 必須真的是**本筆的 tx** 開出來的，否則抄別人的 id 也會過。
        const txHash = rec.action.txHash;
        if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
          bad(`opened=true 但缺合法開倉 txHash（${JSON.stringify(txHash)}）→ 無法證明這筆倉位出自本次行動`);
          allOk = false;
        } else {
          const ev = await positionIdsFromTx(provider, txHash);
          if ("error" in ev) { bad(`開倉 tx 核對失敗：${ev.error}`); allOk = false; }
          else if (ev.status !== 1) { bad(`開倉 tx 失敗（status=${ev.status}）`); allOk = false; }
          else if (!ev.ids.includes(String(posId))) {
            bad(`開倉 tx ${txHash} 未產生 position #${posId}（該 tx 產生：${ev.ids.join(", ") || "無"}）→ positionId 可能是抄來的`);
            allOk = false;
          } else {
            ok(`開倉 tx 確實產生 position #${posId}（sender ${ev.from}）`);
            const agentAddr = (() => { try { return parseDidPkh(rec.agentDid).address.toLowerCase(); } catch { return ""; } })();
            if (agentAddr && ev.from.toLowerCase() !== agentAddr) {
              bad(`開倉 tx 的發送者(${ev.from}) ≠ 紀錄的 agent(${agentAddr})`); allOk = false;
            } else if (agentAddr) ok("開倉 tx 的發送者 == 紀錄的 agent DID");
          }
        }
      } catch (e) {
        bad(`鏈上核對失敗：${(e as Error).message}`); allOk = false;
      }
    }
  } else if (rec.action.positionId || rec.action.txHash) {
    // opened=false 卻帶著 positionId/txHash → 紀錄自相矛盾，不能當成單純的 skip。
    bad(`opened=false 但帶有 positionId(${rec.action.positionId}) / txHash(${rec.action.txHash}) → 紀錄自相矛盾`);
    allOk = false;
  } else {
    note("本筆為 skip（無開倉 tx）→ 只驗 VC 授權與付款部分。");
  }

  console.log("");
  if (allOk) console.log("✅ 此筆交易可被承認（hash chain 完整、VC 有效且與內容綁定、tx 屬實、授權相符）。");
  else console.log("❌ 驗證失敗：上面標 ✗ 的項目對不上，此筆無法被承認。");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error("audit-verify 失敗：", e?.message ?? e); process.exit(1); });
