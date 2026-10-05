#!/usr/bin/env node
// besu/scripts/e2e.mjs
// 端到端整合檢查：在真正的 Besu QBFT 網路上送交易（不是 forge 的內建 EVM）。
//
//   部署（由 e2e.sh 先跑 deploy.sh）→ 推價（GBM 3 個 tick）→ LP 存入保險庫
//   → 交易者開 sBTC 5 倍多單 → keeper 跑一輪（部位健康、不應清算）
//   → 推一個下跌價格（入場價 −17%）→ keeper 跑一輪觸發清算
//   → 讀回：部位已關閉且 closeReason = Liquidated、保險庫 totalAssets 與 USDC 餘額增加、
//     keeper 拿到清算獎勵、交易者拿回剩餘保證金
//
// 每一步都斷言；任何一步不符就 exit 1。全部通過 exit 0 並印出關鍵數字。
// 下跌幅度 17% 的理由：5 倍槓桿下，保證金 = 名目的 20%，維持保證金 = 名目的 5%；
// 跌 17% 後剩餘價值 ≈ 名目 × (20% − 17%) − 手續費 ≈ 3%，低於 5% → 可清算，
// 而且仍為正值 → 清算罰金（liquidationPenaltyBps）會流進保險庫，看得到保險庫餘額增加。
// （跌超過 20% 會變成穿倉，改由保險庫 bailout 墊付、餘額反而減少——那是另一條路徑。）

import { parseEther } from 'viem';
import {
  assetId, fmt18, fmtPrice8, loadAbi, loadAccounts, loadDeployment, makeClients, sendTx,
} from './lib.mjs';
import { assertOracleSigner, pushPrices, readPrice, makeSource } from './oracle-pusher.mjs';
import { assertPermitted, keeperTick, newKeeperState } from './keeper.mjs';

const DROP_BPS = BigInt(process.env.E2E_DROP_BPS || '1700'); // 下跌 17%
const MARGIN = parseEther(process.env.E2E_MARGIN || '1000'); // 1,000 USDC（MockUSDC 為 18 位小數）
const LEVERAGE = 5n;
const LP_DEPOSIT = parseEther('20000');
const SBTC = 'sBTC';
const CLOSE_REASON = ['None', 'Owner', 'Agent', 'Liquidated', 'Deleveraged'];

function step(n, text) { console.log(`\n[${n}] ${text}`); }
function check(cond, msg) {
  if (!cond) { console.error(`✖ 斷言失敗：${msg}`); process.exit(1); }
  console.log(`    ✔ ${msg}`);
}

async function main() {
  const accounts = loadAccounts();
  const deployer = await makeClients({ privateKey: accounts.deployer.privateKey });
  const oracleCtx = await makeClients({ privateKey: accounts.oracle.privateKey });
  const keeperCtx = await makeClients({ privateKey: accounts.keeper.privateKey });
  const trader = await makeClients({ privateKey: accounts.trader.privateKey });
  const lp = await makeClients({ privateKey: accounts.lp.privateKey });
  const dep = loadDeployment(deployer.chainId);
  const C = dep.contracts;
  const usdcAbi = loadAbi('MockUSDC');
  const exAbi = loadAbi('PerpetualExchange');
  const vaultAbi = loadAbi('InsuranceVault');
  const pub = deployer.publicClient;
  const exRead = (functionName, args = []) => pub.readContract({ address: C.PerpetualExchange, abi: exAbi, functionName, args });
  const usdcBal = (a) => pub.readContract({ address: C.MockUSDC, abi: usdcAbi, functionName: 'balanceOf', args: [a] });
  const vaultAssets = () => pub.readContract({ address: C.InsuranceVault, abi: vaultAbi, functionName: 'totalAssets' });

  const client = await pub.request({ method: 'web3_clientVersion', params: [] });
  const startBlock = await pub.getBlockNumber();
  console.log(`PepeLab × Besu 端到端檢查｜${client}｜chainId ${deployer.chainId}｜起始 block ${startBlock}`);
  console.log(`  exchange ${C.PerpetualExchange}  vault ${C.InsuranceVault}  oracle ${C.MockOracle}`);

  // ── 1. 推價（授權帳戶，GBM 3 個 tick）─────────────────────────────────────
  step(1, '推價：oracle 帳戶以 GBM（seed=42、σ=0.6）推 3 個 tick 的 sBTC');
  await assertOracleSigner(oracleCtx, C.MockOracle);
  check(true, `簽名帳戶 ${oracleCtx.account.address} 是 MockOracle owner`);
  const start = (await readPrice(oracleCtx, C.MockOracle, SBTC)).price;
  const src = makeSource({ mode: 'gbm', assets: [SBTC], startPrices: { [SBTC]: start }, seed: 42, mu: 0, sigma: 0.6, intervalSeconds: 2 });
  for (let i = 0; i < 3; i++) {
    const [r] = await pushPrices(oracleCtx, C.MockOracle, src());
    console.log(`    tick ${i + 1}: sBTC ${fmtPrice8(r.price8)}（block ${r.block}）`);
  }
  // deployer 已不是 owner：寫價應被拒（角色分離生效）。
  let deployerCanWrite = true;
  try { await pushPrices(deployer, C.MockOracle, [{ symbol: SBTC, price8: start }]); } catch { deployerCanWrite = false; }
  check(!deployerCanWrite, 'deployer 已無權寫價（MockOracle owner 已轉給 oracle 帳戶）');

  // ── 2. 資金準備：mint USDC、LP 存入保險庫 ──────────────────────────────────
  step(2, '資金準備：deployer mint MockUSDC 給 trader／lp；lp 存 20,000 USDC 進保險庫');
  await sendTx(deployer, { address: C.MockUSDC, abi: usdcAbi, functionName: 'mint', args: [trader.account.address, parseEther('10000')] });
  await sendTx(deployer, { address: C.MockUSDC, abi: usdcAbi, functionName: 'mint', args: [lp.account.address, LP_DEPOSIT] });
  await sendTx(lp, { address: C.MockUSDC, abi: usdcAbi, functionName: 'approve', args: [C.InsuranceVault, LP_DEPOSIT] });
  await sendTx(lp, { address: C.InsuranceVault, abi: vaultAbi, functionName: 'deposit', args: [LP_DEPOSIT] });
  const vaultAssets0 = await vaultAssets();
  const vaultUsdc0 = await usdcBal(C.InsuranceVault);
  console.log(`    保險庫 totalAssets = ${fmt18(vaultAssets0)}，USDC 餘額 = ${fmt18(vaultUsdc0)}`);
  check(vaultAssets0 >= LP_DEPOSIT, '保險庫已入金');

  // ── 3. 開倉：sBTC 5 倍多單 ─────────────────────────────────────────────────
  step(3, `開倉：trader 存 2,000 USDC 保證金，開 sBTC 多單 margin=${fmt18(MARGIN)} × ${LEVERAGE}`);
  await sendTx(trader, { address: C.MockUSDC, abi: usdcAbi, functionName: 'approve', args: [C.PerpetualExchange, parseEther('2000')] });
  await sendTx(trader, { address: C.PerpetualExchange, abi: exAbi, functionName: 'depositMargin', args: [parseEther('2000')] });
  const fee = await exRead('executionFee');
  const posId = await exRead('nextPositionId');
  const openRcpt = await sendTx(trader, {
    address: C.PerpetualExchange, abi: exAbi, functionName: 'openPosition',
    args: [assetId(SBTC), true, MARGIN, LEVERAGE], value: fee,
  });
  const pos0 = await exRead('getPosition', [posId]);
  check(pos0.isOpen && pos0.owner.toLowerCase() === trader.account.address.toLowerCase(),
    `部位 #${posId} 已開（block ${openRcpt.blockNumber}），入場價 ${fmt18(pos0.entryPrice)}`);
  const freeMargin0 = await exRead('freeMargin', [trader.account.address]);

  // ── 4. keeper 第一輪：健康部位不清算 ──────────────────────────────────────
  step(4, 'keeper 第一輪（部位健康）');
  const perms = await assertPermitted(keeperCtx);
  check(true, `keeper ${keeperCtx.account.address} 在節點帳戶白名單內（${perms} 個帳戶）`);
  const kState = newKeeperState();
  const r1 = await keeperTick(keeperCtx, dep, kState, { assets: [SBTC] });
  const f1 = r1.funding[0];
  console.log(`    資金費率：sBTC ${f1.status}${f1.waitSeconds !== undefined ? `，距下次可結算 ${f1.waitSeconds}s（FUNDING_INTERVAL）` : ''}`);
  console.log(`    部位價值 ${fmt18(await exRead('getPositionValue', [posId]))}（維持保證金門檻 ${fmt18(MARGIN * LEVERAGE * (await exRead('maintenanceMarginBpsForAsset', [assetId(SBTC)])) / 10000n)}）`);
  check(r1.scanned === 1 && r1.liquidations.length === 0, 'keeper 掃到 1 個未平倉部位，未清算');

  // ── 5. 推下跌價格 ─────────────────────────────────────────────────────────
  const entry8 = pos0.entryPrice / 10n ** 10n;
  const crash8 = (entry8 * (10_000n - DROP_BPS)) / 10_000n;
  step(5, `推下跌價格：sBTC ${fmtPrice8(entry8)} → ${fmtPrice8(crash8)}（−${Number(DROP_BPS) / 100}%）`);
  const [cr] = await pushPrices(oracleCtx, C.MockOracle, [{ symbol: SBTC, price8: crash8 }]);
  console.log(`    block ${cr.block}，部位價值降為 ${fmt18(await exRead('getPositionValue', [posId]))}`);

  // ── 6. keeper 第二輪：清算 ────────────────────────────────────────────────
  step(6, 'keeper 第二輪（觸發清算）');
  const keeperUsdc0 = await usdcBal(keeperCtx.account.address);
  const r2 = await keeperTick(keeperCtx, dep, kState, { assets: [SBTC] });
  const liq = r2.liquidations.find((x) => x.id === posId);
  check(liq?.status === 'liquidated', `keeper 清算部位 #${posId}（tx ${liq?.hash}，block ${liq?.block}，gas ${liq?.gasUsed}）`);

  // ── 7. 讀回鏈上結果 ───────────────────────────────────────────────────────
  step(7, '讀回鏈上狀態');
  const pos1 = await exRead('getPosition', [posId]);
  const reason = Number(await exRead('closeReasonOf', [posId]));
  const vaultAssets1 = await vaultAssets();
  const vaultUsdc1 = await usdcBal(C.InsuranceVault);
  const keeperUsdc1 = await usdcBal(keeperCtx.account.address);
  const freeMargin1 = await exRead('freeMargin', [trader.account.address]);
  check(!pos1.isOpen, `部位 #${posId} isOpen = false`);
  check(CLOSE_REASON[reason] === 'Liquidated', `closeReasonOf = ${CLOSE_REASON[reason]}`);
  check(vaultAssets1 > vaultAssets0, `保險庫 totalAssets ${fmt18(vaultAssets0)} → ${fmt18(vaultAssets1)}（+${fmt18(vaultAssets1 - vaultAssets0)}）`);
  check(vaultUsdc1 > vaultUsdc0, `保險庫 USDC 餘額 ${fmt18(vaultUsdc0)} → ${fmt18(vaultUsdc1)}（+${fmt18(vaultUsdc1 - vaultUsdc0)}）`);
  check(keeperUsdc1 > keeperUsdc0, `keeper 清算獎勵 +${fmt18(keeperUsdc1 - keeperUsdc0)} USDC`);
  console.log(`    已實現損益 ${fmt18(pos1.realizedPnL)}；trader 退回保證金 +${fmt18(freeMargin1 - freeMargin0)}（freeMargin ${fmt18(freeMargin0)} → ${fmt18(freeMargin1)}）`);
  check((await exRead('openPositionCountFor', [assetId(SBTC)])) === 0n, 'sBTC 未平倉索引已清空');

  const endBlock = await pub.getBlockNumber();
  console.log(`\n✔ 端到端檢查通過｜block ${startBlock} → ${endBlock}`);
  console.log(JSON.stringify({
    result: 'PASS',
    client,
    chainId: deployer.chainId,
    positionId: posId.toString(),
    entryPrice: fmt18(pos0.entryPrice),
    crashPrice: fmtPrice8(crash8),
    liquidationTx: liq.hash,
    liquidationBlock: liq.block.toString(),
    realizedPnL: fmt18(pos1.realizedPnL),
    vaultTotalAssets: { before: fmt18(vaultAssets0), after: fmt18(vaultAssets1) },
    vaultUsdcBalance: { before: fmt18(vaultUsdc0), after: fmt18(vaultUsdc1) },
    keeperReward: fmt18(keeperUsdc1 - keeperUsdc0),
    traderRefund: fmt18(freeMargin1 - freeMargin0),
    fundingStatus: f1.status,
  }, null, 2));
}

main().catch((e) => { console.error(`✖ ${e.shortMessage || e.message}`); process.exit(1); });
