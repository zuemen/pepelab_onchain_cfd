// 合格投資人 VC 發證服務 CLI —— docs/SSI_RWA_ACCESS.md §5。
//
//   npx tsx issuer/cli.ts init     [--dir <狀態清單目錄>]
//   npx tsx issuer/cli.ts issue    --subject 0x… --registry 0x… --chain-id N [--type QUALIFIED_INVESTOR]
//                                  [--nonce N | --rpc URL] [--valid-days 365] [--status-base-url URL] [--out vc.json]
//   npx tsx issuer/cli.ts revoke   (--vc vc.json | --hash 0x…) --registry 0x… --chain-id N
//                                  [--rpc http://127.0.0.1:8545 --send]
//   npx tsx issuer/cli.ts verify   --vc vc.json [--registry 0x… --chain-id N] [--rpc URL]
//   npx tsx issuer/cli.ts submit   --vc vc.json --rpc http://127.0.0.1:8545     （投資人／代送者送上鏈，只限本機鏈）
//
// 金鑰：只從環境變數讀（不收指令列參數，避免進 shell history）。
//   發證者（issue／revoke 簽狀態清單）：ISSUER_PRIVATE_KEY，或加密 keystore
//     ISSUER_KEYSTORE（~/.foundry/keystores 下的名稱或路徑）＋ISSUER_KEYSTORE_PASSWORD_FILE，
//     兩者互斥；規則與 keeper 相同（keeper/keySource.ts：拒絕疑似私鑰的值、錯誤訊息不帶秘密），
//     私鑰只在這個行程的記憶體裡解開。
//   送出者（submit，只限本機鏈）：SUBMITTER_PRIVATE_KEY。
// 正式環境發證金鑰應放 KMS（ADR-014），以 issueInvestorCredentialWithSigner 接上。
//
// 鏈上動作的界線：`revoke` 預設**只印出交易資料**（to／data），由發證者的錢包或 KMS 送出；
// 加 `--send` 時只允許 RPC 是 localhost／127.0.0.1，且 eth_chainId 必須等於 --chain-id。
// 這支 CLI 不會對任何公開鏈送交易。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { keySpecFromEnv, loadWalletFromSpec } from "../keeper/keySource.ts";
import {
  STATUS_DIRECTORY_MARKER,
  STATUS_DIRECTORY_TYPE,
  dirStatusSource,
  fileStatusStateStore,
  httpStatusSource,
} from "../shared/src/vcStatus.ts";
import {
  CREDENTIAL_TYPE_IDS,
  VC_KYC_REGISTRY_ABI,
  buildRevokeTx,
  checkInvestorCredentialStatus,
  credentialHashOf,
  decodeRevert,
  isCredentialTypeName,
  issueInvestorCredential,
  issueInvestorStatusList,
  toContractAttestation,
  verifyInvestorCredential,
  verifyInvestorStatusList,
  type InvestorCredential,
  type InvestorStatusList,
} from "./investorVc.ts";

const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_STATUS_DIR = path.join(AGENT_DIR, ".state", "investor-status");
export const DEFAULT_STATE_PATH = path.join(AGENT_DIR, ".state", "investor-status-state.json");
export const DEFAULT_DB_PATH = path.join(AGENT_DIR, ".state", "investor-issuer-db.json");
export const DEFAULT_STATUS_BASE_URL = "https://status.example.invalid/investor";

type Args = Record<string, string | boolean>;

export function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = "help", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`不認得的參數：${a}`);
    const k = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) args[k] = true;
    else {
      args[k] = next;
      i++;
    }
  }
  return { cmd, args };
}

const str = (args: Args, k: string, def?: string): string => {
  const v = args[k];
  if (typeof v === "string") return v;
  if (def !== undefined) return def;
  throw new Error(`缺少 --${k}`);
};

function walletFromEnv(name: string): ethers.Wallet {
  const pk = process.env[name];
  if (!pk) throw new Error(`請在環境變數 ${name} 提供金鑰（不接受指令列參數）`);
  return new ethers.Wallet(pk);
}

/**
 * 發證者錢包：ISSUER_PRIVATE_KEY 或 ISSUER_KEYSTORE＋ISSUER_KEYSTORE_PASSWORD_FILE（互斥）。
 * 錯誤訊息只帶環境變數名稱／keystore 路徑，不帶私鑰、密碼或 keystore 內容。
 */
export async function issuerWalletFromEnv(
  env: Record<string, string | undefined> = process.env,
  home?: string,
  readFile?: (p: string) => string,
): Promise<ethers.Wallet> {
  const r = keySpecFromEnv(env, "ISSUER", home);
  if ("error" in r) throw new Error(`${r.error}（發證者金鑰只讀環境變數，不接受指令列參數）`);
  return loadWalletFromSpec(r.spec, "issuer", readFile);
}

/** 只允許本機 RPC，且 chainId 必須等於預期。回傳 provider。 */
export async function localProvider(rpc: string, expectedChainId?: number): Promise<ethers.JsonRpcProvider> {
  const u = new URL(rpc);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error(`只允許本機 RPC（127.0.0.1／localhost），拒絕 ${u.hostname}；公開鏈請改用 --rpc 省略、只印交易資料`);
  }
  // cacheTimeout -1：本機鏈連續送交易時，不能沿用 250 ms 內快取的 nonce。
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    throw new Error(`RPC 的 chainId ${chainId} 不等於 --chain-id ${expectedChainId}`);
  }
  return provider;
}

// ── 發證者的本機紀錄（只有雜湊與索引，沒有個資）────────────────────────────────

interface IssuerDb {
  version: 1;
  nextIndex: number;
  issued: { index: number; id: string; credentialHash: string; subject: string; type: string; issuedAt: number; expiresAt: number }[];
}

function readDb(file: string): IssuerDb {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d?.version !== 1 || !Number.isSafeInteger(d.nextIndex) || !Array.isArray(d.issued)) throw new Error("格式不符");
    return d;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextIndex: 0, issued: [] };
    throw new Error(`發證紀錄 ${file} 無法讀取：${(e as Error).message}`);
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ── 指令 ──────────────────────────────────────────────────────────────────────

export function runInit(dir = DEFAULT_STATUS_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, STATUS_DIRECTORY_MARKER);
  if (!fs.existsSync(marker)) writeJson(marker, { type: STATUS_DIRECTORY_TYPE, purpose: "InvestorCredentialStatusList" });
  return marker;
}

export async function runIssue(o: {
  issuer: ethers.Wallet | ethers.HDNodeWallet;
  subject: string;
  registry: string;
  chainId: number;
  type?: string;
  nonce: bigint;
  validDays?: number;
  statusBaseUrl?: string;
  dbPath?: string;
}): Promise<InvestorCredential> {
  const type = o.type ?? "QUALIFIED_INVESTOR";
  if (!isCredentialTypeName(type)) throw new Error(`不支援的類型：${type}（可用 ${Object.keys(CREDENTIAL_TYPE_IDS).join("、")}）`);
  const dbPath = o.dbPath ?? DEFAULT_DB_PATH;
  const db = readDb(dbPath);
  const vc = await issueInvestorCredential({
    issuer: o.issuer,
    chainId: o.chainId,
    registry: o.registry,
    subject: o.subject,
    credentialType: type,
    statusBaseUrl: o.statusBaseUrl ?? DEFAULT_STATUS_BASE_URL,
    statusListIndex: db.nextIndex,
    nonce: o.nonce,
    validDays: o.validDays,
  });
  db.issued.push({
    index: db.nextIndex,
    id: vc.id,
    credentialHash: vc.proof.attestation.credentialHash,
    subject: ethers.getAddress(o.subject),
    type,
    issuedAt: Date.parse(vc.validFrom) / 1000,
    expiresAt: Date.parse(vc.validUntil) / 1000,
  });
  db.nextIndex += 1;
  writeJson(dbPath, db);
  return vc;
}

/** 撤銷：更新（累積、sequence+1）並簽署狀態清單，寫進清單目錄；回傳清單與鏈上撤銷交易資料。 */
export async function runRevoke(o: {
  issuer: ethers.Wallet | ethers.HDNodeWallet;
  credentialHash: string;
  registry: string;
  chainId: number;
  statusDir?: string;
  now?: number;
}): Promise<{ list: InvestorStatusList; listPath: string; tx: { to: string; data: string } }> {
  const dir = o.statusDir ?? DEFAULT_STATUS_DIR;
  runInit(dir);
  const issuerAddr = await o.issuer.getAddress();
  const listPath = path.join(dir, `${issuerAddr.toLowerCase()}.json`);
  const nowSec = Math.floor((o.now ?? Date.now()) / 1000);
  let prev: { sequence: number; revoked: string[]; revokedBefore: number } | null = null;
  if (fs.existsSync(listPath)) {
    const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
    // 舊清單可能已過期（需要續簽），所以這裡只驗簽與 domain，不驗時效。
    const v = verifyInvestorStatusList(doc, {
      now: doc.issuedAt * 1000,
      expectedIssuer: issuerAddr,
      expectedChainId: o.chainId,
      expectedRegistry: o.registry,
    });
    if (!v.valid) throw new Error(`既有清單 ${listPath} 驗不過（${v.reasonCode}）：${v.reason}`);
    prev = v.list;
  }
  const list = await issueInvestorStatusList({
    issuer: o.issuer,
    chainId: o.chainId,
    registry: o.registry,
    sequence: (prev?.sequence ?? 0) + 1,
    issuedAt: nowSec,
    revokedBefore: prev?.revokedBefore ?? 0,
    revoked: [...(prev?.revoked ?? []), o.credentialHash.toLowerCase()],
  });
  writeJson(listPath, list);
  return { list, listPath, tx: buildRevokeTx(o.registry, o.credentialHash) };
}

export async function runVerify(o: {
  vc: unknown;
  registry?: string;
  chainId?: number;
  statusDir?: string;
  statusUrl?: string;
  statePath?: string;
  provider?: ethers.Provider;
}) {
  const v = verifyInvestorCredential(o.vc, { expectedRegistry: o.registry, expectedChainId: o.chainId });
  if (!v.valid) return { signature: v, status: null, onchain: null };
  const source = o.statusUrl ? httpStatusSource(o.statusUrl) : dirStatusSource(o.statusDir ?? DEFAULT_STATUS_DIR);
  const status = await checkInvestorCredentialStatus(v, {
    source,
    store: fileStatusStateStore(o.statePath ?? DEFAULT_STATE_PATH),
  });
  let onchain: null | Record<string, unknown> = null;
  if (o.provider) {
    const reg = new ethers.Contract(v.domain.verifyingContract, VC_KYC_REGISTRY_ABI as unknown as string[], o.provider);
    const [trusted, revokedOnChain, used, nonce, [record, valid]] = await Promise.all([
      reg.trustedIssuer(v.issuer, v.value.credentialType),
      reg.revoked(v.issuer, v.credentialHash),
      reg.credentialUsed(v.credentialHash),
      reg.nonces(v.subject),
      reg.credentialOf(v.subject, v.value.credentialType),
    ]);
    onchain = {
      issuerTrusted: trusted,
      revokedOnChain,
      submitted: used,
      subjectNonce: nonce.toString(),
      registeredCredentialHash: record.credentialHash,
      valid,
    };
  }
  return { signature: v, status, onchain };
}

export async function runSubmit(o: { vc: unknown; submitter: ethers.Signer; provider: ethers.Provider }) {
  const v = verifyInvestorCredential(o.vc, { expectedChainId: Number((await o.provider.getNetwork()).chainId) });
  if (!v.valid) throw new Error(`VC 驗不過（${v.reasonCode}）：${v.reason}`);
  const reg = new ethers.Contract(v.domain.verifyingContract, VC_KYC_REGISTRY_ABI as unknown as string[], o.submitter);
  try {
    const tx = await reg.submitAttestation(toContractAttestation(v.value), v.signature);
    const rc = await tx.wait();
    return { hash: tx.hash as string, blockNumber: rc?.blockNumber ?? null, verified: v };
  } catch (e) {
    const data = (e as { data?: string; info?: { error?: { data?: string } } }).data ?? (e as any)?.info?.error?.data;
    throw new Error(`submitAttestation 被拒：${decodeRevert(data) ?? (e as Error).message}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const HELP = `合格投資人 VC 發證服務
  init   [--dir DIR]
  issue  --subject 0x… --registry 0x… --chain-id N [--type QUALIFIED_INVESTOR|KYC_BASIC] [--nonce N | --rpc URL]
         [--valid-days 365] [--status-base-url URL] [--out vc.json] [--db PATH]
  revoke (--vc vc.json | --hash 0x…) --registry 0x… --chain-id N [--dir DIR] [--rpc 本機URL --send]
  verify --vc vc.json [--registry 0x… --chain-id N] [--dir DIR | --status-url URL] [--state PATH] [--rpc URL]
  submit --vc vc.json --rpc 本機URL
金鑰（只讀環境變數）：
  issue／revoke：ISSUER_PRIVATE_KEY，或 ISSUER_KEYSTORE（keystore 名稱或路徑）＋ISSUER_KEYSTORE_PASSWORD_FILE
  submit：SUBMITTER_PRIVATE_KEY`;

async function main(argv: string[]) {
  const { cmd, args } = parseArgs(argv);
  const readVc = () => JSON.parse(fs.readFileSync(str(args, "vc"), "utf8"));
  switch (cmd) {
    case "init": {
      console.log(`✓ 狀態清單目錄標記：${runInit(str(args, "dir", DEFAULT_STATUS_DIR))}`);
      return;
    }
    case "issue": {
      const chainId = Number(str(args, "chain-id"));
      let nonce: bigint;
      if (typeof args.nonce === "string") nonce = BigInt(args.nonce);
      else if (typeof args.rpc === "string") {
        const p = await localProvider(args.rpc, chainId);
        const reg = new ethers.Contract(str(args, "registry"), VC_KYC_REGISTRY_ABI as unknown as string[], p);
        nonce = await reg.nonces(str(args, "subject"));
      } else throw new Error("請給 --nonce（等於鏈上 nonces(subject)）或本機 --rpc 讓 CLI 讀取");
      const vc = await runIssue({
        issuer: await issuerWalletFromEnv(),
        subject: str(args, "subject"),
        registry: str(args, "registry"),
        chainId,
        type: str(args, "type", "QUALIFIED_INVESTOR"),
        nonce,
        validDays: args["valid-days"] ? Number(args["valid-days"]) : undefined,
        statusBaseUrl: str(args, "status-base-url", DEFAULT_STATUS_BASE_URL),
        dbPath: str(args, "db", DEFAULT_DB_PATH),
      });
      const out = typeof args.out === "string" ? args.out : null;
      if (out) {
        writeJson(out, vc);
        console.log(`✓ 已簽發 ${vc.credentialSubject.credentialType} VC → ${out}`);
        console.log(`  id=${vc.id}  credentialHash=${vc.proof.attestation.credentialHash}  到期 ${vc.validUntil}`);
      } else console.log(JSON.stringify(vc, null, 2));
      return;
    }
    case "revoke": {
      const chainId = Number(str(args, "chain-id"));
      const hash = typeof args.hash === "string" ? args.hash : credentialHashOf(readVc().id);
      const issuer = await issuerWalletFromEnv();
      const r = await runRevoke({ issuer, credentialHash: hash, registry: str(args, "registry"), chainId, statusDir: str(args, "dir", DEFAULT_STATUS_DIR) });
      console.log(`✓ 狀態清單已更新：sequence ${r.list.sequence}，撤銷 ${r.list.revoked.length} 筆 → ${r.listPath}`);
      if (args.send === true) {
        const p = await localProvider(str(args, "rpc"), chainId);
        const tx = await issuer.connect(p).sendTransaction(r.tx);
        await tx.wait();
        console.log(`✓ 鏈上撤銷已送出（本機鏈）：tx ${tx.hash}`);
      } else {
        console.log("鏈上撤銷交易資料（請以發證者錢包／KMS 送出）：");
        console.log(JSON.stringify(r.tx, null, 2));
      }
      return;
    }
    case "verify": {
      const chainId = args["chain-id"] ? Number(args["chain-id"]) : undefined;
      const provider = typeof args.rpc === "string" ? new ethers.JsonRpcProvider(args.rpc, undefined, { staticNetwork: true }) : undefined;
      const r = await runVerify({
        vc: readVc(),
        registry: typeof args.registry === "string" ? args.registry : undefined,
        chainId,
        statusDir: str(args, "dir", DEFAULT_STATUS_DIR),
        statusUrl: typeof args["status-url"] === "string" ? args["status-url"] : undefined,
        statePath: str(args, "state", DEFAULT_STATE_PATH),
        provider,
      });
      console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      if (!r.signature.valid || !r.status?.ok) process.exitCode = 1;
      return;
    }
    case "submit": {
      const p = await localProvider(str(args, "rpc"));
      const r = await runSubmit({ vc: readVc(), submitter: walletFromEnv("SUBMITTER_PRIVATE_KEY").connect(p), provider: p });
      console.log(`✓ attestation 已上鏈：tx ${r.hash}（block ${r.blockNumber}）`);
      return;
    }
    default:
      console.log(HELP);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`✖ ${(e as Error).message}`);
    process.exit(1);
  });
}
