#!/usr/bin/env node
/**
 * Closes every open position on the OLD PerpetualExchange so the #102 cutover
 * can get past deploy-102.sh Stage 4.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Stage 4 of the wizard runs Redeploy102Exchange's _survey() and dies unless the
 * old exchange reports zero open positions. It reported 68. Stage 3 broadcasts
 * BEFORE that gate, so running the wizard without clearing first spends gas on
 * ESGRegistryV2 + SustainabilityBadge and then stops with a half-finished
 * cutover.
 *
 * WHY IT HAS TO BE PER-OWNER
 * --------------------------
 * PerpetualExchange._closePosition reverts NotPositionOwner unless
 * msg.sender == pos.owner. Checked against the deployed source, there is no
 * admin path around it:
 *   - closePositionFor() requires authorizedAgents[msg.sender] AND
 *     positionAgent[id] == msg.sender, so the new owner cannot use it.
 *   - liquidatePosition() requires the position to be under maintenance margin,
 *     so healthy positions are not liquidatable.
 * So each owner's own key must sign. This script takes those keys from the
 * environment and never prints them.
 *
 * ORACLE FRESHNESS
 * ----------------
 * _closePosition calls _requireFresh(pos.asset). If the keeper has not posted
 * recently the close reverts on price staleness, not on anything this script
 * did. Run the keeper first, or expect StalePrice failures.
 *
 * EIP-7702 / SEQUENTIAL NONCES
 * ----------------------------
 * 0xE80A…Eb93 (the leaked deployer, holder of most of these positions) is
 * delegated to a sweeper contract. Base rejects gapped nonces from delegated
 * accounts — the key rotation hit exactly this and had to add --slow. So every
 * send here waits for its receipt before the next one. Do not parallelise.
 *
 * USAGE
 *   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
 *   export SEED_MNEMONIC="…"        # derives the 12 demo traders (index 1..12)
 *   export OLD_DEPLOYER_PK=0x…      # optional: the leaked key, for its own positions
 *   node scripts/close-old-positions.mjs             # survey only, sends nothing
 *   node scripts/close-old-positions.mjs --execute   # actually close
 */
// ethers lives in frontend/node_modules, and ESM resolves from this file's own
// directory rather than the cwd — so resolve it explicitly instead of requiring
// the caller to run this from inside frontend/.
import { createRequire } from 'node:module';
const { ethers } = createRequire(new URL('../frontend/package.json', import.meta.url))('ethers');

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const OLD_EXCHANGE = '0xEf75ECA6514cE96B18382E921aC6190a0cF8c072';
const EXECUTE = process.argv.includes('--execute');

const ABI = [
  'function nextPositionId() view returns (uint256)',
  'function positions(uint256) view returns (uint256 id,address owner,bytes32 asset,bool isLong,uint256 entryPrice,uint256 margin,uint256 leverage,uint256 openedAt,uint256 closedAt,int256 realizedPnL,bool isOpen,address copiedFrom,int256 entryFundingIndex)',
  'function closePosition(uint256)',
];

const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== 84532n) throw new Error(`RPC 指向 chain ${net.chainId}，不是 Base Sepolia (84532)`);
  const ex = new ethers.Contract(OLD_EXCHANGE, ABI, provider);

  // ── Build the signer set from whatever keys the environment supplies ──────
  const signers = new Map(); // lowercase address -> Wallet
  const addKey = (pk, label) => {
    try {
      const w = new ethers.Wallet(pk, provider);
      signers.set(w.address.toLowerCase(), w);
      return `${label}: ${w.address}`;
    } catch { return `${label}: 金鑰格式不對，略過`; }
  };

  console.log('可用金鑰：');
  if (process.env.OLD_DEPLOYER_PK) console.log('  ' + addKey(process.env.OLD_DEPLOYER_PK, '舊 deployer'));
  else console.log('  舊 deployer: 未提供 OLD_DEPLOYER_PK');

  // Derive a generous index range, not just 1..12.
  //
  // SeedWhales.s.sol uses vm.deriveKey(mnemonic, i + 1), so 1..12 is the range
  // the current script produces. But the old exchange holds positions from
  // earlier runs too, and one owner (0x858b36…0ba972) sits outside that window
  // — a narrow range silently reports "no key" for an account the mnemonic
  // actually controls. Deriving 0..24 is free and covers re-runs that used a
  // different offset.
  const deriveInto = (phrase, label) => {
    let n = 0;
    for (let i = 0; i <= 24; i++) {
      try {
        const w = ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`);
        signers.set(w.address.toLowerCase(), new ethers.Wallet(w.privateKey, provider));
        n++;
      } catch { /* bad phrase — reported by the caller */ }
    }
    console.log(`  ${label}: 衍生 ${n} 個 (index 0..24)`);
  };

  if (process.env.SEED_MNEMONIC) deriveInto(process.env.SEED_MNEMONIC, 'demo 交易者 (SEED_MNEMONIC)');
  else console.log('  demo 交易者: 未提供 SEED_MNEMONIC');

  // Anvil's default phrase is published in Foundry's own docs, so this is not a
  // secret being embedded. SeedWhales originally derived its traders from it —
  // that is the bug KEY_ROTATION_20260807.md describes — and positions opened
  // during those runs are still owned by those accounts. 0x709979…dc79c8 is
  // Anvil index 1, confirmed by derivation.
  deriveInto('test test test test test test test test test test test junk', 'Anvil 預設帳號');

  // ── Survey ────────────────────────────────────────────────────────────────
  const next = Number(await ex.nextPositionId());
  const open = [];
  for (let i = 0; i < next; i++) {
    const p = await ex.positions(i);
    if (p.isOpen) open.push({ id: i, owner: p.owner });
  }

  const byOwner = new Map();
  for (const p of open) {
    const k = p.owner.toLowerCase();
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(p.id);
  }

  console.log(`\n未平倉 ${open.length} 個，分屬 ${byOwner.size} 個地址：`);
  let coverable = 0, orphan = 0;
  for (const [owner, ids] of byOwner) {
    const have = signers.has(owner);
    if (have) coverable += ids.length; else orphan += ids.length;
    console.log(`  ${have ? '✓' : '✗'} ${short(owner)}  ${String(ids.length).padStart(2)} 個  ${have ? '' : '← 沒有這把金鑰'}`);
  }
  console.log(`\n可平: ${coverable}    缺金鑰: ${orphan}`);

  if (orphan > 0) console.log('⚠ 缺金鑰的那些平不掉，Stage 4 仍會擋。先補齊金鑰再跑。');
  if (!EXECUTE) { console.log('\n(這是預演，什麼都沒送。加 --execute 才會真的平倉)'); return; }
  if (coverable === 0) { console.log('沒有可平的部位，結束。'); return; }

  // ── Close, strictly sequentially ─────────────────────────────────────────
  let ok = 0, fail = 0;
  for (const [owner, ids] of byOwner) {
    const w = signers.get(owner);
    if (!w) continue;
    const c = new ethers.Contract(OLD_EXCHANGE, ABI, w);
    const bal = await provider.getBalance(owner);
    console.log(`\n${short(owner)} — ${ids.length} 個，gas 餘額 ${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) { console.log('  餘額 0，送不出交易 —— 略過'); fail += ids.length; continue; }

    for (const id of ids) {
      try {
        // await the receipt before the next send: gapped nonces are rejected
        // for 7702-delegated accounts (see header).
        const tx = await c.closePosition(id);
        await tx.wait();
        console.log(`  ✓ #${id} 已平倉  ${tx.hash}`);
        ok++;
      } catch (e) {
        const m = (e.shortMessage || e.message || '').slice(0, 110);
        console.log(`  ✗ #${id} 失敗: ${m}`);
        fail++;
      }
    }
  }
  console.log(`\n完成：平掉 ${ok}，失敗 ${fail}`);
  console.log('再跑一次本腳本(不加 --execute)確認歸零，然後才跑 deploy-102.sh。');
}

main().catch((e) => { console.error('錯誤：' + e.message); process.exit(1); });
