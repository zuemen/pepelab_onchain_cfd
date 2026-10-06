// RWA × SSI 准入 PoC 的鏈上步驟（由 scripts/poc/rwa-ssi-demo.sh 呼叫，只對本機 anvil）。
// 每一步印中文說明與交易 hash，適合螢幕錄影。發證、撤銷、驗證都走 issuer/cli.ts 的同一套函式。
//
//   npx tsx issuer/poc.ts --rpc http://127.0.0.1:8547 --exchange 0x… --registry 0x… --usdc 0x… --out <dir>
// 金鑰：ISSUER_PRIVATE_KEY、INVESTOR_PRIVATE_KEY（anvil 公開的開發帳戶，只在本機鏈有意義）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { localProvider, parseArgs, runInit, runIssue, runRevoke, runSubmit, runVerify } from "./cli.ts";
import { CREDENTIAL_TYPE_IDS, VC_KYC_REGISTRY_ABI, decodeRevert } from "./investorVc.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { args } = parseArgs(["poc", ...process.argv.slice(2)]);
const need = (k: string) => {
  const v = args[k];
  if (typeof v !== "string") throw new Error(`缺少 --${k}`);
  return v;
};

const SAAPL = ethers.id("sAAPL");
const OUT = path.resolve(need("out"));
const C = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", dim: "\x1b[2m" };
let stepNo = 0;
const step = (title: string) => console.log(`\n${C.bold}${C.cyan}【步驟 ${++stepNo}】${title}${C.reset}`);
const good = (m: string) => console.log(`  ${C.green}✔${C.reset} ${m}`);
const fail = (m: string) => console.log(`  ${C.red}✘${C.reset} ${m}`);
const info = (m: string) => console.log(`  ${C.dim}${m}${C.reset}`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function exchangeAbi(): ethers.InterfaceAbi {
  const art = path.join(HERE, "..", "..", "contracts", "out", "PerpetualExchange.sol", "PerpetualExchange.json");
  return JSON.parse(fs.readFileSync(art, "utf8")).abi;
}

/** 先 staticCall 取得 revert 原因；再以固定 gasLimit 送出，讓失敗交易也上鏈、有 hash 可對照。 */
async function expectRejectedOpen(exchange: ethers.Contract, fee: bigint): Promise<void> {
  let reason = "（未取得原因）";
  try {
    await exchange.openPosition.staticCall(SAAPL, true, ethers.parseUnits("50", 18), 2, { value: fee });
    fail("預期被拒，但 staticCall 成功了");
    process.exitCode = 1;
    return;
  } catch (e) {
    reason = decodeRevert((e as { data?: string }).data) ?? (e as Error).message;
  }
  try {
    const tx = await exchange.openPosition(SAAPL, true, ethers.parseUnits("50", 18), 2, { value: fee, gasLimit: 1_500_000 });
    await tx.wait();
    fail(`預期被拒，但交易成功：${tx.hash}`);
    process.exitCode = 1;
  } catch (e) {
    const receipt = (e as { receipt?: { hash: string; status: number } }).receipt;
    good(`開倉被拒，revert 原因：${C.red}${reason}${C.reset}`);
    if (receipt) info(`失敗交易 tx ${receipt.hash}（status ${receipt.status}）`);
  }
}

async function main() {
  const rpc = need("rpc");
  const provider = await localProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  const issuer = new ethers.Wallet(process.env.ISSUER_PRIVATE_KEY ?? "", provider);
  const investor = new ethers.Wallet(process.env.INVESTOR_PRIVATE_KEY ?? "", provider);
  const exchange = new ethers.Contract(need("exchange"), exchangeAbi(), investor);
  const registryAddr = ethers.getAddress(need("registry"));
  const registry = new ethers.Contract(registryAddr, VC_KYC_REGISTRY_ABI as unknown as string[], provider);
  const usdc = new ethers.Contract(
    need("usdc"),
    ["function faucet()", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    investor,
  );
  const statusDir = path.join(OUT, "status");
  const statePath = path.join(OUT, "status-state.json");
  const dbPath = path.join(OUT, "issuer-db.json");
  runInit(statusDir);

  console.log(`${C.bold}PepeLab：可驗證憑證（VC）准入的 RWA 市場 — 本機 anvil PoC${C.reset}`);
  info(`chainId ${chainId}｜PerpetualExchange ${exchange.target}｜VCKycRegistry ${registryAddr}`);
  info(`發證者（持牌機構 KYC 單位）${issuer.address}｜投資人 ${investor.address}`);
  info(`exchange.kyc() = ${await exchange.kyc()}｜sAAPL 是 RWA 市場：${await exchange.rwaAsset(SAAPL)}`);
  info(`registry 要求的類型：${(await registry.requiredType()) === CREDENTIAL_TYPE_IDS.QUALIFIED_INVESTOR ? "QUALIFIED_INVESTOR（合格投資人）" : "其他"}`);

  step("投資人領測試 USDC、存入保證金（這一步與身分無關）");
  let tx = await usdc.faucet();
  await tx.wait();
  good(`faucet 領 1,000 USDC：tx ${tx.hash}`);
  tx = await usdc.approve(exchange.target, ethers.MaxUint256);
  await tx.wait();
  good(`approve：tx ${tx.hash}`);
  tx = await exchange.depositMargin(ethers.parseUnits("200", 18));
  await tx.wait();
  good(`depositMargin 200 USDC：tx ${tx.hash}`);
  const fee: bigint = await exchange.executionFee();

  step("沒有合格投資人憑證，嘗試開 sAAPL（RWA）多單");
  info(`registry.isVerified(投資人) = ${await registry.isVerified(investor.address)}`);
  await expectRejectedOpen(exchange, fee);

  step("發證者在鏈下完成審查，簽發「合格投資人」VC（W3C VC 2.0，EIP-712 簽章）");
  const nonce: bigint = await registry.nonces(investor.address);
  const vc = await runIssue({ issuer, subject: investor.address, registry: registryAddr, chainId, nonce, dbPath });
  const vcPath = path.join(OUT, "qualified-investor-vc.json");
  fs.writeFileSync(vcPath, JSON.stringify(vc, null, 2));
  good(`VC 已簽發 → ${vcPath}`);
  info(`id ${vc.id}`);
  info(`credentialHash（鏈上撤銷鍵）${vc.proof.attestation.credentialHash}`);
  info(`有效期 ${vc.validFrom} → ${vc.validUntil}｜狀態清單索引 ${vc.credentialStatus.statusListIndex}`);
  info("VC 內容只有：發證者與投資人的 did:pkh、類型、效期、狀態清單指標——沒有姓名、證號、財力資料");
  let v = await runVerify({ vc, registry: registryAddr, chainId, statusDir, statePath, provider });
  good(`投資人端本地驗證：簽章 ${v.signature.valid ? "有效" : "無效"}、狀態 ${v.status?.status}（${v.status?.reasonCode}）、發證者鏈上受信任 ${v.onchain?.issuerTrusted}`);

  step("投資人把 attestation 送上鏈（合約在鏈上驗 EIP-712 簽章）");
  const sub = await runSubmit({ vc, submitter: investor, provider });
  good(`submitAttestation：tx ${sub.hash}（block ${sub.blockNumber}）`);
  const [rec, valid] = await registry.credentialOf(investor.address, CREDENTIAL_TYPE_IDS.QUALIFIED_INVESTOR);
  good(`isVerified = ${await registry.isVerified(investor.address)}｜資格有效 ${valid}｜到期 ${new Date(Number(rec.expiresAt) * 1000).toISOString()}`);
  info(`鏈上紀錄：issuer ${rec.issuer}、credentialHash ${short(rec.credentialHash)}（只有雜湊與時間）`);

  step("持證後再開 sAAPL 多單");
  tx = await exchange.openPosition(SAAPL, true, ethers.parseUnits("50", 18), 2, { value: fee });
  const rc = await tx.wait();
  let positionId = 0n;
  for (const log of rc!.logs) {
    try {
      const p = exchange.interface.parseLog(log);
      if (p?.name === "PositionOpened") positionId = p.args[0] as bigint;
    } catch {
      /* 其他合約的 log */
    }
  }
  good(`開倉成功：positionId ${positionId}｜tx ${tx.hash}`);

  step("發證者撤銷這張 VC：更新鏈下狀態清單（ADR-016 格式）＋同步送鏈上撤銷");
  const r = await runRevoke({ issuer, credentialHash: vc.proof.attestation.credentialHash, registry: registryAddr, chainId, statusDir });
  good(`狀態清單 sequence ${r.list.sequence}，撤銷 ${r.list.revoked.length} 筆 → ${r.listPath}`);
  tx = await issuer.sendTransaction(r.tx);
  await tx.wait();
  good(`鏈上 revoke(credentialHash)：tx ${tx.hash}`);
  v = await runVerify({ vc, registry: registryAddr, chainId, statusDir, statePath, provider });
  good(`再驗一次：鏈下狀態 ${v.status?.status}（${v.status?.reasonCode}）｜鏈上已撤銷 ${v.onchain?.revokedOnChain}｜isVerified ${await registry.isVerified(investor.address)}`);

  step("撤銷後再開新倉");
  await expectRejectedOpen(exchange, fee);

  step("撤銷後平倉既有部位（閘門只在開倉，撤銷不會把人鎖在部位裡）");
  tx = await exchange.closePosition(positionId);
  await tx.wait();
  const pos = await exchange.getPosition(positionId);
  good(`平倉成功：tx ${tx.hash}｜部位仍開著？${pos.isOpen}`);

  console.log(`\n${C.bold}${C.green}PoC 完成${C.reset}：未持證被拒 → 提交 VC attestation 後可開 → 撤銷後新倉被拒、舊倉可平。`);
}

main().catch((e) => {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
});
