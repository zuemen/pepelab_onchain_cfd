#!/usr/bin/env node
// besu/scripts/gen-network.mjs
// 在本機產生 4 驗證者（或 1 個，單節點開發模式）QBFT 網路需要的全部檔案，寫進被 gitignore 的 besu/network/：
//
//   network/accounts.json          本機開發帳戶（deployer／oracle／keeper／trader／lp）的位址與私鑰
//   network/qbftConfigFile.json    餵給 `besu operator generate-blockchain-config` 的設定（不含私鑰）
//   network/genesis.json           由 Besu 官方工具產生（含 QBFT extraData 的 RLP）
//   network/node{1..N}/key, key.pub 驗證者節點金鑰（N = BESU_VALIDATORS，預設 4；由 Besu 官方工具產生）
//   network/static-nodes.json      4 個節點的 enode（固定 IP，關閉 discovery）
//   network/node{1..N}/permissions_config.toml 帳戶白名單（只有這些帳戶能送交易；每節點一份）
//
// 用法：
//   node scripts/gen-network.mjs           # network/ 已存在就拒絕（避免誤蓋金鑰）
//   node scripts/gen-network.mjs --force   # 先刪掉舊的 network/ 再重產（舊鏈資料也要 down -v）
//
// 可調參數（besu/.env 或環境變數；環境變數優先）：
//   BESU_IMAGE            預設 hyperledger/besu:26.9.0@sha256:fc1813d6…（tag＋digest 雙重釘選）
//   BESU_CHAIN_ID         預設 1337
//   BESU_BLOCK_PERIOD     QBFT blockperiodseconds，預設 2
//   BESU_REQUEST_TIMEOUT  QBFT requesttimeoutseconds，預設 = 2 × BLOCK_PERIOD
//   BESU_EPOCH_LENGTH     QBFT epochlength，預設 30000
//   BESU_GAS_LIMIT        genesis gasLimit（十進位），預設 1000000000
//   BESU_SUBNET_PREFIX    docker 網段前三碼，預設 10.233.66（節點 IP 為 .11–.14）
//   BESU_VALIDATORS       驗證者數量：4（預設，可容忍 1 個故障）或 1（低記憶體單節點開發模式，
//                         只啟動 node1：docker compose -p pepelab-besu -f besu/docker-compose.yml up -d node1；沒有拜占庭容錯）
//
// 私鑰只在本機產生：帳戶私鑰用 viem 的 generatePrivateKey（底層為 CSPRNG），
// 節點金鑰由 Besu 自己產生。genesis 的 alloc 只放位址與餘額，不放 privateKey
// （官方教學範例把 privateKey 寫進 alloc，這裡刻意不這樣做）。

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BESU_DIR, NETWORK_DIR, rejectPublicChainIdForGenesis } from './lib.mjs';

// ── 設定 ──────────────────────────────────────────────────────────────────────
/** 讀 besu/.env（簡單的 KEY=VALUE；docker compose -f besu/docker-compose.yml 也會自動讀同一個檔）。 */
function loadDotEnv() {
  const p = join(BESU_DIR, '.env');
  const out = {};
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const dotenv = loadDotEnv();
const cfg = (k, d) => process.env[k] ?? dotenv[k] ?? d;

const IMAGE = cfg('BESU_IMAGE', 'hyperledger/besu:26.9.0@sha256:fc1813d67d630d7660eea6ee555c01e73bfecda3e54d24f9484c1c4a52c6fcb0');
const CHAIN_ID = Number(cfg('BESU_CHAIN_ID', '1337'));
const BLOCK_PERIOD = Number(cfg('BESU_BLOCK_PERIOD', '2'));
const REQUEST_TIMEOUT = Number(cfg('BESU_REQUEST_TIMEOUT', String(BLOCK_PERIOD * 2)));
const EPOCH = Number(cfg('BESU_EPOCH_LENGTH', '30000'));
const GAS_LIMIT = BigInt(cfg('BESU_GAS_LIMIT', '1000000000'));
const SUBNET_PREFIX = cfg('BESU_SUBNET_PREFIX', '10.233.66');
const VALIDATORS = Number(cfg('BESU_VALIDATORS', '4'));
const FORCE = process.argv.includes('--force');
if (VALIDATORS !== 1 && VALIDATORS !== 4) {
  // compose 檔定義了 node1–node4；1 個是單節點開發模式，4 個是 QBFT 最少的拜占庭容錯配置。
  throw new Error(`BESU_VALIDATORS 只能是 1 或 4，收到 ${VALIDATORS}`);
}

for (const [k, v] of Object.entries({ CHAIN_ID, BLOCK_PERIOD, REQUEST_TIMEOUT, EPOCH })) {
  if (!Number.isInteger(v) || v <= 0) throw new Error(`${k} 必須是正整數，收到 ${v}`);
}
if (REQUEST_TIMEOUT <= BLOCK_PERIOD) {
  // 官方建議 round-change 逾時大於出塊間隔，否則每一輪都可能在出塊前就換輪。
  throw new Error(`BESU_REQUEST_TIMEOUT（${REQUEST_TIMEOUT}）必須大於 BESU_BLOCK_PERIOD（${BLOCK_PERIOD}）`);
}
rejectPublicChainIdForGenesis(CHAIN_ID);

// ── 前置檢查 ──────────────────────────────────────────────────────────────────
if (existsSync(NETWORK_DIR)) {
  if (!FORCE) {
    console.error(`✖ ${NETWORK_DIR} 已存在。要重產請加 --force（會換掉所有節點與帳戶金鑰；`
      + '舊鏈資料請同時執行 `docker compose -p pepelab-besu -f besu/docker-compose.yml down -v`）。');
    process.exit(1);
  }
  rmSync(NETWORK_DIR, { recursive: true, force: true });
}
mkdirSync(NETWORK_DIR, { recursive: true });

// ── 1. 本機開發帳戶 ───────────────────────────────────────────────────────────
// 角色分離：deployer 部署並持有各合約 owner；oracle 只負責寫價（部署後 MockOracle 的
// owner 轉給它）；keeper 只做資金費率結算與清算；trader／lp 是端到端腳本的使用者。
const ROLES = ['deployer', 'oracle', 'keeper', 'trader', 'lp'];
const accounts = {};
for (const role of ROLES) {
  const privateKey = generatePrivateKey();
  accounts[role] = { address: privateKeyToAccount(privateKey).address, privateKey };
}
writeFileSync(
  join(NETWORK_DIR, 'accounts.json'),
  `${JSON.stringify({
    _warning: '本機開發金鑰，只用於本地 Besu。此檔被 gitignore，勿複製到任何公開鏈或 repo。',
    chainId: CHAIN_ID,
    ...accounts,
  }, null, 2)}\n`,
  { mode: 0o600 },
);

// ── 2. generate-blockchain-config 的設定檔 ───────────────────────────────────
// mixHash 是 BFT 共識規定的固定值（官方範例：ASCII「ctical byzantine fault tolerance」），
// 用字串產生，避免在原始碼裡放一串看起來像私鑰的 64 位十六進位字。
const BFT_MIX_HASH = `0x${Buffer.from('ctical byzantine fault tolerance', 'ascii').toString('hex')}`;
const FUND = 10n ** 24n; // 每個帳戶 1,000,000 ETH（免費 gas 網路其實用不到，但 executionFee 要付 ETH）

const genesis = {
  config: {
    chainId: CHAIN_ID,
    // EVM 硬分叉：全部在創世啟用，直到 Osaka——repo 的 forge 預設 evm_version 是 osaka
    // （solc 0.8.36 的預設），所以節點必須支援到 Osaka 的指令集。
    berlinBlock: 0,
    londonBlock: 0,
    shanghaiTime: 0,
    cancunTime: 0,
    pragueTime: 0,
    osakaTime: 0,
    // 免費 gas：London 之後 baseFee 不再是 0，必須明確開 zeroBaseFee（官方 free-gas 文件）。
    zeroBaseFee: true,
    // 與以太坊主網／Base 相同的 EIP-170 上限（24,576 B），讓本地網路擋下跟正式鏈一樣的超限合約。
    // 官方 free-gas 文件示範把它開到最大；這裡刻意不開，PerpetualExchange 的大小門檻才有意義。
    contractSizeLimit: 24576,
    qbft: {
      blockperiodseconds: BLOCK_PERIOD,
      epochlength: EPOCH,
      requesttimeoutseconds: REQUEST_TIMEOUT,
    },
  },
  nonce: '0x0',
  timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
  gasLimit: `0x${GAS_LIMIT.toString(16)}`,
  difficulty: '0x1',
  mixHash: BFT_MIX_HASH,
  coinbase: '0x0000000000000000000000000000000000000000',
  alloc: Object.fromEntries(
    Object.values(accounts).map((a) => [a.address.toLowerCase().slice(2), { balance: `0x${FUND.toString(16)}` }]),
  ),
};

const configFile = { genesis, blockchain: { nodes: { generate: true, count: VALIDATORS } } };
writeFileSync(join(NETWORK_DIR, 'qbftConfigFile.json'), `${JSON.stringify(configFile, null, 2)}\n`);

// ── 3. 用 Besu 官方工具產生 genesis（含 extraData）與節點金鑰 ─────────────────
// --entrypoint 直接指到 besu 執行檔：映像檔預設的 besu-entry.sh 以 root 執行時，會先用
// `--print-paths-and-exit` 把同一組參數跑一次（為了 chown），對 operator 子指令來說等於
// 產生兩次——第一次成功、第二次因為輸出目錄已存在而 exit 1（26.9.0 實測）。
const dockerArgs = ['run', '--rm', '--entrypoint', '/opt/besu/bin/besu', '-v', `${NETWORK_DIR}:/work`];
if (process.platform !== 'win32' && typeof process.getuid === 'function') {
  // Linux：讓產出的檔案屬於目前使用者，而不是 root。
  dockerArgs.push('--user', `${process.getuid()}:${process.getgid()}`);
}
dockerArgs.push(
  IMAGE,
  'operator', 'generate-blockchain-config',
  '--config-file=/work/qbftConfigFile.json',
  '--to=/work/generated',
  '--private-key-file-name=key',
);
console.log(`▶ docker ${dockerArgs.join(' ')}`);
const r = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`✖ besu operator generate-blockchain-config 失敗（exit ${r.status}）`);
  process.exit(r.status ?? 1);
}

const genDir = join(NETWORK_DIR, 'generated');
renameSync(join(genDir, 'genesis.json'), join(NETWORK_DIR, 'genesis.json'));
const keyDirs = readdirSync(join(genDir, 'keys')).sort(); // 依驗證者位址排序，與 extraData 的順序一致
if (keyDirs.length !== VALIDATORS) throw new Error(`預期 ${VALIDATORS} 把節點金鑰，實際 ${keyDirs.length}`);

const enodes = [];
const validators = [];
keyDirs.forEach((addr, i) => {
  const n = i + 1;
  const nodeDir = join(NETWORK_DIR, `node${n}`);
  mkdirSync(nodeDir, { recursive: true });
  for (const f of ['key', 'key.pub']) copyFileSync(join(genDir, 'keys', addr, f), join(nodeDir, f));
  const pub = readFileSync(join(nodeDir, 'key.pub'), 'utf8').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{128}$/.test(pub)) throw new Error(`node${n} 的 key.pub 格式不符：${pub.slice(0, 16)}…`);
  enodes.push(`enode://${pub}@${SUBNET_PREFIX}.${10 + n}:30303`);
  validators.push(addr);
});
rmSync(genDir, { recursive: true, force: true });

// ── 4. static-nodes 與帳戶白名單 ─────────────────────────────────────────────
writeFileSync(join(NETWORK_DIR, 'static-nodes.json'), `${JSON.stringify(enodes, null, 2)}\n`);
// 帳戶白名單：只有本機產生的 5 個角色帳戶能送交易（JSON-RPC 提交、P2P 收到、打包進區塊三處都檢查）。
const allowlist = Object.values(accounts).map((a) => `"${a.address.toLowerCase()}"`).join(', ');
// 每個節點各一份：Besu 啟動時會回寫這個檔，必須放在節點自己可寫的目錄（compose 掛成 /besu-node）。
for (let n = 1; n <= VALIDATORS; n++) {
  writeFileSync(join(NETWORK_DIR, `node${n}`, 'permissions_config.toml'), `accounts-allowlist=[${allowlist}]\n`);
}

// ── 5. 摘要（不印私鑰）────────────────────────────────────────────────────────
console.log('\n✔ 本地 QBFT 網路已產生於 besu/network/（已被 gitignore）');
console.log(`  chainId              ${CHAIN_ID}`);
console.log(`  blockperiodseconds   ${BLOCK_PERIOD}`);
console.log(`  requesttimeoutseconds ${REQUEST_TIMEOUT}`);
console.log(`  epochlength          ${EPOCH}`);
console.log(`  gasLimit             ${GAS_LIMIT}`);
console.log(`  驗證者（${VALIDATORS}）          ${validators.join(', ')}`);
for (const role of ROLES) console.log(`  ${role.padEnd(20)} ${accounts[role].address}`);
console.log(VALIDATORS === 1
  ? '\n下一步（單節點模式，在 repo 根目錄）：docker compose -p pepelab-besu -f besu/docker-compose.yml up -d node1'
  : '\n下一步（在 repo 根目錄）：docker compose -p pepelab-besu -f besu/docker-compose.yml up -d');
