// 授權 VC 撤銷（狀態清單）的操作工具 —— ADR-016。不持有、也不要求使用者的私鑰：
// 清單由簽發者（使用者錢包）簽章，這支只產生待簽的 typed data、組裝、驗證、安裝。
// 不連鏈、不送交易。
//
//   npx tsx examples/vc-status.ts init [--dir <VC_STATUS_DIR>]
//       建立清單目錄與 index.json 目錄標記。驗證端在沒有標記的目錄上一律回「狀態不明」（寫入拒絕），
//       所以新部署必須先跑這一步——它等於營運方宣告「這裡就是權威的清單目錄，沒有檔案＝沒有清單」。
//   npx tsx examples/vc-status.ts jti --vc <vc.json>
//       印出憑證 id（v2＝nonce；v1＝EIP-712 digest）
//   npx tsx examples/vc-status.ts typed-data --issuer 0x… [--from <目前清單.json>] [--sequence N]
//       [--revoke <jti>[,<jti>…]] [--revoke-before <unix 秒>|now] [--valid-days 30] [--manager 0x…]
//       印出 eth_signTypedData_v4 的 JSON（交給簽發者的錢包簽，例如 `cast wallet sign --data --from-file`）
//       --from：沿用目前清單的撤銷項目與 revokedBefore，sequence 預設 +1（新清單必須是累積的）
//       目錄（--dir 或 VC_STATUS_DIR）裡已有這個簽發者的清單時，必須帶 --from。沒有 --from 時 sequence 預設 1
//       （與 SDK 的 prev.sequence + 1 慣例一致）。--revoke-before now ＝ now + 301 秒（涵蓋 VC 的時鐘誤差；
//       撤銷後約 5 分鐘內新簽的 VC 也會被算成已撤銷，請等 5 分鐘再重簽）。
//   npx tsx examples/vc-status.ts assemble --typed <typed.json> --signature 0x…
//       組裝成狀態清單 JSON 並立即驗證（簽的人不是 issuer → 失敗，不輸出半成品）
//   npx tsx examples/vc-status.ts verify --list <list.json> [--manager 0x…]
//   npx tsx examples/vc-status.ts install --list <list.json> [--dir <VC_STATUS_DIR>] [--manager 0x…]
//       驗證後寫入 <dir>/<issuer>.json（sequence 必須大於目錄裡現有的；新清單少了現有清單的撤銷項目時拒絕，
//       除非加 --allow-drop），並建立 index.json 目錄標記
//       （整個目錄可原樣放上任何靜態主機，給 VC_STATUS_URL 使用）
//   npx tsx examples/vc-status.ts check --vc <vc.json> [--action write|read]
//       用目前環境設定的檢查器（VC_STATUS_URL／VC_STATUS_DIR…）查這張 VC 的撤銷狀態
//   npx tsx examples/vc-status.ts expiring [--dir <VC_STATUS_DIR>] [--days 7]
//       列出目錄裡已過期或 N 天內到期的清單（有就 exit 1）。給營運方排程（cron）用：清單過期 → 該簽發者的
//       開倉、平倉全被拒。
import "@pepelab/shared/autoload-env";
import fs from "node:fs";
import path from "node:path";
import {
  verifyAuthorizationVC,
  credentialJti,
  verifyStatusList,
  canonicalRevokedIds,
  buildStatusListTypedValue,
  assembleStatusList,
  statusListDomain,
  STATUS_LIST_TYPES,
  STATUS_LIST_PRIMARY_TYPE,
  STATUS_DIRECTORY_TYPE,
  STATUS_DIRECTORY_MARKER,
  revokeAllCutoff,
  DEFAULT_STATUS_LIST_VALIDITY_DAYS,
  MAX_STATUS_LIST_VALIDITY_SEC,
  checkCredentialStatus,
  defaultStatusDir,
  getSessionManagerAddress,
  type AuthorizationVC,
  type CredentialStatusList,
} from "@pepelab/shared";
import { ethers } from "ethers";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) fail(`缺 --${name}`);
  return v!;
}
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const manager = () => {
  const m = arg("manager") ?? getSessionManagerAddress();
  if (!ethers.isAddress(m) || /^0x0{40}$/i.test(m)) fail("需要 session manager 位址（--manager 或 SESSION_MANAGER_ADDRESS）");
  return ethers.getAddress(m);
};

function ensureMarker(dir: string): void {
  const idx = path.join(dir, STATUS_DIRECTORY_MARKER);
  if (!fs.existsSync(idx)) fs.writeFileSync(idx, JSON.stringify({ type: STATUS_DIRECTORY_TYPE }, null, 2), "utf8");
}

const cmd = process.argv[2];

if (cmd === "jti") {
  const vc = readJson(need("vc")) as AuthorizationVC;
  const r = verifyAuthorizationVC(vc);
  const jti = credentialJti(r);
  if (!jti) fail(`無法取得 jti（${r.reasonCode ?? ""} ${r.reason ?? ""}）`);
  console.log(JSON.stringify({ jti, version: r.version, issuer: r.issuer, issuedAt: r.issuedAt, valid: r.valid, reasonCode: r.reasonCode }, null, 2));
} else if (cmd === "typed-data") {
  const issuer = ethers.getAddress(need("issuer"));
  const now = Math.floor(Date.now() / 1000);
  let prev: { sequence: number; revoked: string[]; revokedBefore: number } | null = null;
  const from = arg("from");
  if (from) {
    const v = verifyStatusList(readJson(from), { expectedIssuer: issuer, expectedVerifyingContract: manager(), now: Date.now() });
    // 過期的舊清單也可以當累積的起點（只取內容），但簽章／簽發者必須正確。
    if (!v.valid && v.reasonCode !== "STATUS_LIST_EXPIRED") fail(`--from 清單驗證失敗：${v.reasonCode} ${v.reason}`);
    const doc = readJson(from) as CredentialStatusList;
    prev = { sequence: doc.sequence, revoked: doc.revoked, revokedBefore: doc.revokedBefore };
  }
  if (!prev) {
    const existing = path.join(arg("dir") ?? defaultStatusDir(), `${issuer.toLowerCase()}.json`);
    if (fs.existsSync(existing)) fail(`目錄裡已有這個簽發者的清單（${existing}）：請帶 --from 以累積舊項目並遞增 sequence`);
  }
  const sequence = arg("sequence") ? Number(arg("sequence")) : prev ? prev.sequence + 1 : 1;
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail(`sequence 不合法：${arg("sequence")}`);
  if (prev && sequence <= prev.sequence) fail(`sequence(${sequence}) 必須大於目前清單的 ${prev.sequence}`);
  const rb = arg("revoke-before");
  const rbValue = rb === "now" ? revokeAllCutoff(now) : rb ? Number(rb) : 0;
  if (!Number.isSafeInteger(rbValue) || rbValue < 0) fail(`--revoke-before 不合法：${rb}`);
  const revokedBefore = Math.max(prev?.revokedBefore ?? 0, rbValue);
  const revoked = canonicalRevokedIds([...(prev?.revoked ?? []), ...(arg("revoke")?.split(",").filter(Boolean) ?? [])]);
  const days = Number(arg("valid-days") ?? DEFAULT_STATUS_LIST_VALIDITY_DAYS);
  if (!Number.isFinite(days) || days <= 0) fail(`--valid-days 不合法：${arg("valid-days")}`);
  const validUntil = now + Math.floor(days * 86400);
  if (validUntil - now > MAX_STATUS_LIST_VALIDITY_SEC) fail(`--valid-days 不得超過 ${MAX_STATUS_LIST_VALIDITY_SEC / 86400}`);
  const fields = { issuer, sequence, issuedAt: now, validUntil, revokedBefore, revoked };
  const v = buildStatusListTypedValue(fields);
  const typed = {
    domain: statusListDomain(manager()),
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...STATUS_LIST_TYPES,
    },
    primaryType: STATUS_LIST_PRIMARY_TYPE,
    message: { ...v, sequence: v.sequence.toString(), issuedAt: v.issuedAt.toString(), validUntil: v.validUntil.toString(), revokedBefore: v.revokedBefore.toString() },
  };
  console.log(JSON.stringify(typed, null, 2));
} else if (cmd === "assemble") {
  const t = readJson(need("typed"));
  const m = t.message;
  const fields = {
    issuer: ethers.getAddress(m.issuer),
    sequence: Number(m.sequence),
    issuedAt: Number(m.issuedAt),
    validUntil: Number(m.validUntil),
    revokedBefore: Number(m.revokedBefore),
    revoked: m.revoked as string[],
  };
  const doc = assembleStatusList({ ...fields, issuerAddress: fields.issuer, signature: need("signature"), verifyingContract: ethers.getAddress(t.domain.verifyingContract) });
  const v = verifyStatusList(doc, { now: Date.now() });
  if (!v.valid) fail(`組裝後驗證失敗：${v.reasonCode} ${v.reason}`);
  console.log(JSON.stringify(doc, null, 2));
} else if (cmd === "verify") {
  const v = verifyStatusList(readJson(need("list")), { now: Date.now(), expectedVerifyingContract: manager() });
  console.log(JSON.stringify(v, null, 2));
  if (!v.valid) process.exit(1);
} else if (cmd === "install") {
  const doc = readJson(need("list")) as CredentialStatusList;
  const v = verifyStatusList(doc, { now: Date.now(), expectedVerifyingContract: manager() });
  if (!v.valid) fail(`清單驗證失敗：${v.reasonCode} ${v.reason}`);
  const dir = arg("dir") ?? defaultStatusDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${v.list.issuer.toLowerCase()}.json`);
  let cur: CredentialStatusList | null = null;
  try {
    cur = readJson(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") fail(`現有清單無法讀取：${(e as Error).message}`);
  }
  if (cur && !(v.list.sequence > Number(cur.sequence))) fail(`sequence(${v.list.sequence}) 必須大於目錄裡現有的 ${cur.sequence}`);
  if (cur) {
    const missing = (cur.revoked ?? []).filter((id) => !v.list.revoked.includes(id));
    if (missing.length && !process.argv.includes("--allow-drop")) {
      fail(
        `新清單少了現有清單的 ${missing.length} 個撤銷項目：從沒看過舊清單的驗證端會不知道這些撤銷。` +
          "請用 typed-data --from 產生累積的清單；確定要移除（例如那些 VC 都已過期）才加 --allow-drop",
      );
    }
    if (missing.length) console.warn(`⚠ --allow-drop：移除 ${missing.length} 個撤銷項目（看過舊清單的驗證端仍記得）`);
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
  ensureMarker(dir);
  console.log(`✓ 已安裝 ${file}（sequence ${v.list.sequence}，撤銷 ${v.list.revoked.length} 筆，revokedBefore ${v.list.revokedBefore}）`);
} else if (cmd === "init") {
  const dir = arg("dir") ?? defaultStatusDir();
  fs.mkdirSync(dir, { recursive: true });
  ensureMarker(dir);
  console.log(`✓ 清單目錄就緒：${path.join(dir, STATUS_DIRECTORY_MARKER)}（沒有檔案的簽發者＝沒有清單）`);
} else if (cmd === "expiring") {
  const dir = arg("dir") ?? defaultStatusDir();
  const days = Number(arg("days") ?? 7);
  if (!Number.isFinite(days) || days < 0) fail(`--days 不合法：${arg("days")}`);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => /^0x[0-9a-f]{40}\.json$/.test(f));
  } catch (e) {
    fail(`讀不到清單目錄 ${dir}：${(e as Error).message}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const soon: string[] = [];
  for (const f of names!) {
    let doc: CredentialStatusList;
    try {
      doc = readJson(path.join(dir, f));
    } catch {
      soon.push(`${f}：無法解析`);
      continue;
    }
    const left = Number(doc.validUntil) - nowSec;
    if (!(left > days * 86400)) {
      soon.push(`${f}：sequence ${doc.sequence}，${left <= 0 ? "已過期" : `${Math.floor(left / 3600)} 小時後到期`}（${new Date(Number(doc.validUntil) * 1000).toISOString()}）`);
    }
  }
  if (soon.length) {
    console.log(`⚠ ${soon.length} 份清單已過期或 ${days} 天內到期（請通知簽發者續簽）：`);
    for (const s of soon) console.log(`  ${s}`);
    process.exit(1);
  }
  console.log(`✓ ${names!.length} 份清單都在 ${days} 天後才到期`);
} else if (cmd === "check") {
  const vc = readJson(need("vc")) as AuthorizationVC;
  const r = verifyAuthorizationVC(vc);
  if (!r.valid) fail(`VC 本身驗證失敗：${r.reasonCode} ${r.reason}`);
  const action = arg("action") === "read" ? "read" : "write";
  const st = await checkCredentialStatus(r, { action });
  console.log(JSON.stringify(st, null, 2));
  if (!st.ok) process.exit(1);
} else {
  console.error("用法見檔案開頭註解：init | jti | typed-data | assemble | verify | install | check | expiring");
  process.exit(2);
}
