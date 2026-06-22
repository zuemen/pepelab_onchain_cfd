// audit-verify.ts — 讀一筆稽核紀錄，獨立重新驗證它「可不可被承認」。
// 證據鏈：VC 簽章(誰授權) → 該 VC 摘要與紀錄相符 → 鏈上該 positionId 屬於 session.user(=VC issuer)。
// 全部可獨立核對，不需信任 agent。
//
// 跑法：npx tsx examples/audit-verify.ts [行號]   # 預設驗最後一筆；行號從 0 起
//   需 AGENT_AUTH_VC_PATH 指向該筆用的 VC（紀錄只存摘要，不存 VC 全文）。
import {
  verifyAuthorizationVC, vcId, parseDidPkh, getSession, makeProvider, makeContracts,
  readAudit, type AuditRecord,
} from "@pepelab/shared";
import { loadVc, AUDIT_PATH } from "./vc-gate.ts";

const ok = (m: string) => console.log("  ✓ " + m);
const bad = (m: string) => console.log("  ✗ " + m);

async function main() {
  const idxArg = process.argv[2];
  const records = readAudit(AUDIT_PATH);
  if (!records.length) throw new Error(`稽核檔無紀錄：${AUDIT_PATH}（先跑 x402-autonomous/loop 產生）`);
  const idx = idxArg !== undefined ? Number(idxArg) : records.length - 1;
  const rec = records[idx] as AuditRecord | undefined;
  if (!rec) throw new Error(`行號 ${idx} 超出範圍（共 ${records.length} 筆）`);

  console.log(`=== 稽核驗證：第 ${idx} 筆 / 共 ${records.length} ===`);
  console.log(JSON.stringify(rec, null, 2));
  console.log("\n獨立核對：");

  let allOk = true;

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
  }

  // 3) 鏈上：開倉的 positionId 屬於 session.user（= VC issuer）。
  if (rec.action.opened && rec.action.positionId) {
    try {
      const sess: any = await getSession(rec.sessionId);
      const sessionUser = (sess?.detail?.user ?? "").toLowerCase();
      const perp = makeContracts(makeProvider()).perp;
      const p: any = await perp.getPosition(Number(rec.action.positionId));
      const owner = String(p?.owner ?? "").toLowerCase();
      const issuerAddr = vc ? parseDidPkh(vc.issuer).address.toLowerCase() : "";
      if (owner && owner === sessionUser) ok(`鏈上 position #${rec.action.positionId} owner == session.user（${owner}）`);
      else { bad(`position owner(${owner}) ≠ session.user(${sessionUser})`); allOk = false; }
      if (issuerAddr && issuerAddr === sessionUser) ok("VC issuer == 鏈上 session.user（授權相符）");
      else if (issuerAddr) { bad(`VC issuer(${issuerAddr}) ≠ session.user(${sessionUser})`); allOk = false; }
    } catch (e) {
      bad(`鏈上核對失敗：${(e as Error).message}`); allOk = false;
    }
  } else {
    console.log("  · 本筆為 skip（無開倉 tx）→ 只驗 VC 授權部分。");
  }

  console.log("");
  if (allOk) console.log("✅ 此筆交易可被承認（VC 有效、tx 屬實、授權相符）。");
  else console.log("❌ 驗證失敗：上面標 ✗ 的項目對不上，此筆無法被承認。");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error("audit-verify 失敗：", e?.message ?? e); process.exit(1); });
