// 合格投資人 VC 發證服務測試。完全離線：不連鏈、不送交易。
//   npx tsx issuer/issuer.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { dirStatusSource, fileStatusStateStore, memoryStatusStateStore } from "../shared/src/vcStatus.ts";
import {
  ATTESTATION_TYPES,
  ATTESTATION_TYPE_STRING,
  CREDENTIAL_TYPE_IDS,
  attestationDigest,
  buildRevokeTx,
  buildSubmitTx,
  checkInvestorCredentialStatus,
  credentialHashOf,
  decodeRevert,
  issueInvestorCredential,
  issueInvestorStatusList,
  registryInterface,
  verifyInvestorCredential,
  verifyInvestorStatusList,
} from "./investorVc.ts";
import { localProvider, parseArgs, runInit, runIssue, runRevoke, runVerify } from "./cli.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-investor-vc-"));
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const CHAIN = 31337;
const REGISTRY = ethers.getAddress("0x" + "c0".repeat(20));
const OTHER_REGISTRY = ethers.getAddress("0x" + "c1".repeat(20));
const issuer = ethers.Wallet.createRandom();
const mallory = ethers.Wallet.createRandom();
const investor = ethers.Wallet.createRandom();
const NOW = Date.now();

const issue = (o: Record<string, unknown> = {}) =>
  issueInvestorCredential({
    issuer,
    chainId: CHAIN,
    registry: REGISTRY,
    subject: investor.address,
    statusBaseUrl: "https://status.example.invalid/investor",
    statusListIndex: 3,
    nonce: 0,
    ...o,
  } as Parameters<typeof issueInvestorCredential>[0]);

// 1. schema 與 Solidity 一致
{
  const sol = fs.readFileSync(path.join(HERE, "..", "..", "contracts", "src", "VCKycRegistry.sol"), "utf8");
  const m = /keccak256\(\s*"(QualifiedInvestorAttestation\([^"]+\))"\s*\)/.exec(sol);
  assert.ok(m, "VCKycRegistry.sol 找不到 ATTESTATION_TYPEHASH 的 type string");
  assert.strictEqual(m[1], ATTESTATION_TYPE_STRING);
  const enc = ethers.TypedDataEncoder.from(ATTESTATION_TYPES as Record<string, ethers.TypedDataField[]>);
  assert.strictEqual(enc.encodeType("QualifiedInvestorAttestation"), ATTESTATION_TYPE_STRING);
  assert.strictEqual(CREDENTIAL_TYPE_IDS.KYC_BASIC, ethers.id("KYC_BASIC"));
  assert.strictEqual(CREDENTIAL_TYPE_IDS.QUALIFIED_INVESTOR, ethers.id("QUALIFIED_INVESTOR"));
  assert.match(sol, /EIP712\("PepeLabVCKycRegistry", "1"\)/);
  ok("EIP-712 type string、類型 id、domain 名稱與 VCKycRegistry.sol 一致");
}

// 2. 簽發 → 驗證
const vc = await issue();
{
  assert.deepStrictEqual(vc["@context"].slice(0, 1), ["https://www.w3.org/ns/credentials/v2"]);
  assert.ok(vc.type.includes("VerifiableCredential") && vc.type.includes("QualifiedInvestorCredential"));
  assert.strictEqual(vc.issuer, `did:pkh:eip155:${CHAIN}:${issuer.address}`);
  assert.strictEqual(vc.credentialSubject.id, `did:pkh:eip155:${CHAIN}:${investor.address}`);
  assert.strictEqual(vc.credentialStatus.statusListIndex, "3");
  assert.strictEqual(vc.credentialStatus.statusListCredential, `https://status.example.invalid/investor/${issuer.address.toLowerCase()}.json`);
  // 鏈上不存個資：VC 裡也只有地址、類型、時間、雜湊
  const subjectKeys = Object.keys(vc.credentialSubject).sort();
  assert.deepStrictEqual(subjectKeys, ["credentialType", "id"]);
  const v = verifyInvestorCredential(vc, { expectedChainId: CHAIN, expectedRegistry: REGISTRY, trustedIssuers: [issuer.address] });
  assert.ok(v.valid, JSON.stringify(v));
  assert.strictEqual(v.issuer, issuer.address);
  assert.strictEqual(v.subject, investor.address);
  assert.strictEqual(v.credentialType, "QUALIFIED_INVESTOR");
  assert.strictEqual(v.credentialHash, credentialHashOf(vc.id));
  assert.strictEqual(v.expiresAt - v.issuedAt, 365 * 86400);
  assert.ok(v.deadline <= v.expiresAt);
  assert.strictEqual(v.digest, attestationDigest(v.domain, v.value));
  ok("簽發 W3C VC 2.0（did:pkh、credentialStatus 指向狀態清單）並驗簽成功；proof 即鏈上 attestation 簽章");
}

// 3. 竄改與 domain
{
  const clone = () => JSON.parse(JSON.stringify(vc));
  let d = clone();
  d.validUntil = new Date(Date.parse(d.validUntil) + 10 * 365 * 86400 * 1000).toISOString();
  let r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_BAD_SIGNATURE");
  d = clone();
  d.credentialSubject.id = `did:pkh:eip155:${CHAIN}:${mallory.address}`;
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_BAD_SIGNATURE");
  d = clone();
  d.credentialSubject.credentialType = "KYC_BASIC";
  d.type = ["VerifiableCredential", "KycBasicCredential"]; // 連 type 一起改，才會走到驗簽
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_BAD_SIGNATURE");
  d = clone();
  d.id = "urn:uuid:other";
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_HASH_MISMATCH");
  d = clone();
  d.issuer = `did:pkh:eip155:${CHAIN}:${mallory.address}`;
  r = verifyInvestorCredential(d);
  // 換 issuer：狀態清單網址（綁原發證者）先對不上 → MALFORMED；就算一併改網址，簽章也還原不出新 issuer。
  assert.ok(!r.valid && r.reasonCode === "VC_MALFORMED");
  d.credentialStatus.statusListCredential = `https://status.example.invalid/investor/${mallory.address.toLowerCase()}.json`;
  d.credentialStatus.id = `${d.credentialStatus.statusListCredential}#3`;
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_BAD_SIGNATURE");
  d = clone();
  d.proof.eip712Domain.verifyingContract = OTHER_REGISTRY;
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_BAD_SIGNATURE", "換 registry 位址會還原出別的簽者");
  r = verifyInvestorCredential(vc, { expectedRegistry: OTHER_REGISTRY });
  assert.ok(!r.valid && r.reasonCode === "VC_WRONG_DOMAIN");
  r = verifyInvestorCredential(vc, { expectedChainId: 84532 });
  assert.ok(!r.valid && r.reasonCode === "VC_WRONG_DOMAIN");
  r = verifyInvestorCredential(vc, { trustedIssuers: [mallory.address] });
  assert.ok(!r.valid && r.reasonCode === "VC_UNTRUSTED_ISSUER");
  r = verifyInvestorCredential(vc, { now: NOW + 400 * 86400 * 1000 });
  assert.ok(!r.valid && r.reasonCode === "VC_EXPIRED");
  const future = await issue({ issuedAt: Math.floor(NOW / 1000) + 3600 });
  r = verifyInvestorCredential(future);
  assert.ok(!r.valid && r.reasonCode === "VC_ISSUED_IN_FUTURE");
  for (const bad of [null, {}, { ...clone(), type: ["VerifiableCredential"] }, { ...clone(), validFrom: "2026-01-01T00:00:00.500Z" }]) {
    const x = verifyInvestorCredential(bad);
    assert.ok(!x.valid && x.reasonCode === "VC_MALFORMED");
  }
  // 錯誤簽者：mallory 簽、宣稱 issuer 是自己 → 簽章有效但不在信任清單（鏈上同理 UntrustedIssuer）
  const forged = await issueInvestorCredential({
    issuer: mallory, chainId: CHAIN, registry: REGISTRY, subject: investor.address,
    statusBaseUrl: "https://x.invalid", statusListIndex: 0, nonce: 0,
  });
  r = verifyInvestorCredential(forged, { trustedIssuers: [issuer.address] });
  assert.ok(!r.valid && r.reasonCode === "VC_UNTRUSTED_ISSUER");
  // 未簽章的欄位也要結構一致（審查 #5、#6）
  d = clone();
  d.type = ["VerifiableCredential", "KycBasicCredential"];
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_MALFORMED", "QI 憑證不可宣稱是 KycBasicCredential");
  d = clone();
  d.credentialStatus.statusListCredential = `https://status.example.invalid/investor/${mallory.address.toLowerCase()}.json`;
  d.credentialStatus.id = `${d.credentialStatus.statusListCredential}#3`;
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_MALFORMED", "狀態清單網址必須是這個發證者的");
  d = clone();
  d.credentialStatus.id = `${d.credentialStatus.statusListCredential}#9`;
  r = verifyInvestorCredential(d);
  assert.ok(!r.valid && r.reasonCode === "VC_MALFORMED", "status id 必須指向本憑證的索引");
  const basic = await issue({ credentialType: "KYC_BASIC" });
  assert.deepStrictEqual(basic.type, ["VerifiableCredential", "KycBasicCredential"]);
  const vb = verifyInvestorCredential(basic);
  assert.ok(vb.valid && vb.credentialType === "KYC_BASIC");
  ok("竄改效期／subject／類型／id／issuer／registry → 拒絕；domain 不符、過期、未來簽發、錯誤簽者、格式錯誤、VC type 與類型不符、狀態清單網址非本發證者 → 拒絕");
}

// 4. 狀態清單：沿用 vcStatus.ts 的來源與狀態儲存（防重放、sticky、扣住）
{
  const dir = path.join(TMP, "status");
  const statePath = path.join(TMP, "state.json");
  const v = verifyInvestorCredential(vc);
  assert.ok(v.valid);
  // 未初始化目錄 → fail-closed
  let s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store: memoryStatusStateStore() });
  assert.strictEqual(s.status, "unknown");
  assert.strictEqual(s.reasonCode, "STATUS_UNAVAILABLE");
  runInit(dir);
  const store = fileStatusStateStore(statePath);
  s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store });
  assert.ok(s.ok && s.reasonCode === "STATUS_NO_LIST");

  // 先發一份沒有撤銷的清單（seq 1），等一下拿來重放
  const seq1 = await issueInvestorStatusList({ issuer, chainId: CHAIN, registry: REGISTRY, sequence: 1, revoked: [] });
  const listPath = path.join(dir, `${issuer.address.toLowerCase()}.json`);
  fs.writeFileSync(listPath, JSON.stringify(seq1));
  s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store });
  assert.ok(s.ok && s.reasonCode === "STATUS_ACTIVE" && s.listSequence === 1);

  // CLI 撤銷：sequence 2、累積、交易資料
  const r = await runRevoke({ issuer, credentialHash: v.credentialHash, registry: REGISTRY, chainId: CHAIN, statusDir: dir });
  assert.strictEqual(r.list.sequence, 2);
  assert.deepStrictEqual(r.list.revoked, [v.credentialHash]);
  const decoded = registryInterface.decodeFunctionData("revoke", r.tx.data);
  assert.strictEqual(decoded[0].toLowerCase(), v.credentialHash);
  assert.strictEqual(r.tx.to, REGISTRY);
  s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store });
  assert.ok(!s.ok && s.status === "revoked" && s.reasonCode === "VC_REVOKED");

  // 重放舊清單（seq 1，沒有撤銷）→ 已撤銷的不會復活（sticky）
  fs.writeFileSync(listPath, JSON.stringify(seq1));
  s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store });
  assert.ok(!s.ok && s.status === "revoked");
  // 另一張沒被撤銷的憑證，遇到舊清單 → 重放偵測（unknown，fail-closed）
  const vc2 = await issue({ nonce: 1 });
  const v2 = verifyInvestorCredential(vc2);
  assert.ok(v2.valid);
  s = await checkInvestorCredentialStatus(v2, { source: dirStatusSource(dir), store });
  assert.ok(!s.ok && s.status === "unknown" && s.reasonCode === "STATUS_LIST_REPLAYED");
  // 清單被拿掉 → 扣住
  fs.rmSync(listPath);
  s = await checkInvestorCredentialStatus(v2, { source: dirStatusSource(dir), store });
  assert.ok(!s.ok && s.reasonCode === "STATUS_LIST_WITHHELD");
  // 跨 process：狀態檔裡的撤銷仍然有效
  s = await checkInvestorCredentialStatus(v, { source: dirStatusSource(dir), store: fileStatusStateStore(statePath) });
  assert.ok(!s.ok && s.status === "revoked");
  ok("狀態清單：未初始化→拒、無清單→有效、撤銷→revoked、重放舊清單不復活並偵測重放、清單被扣住→拒");
}

// 5. 清單驗證的拒絕路徑
{
  const list = await issueInvestorStatusList({ issuer, chainId: CHAIN, registry: REGISTRY, sequence: 5, revoked: [credentialHashOf("a")] });
  assert.ok(verifyInvestorStatusList(list).valid);
  let r = verifyInvestorStatusList(list, { expectedRegistry: OTHER_REGISTRY });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_WRONG_DOMAIN");
  r = verifyInvestorStatusList(list, { expectedChainId: 84532 });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_WRONG_DOMAIN");
  r = verifyInvestorStatusList(list, { expectedIssuer: mallory.address });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_WRONG_ISSUER");
  r = verifyInvestorStatusList({ ...list, sequence: 6 });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_BAD_SIGNATURE");
  r = verifyInvestorStatusList({ ...list, revoked: [...list.revoked, list.revoked[0]] });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_MALFORMED");
  r = verifyInvestorStatusList(list, { now: NOW + 31 * 86400 * 1000 });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_EXPIRED");
  await assert.rejects(issueInvestorStatusList({ issuer, chainId: CHAIN, registry: REGISTRY, sequence: 1, validUntil: Math.floor(NOW / 1000) + 91 * 86400 }));
  // 清單與 VC 不可互換：VC 簽章拿來當清單簽章 → 還原者不符
  r = verifyInvestorStatusList({ ...list, proof: { ...list.proof, proofValue: vc.proof.proofValue } });
  assert.ok(!r.valid && r.reasonCode === "STATUS_LIST_BAD_SIGNATURE");
  ok("清單：registry／chainId／簽發者不符、竄改、非正規排序、過期、有效期過長 → 拒絕；與 VC 簽章不可互換");
}

// 6. 交易資料、revert 解碼、本機 RPC 界線、CLI 參數
{
  const v = verifyInvestorCredential(vc);
  assert.ok(v.valid);
  const tx = buildSubmitTx(REGISTRY, v);
  const [att, sig] = registryInterface.decodeFunctionData("submitAttestation", tx.data);
  assert.strictEqual(att.subject, investor.address);
  assert.strictEqual(att.credentialHash.toLowerCase(), v.credentialHash);
  assert.strictEqual(sig, v.signature);
  assert.throws(() => buildRevokeTx(REGISTRY, "0x1234"));
  const errData = registryInterface.encodeErrorResult("CredentialIsRevoked", [v.credentialHash]);
  assert.match(decodeRevert(errData) ?? "", /^CredentialIsRevoked\(/);
  const exErr = new ethers.Interface(["error NotKycVerified(address user)"]).encodeErrorResult("NotKycVerified", [investor.address]);
  assert.strictEqual(decodeRevert(exErr), `NotKycVerified(${investor.address})`);
  await assert.rejects(localProvider("https://sepolia.base.org"), /只允許本機 RPC/);
  await assert.rejects(localProvider("http://10.0.0.5:8545"), /只允許本機 RPC/);
  assert.deepStrictEqual(parseArgs(["revoke", "--hash", "0xab", "--send"]), { cmd: "revoke", args: { hash: "0xab", send: true } });
  assert.throws(() => parseArgs(["issue", "oops"]));
  ok("submitAttestation／revoke 交易資料可解碼；revert 原因可讀；--send 只允許本機 RPC；參數解析");
}

// 7. 發證紀錄只存索引與雜湊（沒有個資）、索引遞增；verify 端到端
{
  const db = path.join(TMP, "db.json");
  const a = await runIssue({ issuer, subject: investor.address, registry: REGISTRY, chainId: CHAIN, nonce: 0n, dbPath: db });
  const b = await runIssue({ issuer, subject: mallory.address, registry: REGISTRY, chainId: CHAIN, type: "KYC_BASIC", nonce: 0n, dbPath: db });
  assert.strictEqual(a.credentialStatus.statusListIndex, "0");
  assert.strictEqual(b.credentialStatus.statusListIndex, "1");
  const rec = JSON.parse(fs.readFileSync(db, "utf8"));
  assert.deepStrictEqual(Object.keys(rec.issued[0]).sort(), ["credentialHash", "expiresAt", "id", "index", "issuedAt", "subject", "type"]);
  await assert.rejects(runIssue({ issuer, subject: investor.address, registry: REGISTRY, chainId: CHAIN, type: "VIP", nonce: 0n, dbPath: db }));
  const dir = path.join(TMP, "status-e2e");
  runInit(dir);
  const res = await runVerify({ vc: a, registry: REGISTRY, chainId: CHAIN, statusDir: dir, statePath: path.join(TMP, "e2e-state.json") });
  assert.ok(res.signature.valid && res.status?.ok && res.onchain === null);
  ok("發證紀錄只有索引／id／雜湊／地址／時間，索引遞增；不支援的類型拒絕；verify 串起驗簽＋狀態");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ issuer.test.ts 全過（${n} 組）`);
