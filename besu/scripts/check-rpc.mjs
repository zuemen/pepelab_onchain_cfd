#!/usr/bin/env node
// besu/scripts/check-rpc.mjs
// 給 shell 腳本（deploy.sh、fork-test.sh）用的連線守門：與 Node 腳本共用 lib.mjs 的白名單
// （chainId 必須等於 network/accounts.json、web3_clientVersion 必須以 besu/ 開頭）。
// 通過：stdout 印一行 `<chainId> <clientVersion>`，exit 0。不通過或連不上：stderr 說明原因，exit 1。
// RPC 位址：BESU_RPC_URL（預設 http://127.0.0.1:8545）。
import { makeClients } from './lib.mjs';

try {
  const { chainId, publicClient } = await makeClients();
  const clientVersion = await publicClient.request({ method: 'web3_clientVersion', params: [] });
  console.log(`${chainId} ${clientVersion}`);
} catch (e) {
  console.error(`✖ ${e.shortMessage || e.message}`);
  console.error('  （節點沒啟動？請見 besu/README.md「從零到跑起來」。）');
  process.exit(1);
}
