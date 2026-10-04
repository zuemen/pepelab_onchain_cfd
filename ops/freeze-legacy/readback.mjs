#!/usr/bin/env node
// 獨立讀回（唯讀，不需要任何金鑰）：對 inventory-2026-10-03.json 裡該鏈「每一顆有 code 的合約」
// ——不只凍結計畫內的那幾十顆——重查外洩地址是否仍持有任何權限。
//
// 和 FreezeLegacyDeployments.s.sol 的 verify() 互補：verify() 只看計畫內的項目；這支看整份盤點，
// 用來抓「計畫漏列」。不依賴任何套件，只用 Node 內建 fetch。
//
//   node ops/freeze-legacy/readback.mjs sepolia      <RPC_URL>
//   node ops/freeze-legacy/readback.mjs base-sepolia <RPC_URL>
//
// 結束碼：0 = 外洩地址在整份盤點上已無任何 owner／角色（且設了 LOGS_RPC 時沒有計畫外的授權）；
//         1 = 仍持有或有計畫外授權（逐項列出）；2 = 用法或 RPC 錯誤。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const inv = JSON.parse(readFileSync(join(here, "inventory-2026-10-03.json"), "utf8"));
const LEAK = inv.leaked.toLowerCase();
const leakWord = LEAK.slice(2).padStart(64, "0");

const [, , chainArg, url] = process.argv;
const chainKey = { sepolia: "sepolia", "base-sepolia": "base" }[chainArg];
if (!chainKey || !url) {
  console.error("用法：node ops/freeze-legacy/readback.mjs <sepolia|base-sepolia> <RPC_URL>");
  process.exit(2);
}
const chain = inv.chains[chainKey];

// 角色雜湊：合約原始碼的常數（contracts/src/**）＋ ops/monitoring/monitors.json 的 roleNames，
// 再加幾個常見名稱以防舊版合約用過。keccak256("<NAME>")，以 `cast keccak` 產生。
const ROLES = {
  DEFAULT_ADMIN_ROLE: "0".repeat(64),
  ATTESTOR_ROLE: "a7e0cd0f2772b23ee4c329892293a6bd99d48c306b094d6d008c9a8bb8b731e4",
  GUARDIAN_ROLE: "55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041",
  KEEPER_ROLE: "fc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab",
  MINTER_ROLE: "9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6",
  PAUSER_ROLE: "65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a",
  RISK_ROLE: "bb4cf8e50e81e9742807782b2bc5c27c5a943f214ee0b993943eff5a774e555b",
  UPGRADER_ROLE: "189ab7a9244df0848122154315af71fe140f3db0fe014031783b0946b8c9d2e3",
  ADMIN_ROLE: "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775",
  OPERATOR_ROLE: "97667070c54ef182b0f5858b034beac1b6f3089aa2d3188bb1e8929f4fa9b929",
  VERIFIER_ROLE: "0ce23c3e399818cfee81a7ab0880f714e53d7672b08df0fa62f2843416e1ea09",
  BURNER_ROLE: "3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848",
};
const SEL = {
  owner: "0x8da5cb5b",
  pendingOwner: "0xe30c3978",
  guardian: "0x452a9320",
  marketOperator: "0xb1ae3471",
  authorizedAgents: "0xefd76065",
  verifiers: "0x6c824487",
  hasRole: "0x91d14854",
  platformTreasury: "0xe138818c",
};

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const j = await r.json();
      if (j.error) {
        if (/limit|rate|429/i.test(JSON.stringify(j.error))) { await new Promise((s) => setTimeout(s, 1500)); continue; }
        return { error: j.error };
      }
      return { result: j.result };
    } catch (e) {
      if (attempt === 4) return { error: { message: String(e && e.message || e) } };
      await new Promise((s) => setTimeout(s, 1500));
    }
  }
  return { error: { message: "rate limited after retries" } };
}
// M5：區分「函式不存在（execution reverted，code 3）」與「RPC 真的壞了」。
// 前者回傳 undefined（這顆合約沒有這個 getter）；後者絕不可當成「沒有權限」，一律 exit 2。
let okCalls = 0;
function dieRpc(what, err) {
  console.error(`RPC 錯誤（${what}）：${JSON.stringify(err)} — 無法判定權限，請換節點重跑。`);
  process.exit(2);
}
// L6：「函式不存在」判斷要嚴格。只認兩種：
//   (1) JSON-RPC code 3，且 data 為空（0x 或缺）——真正的 empty-revert（沒有這個 selector）；
//   (2) ethers 風格 CALL_EXCEPTION 且 data === "0x"。
// 其他一律視為 RPC 故障（公共節點的 eth_call gas 上限會回「out of gas」、訊息含 revert 的雜訊等），exit 2。
const isNoSuchFunction = (err) => {
  if (err && err.code === 3) {
    const d = err.data;
    return d == null || d === "0x" || d === "";
  }
  if (err && (err.code === "CALL_EXCEPTION") && (err.data === "0x" || err.data == null)) return true;
  return false;
};
const call = async (to, data) => {
  const { result, error } = await rpc("eth_call", [{ to, data }, "latest"]);
  if (error) {
    if (isNoSuchFunction(error)) return undefined;   // 合約沒有這個函式
    dieRpc(`eth_call ${to} ${data.slice(0, 10)}`, error);
  }
  okCalls++;
  return result;
};
const isLeakAddr = (ret) => typeof ret === "string" && ret.length === 66 && ret.slice(26).toLowerCase() === LEAK.slice(2);
const isTrue = (ret) => typeof ret === "string" && ret.length === 66 && BigInt(ret) === 1n;

const chainId = Number((await rpc("eth_chainId", [])).result);
if (chainId !== chain.chainId) {
  console.error(`RPC 的 chainId ${chainId} 與 ${chainArg}（${chain.chainId}）不符`);
  process.exit(2);
}

const held = [];
const treasury = [];
for (const c of chain.contracts) {
  const a = c.address;
  const hits = [];
  for (const g of ["owner", "pendingOwner", "guardian", "marketOperator"]) if (isLeakAddr(await call(a, SEL[g]))) hits.push(`${g}()`);
  for (const g of ["authorizedAgents", "verifiers"]) if (isTrue(await call(a, SEL[g] + leakWord))) hits.push(`${g}(leak)`);
  // 先用 DEFAULT_ADMIN 探測是否為 AccessControl；不是就跳過其餘角色。
  const probe = await call(a, SEL.hasRole + ROLES.DEFAULT_ADMIN_ROLE + leakWord);
  if (typeof probe === "string" && probe.length === 66) {
    for (const [name, h] of Object.entries(ROLES)) if (isTrue(await call(a, SEL.hasRole + h + leakWord))) hits.push(name);
  }
  if (isLeakAddr(await call(a, SEL.platformTreasury))) treasury.push(a);
  if (hits.length) held.push(`${a} ${c.label ?? ""} ${hits.join(",")}`);
}

// 選用：LOGS_RPC 指向支援全區段 eth_getLogs 的節點（例如 https://sepolia.gateway.tenderly.co、
// https://base-sepolia.gateway.tenderly.co）時，另外檢查「外洩金鑰有沒有把權限交給計畫外的地址」。
// 只放棄自己的角色擋不住這種事：若搶到金鑰的人先把 DEFAULT_ADMIN 授給自己的地址，
// 外洩地址 renounce 之後那個地址仍是 admin。這一步把所有 sender = 外洩地址的 RoleGranted、
// previousOwner = 外洩地址的 OwnershipTransferred 列出，對照允許清單。
const ALLOWED = new Set([
  LEAK,
  "0x2a588aea3271b159c9188d95e0d10614711f83e3", // Sepolia V2 admin（ROLE_SEPARATION.md）
  "0x540aecd37e7a7885824e7b7e996ebddfb842ef17", // keeper
  "0x9913f5d63817b1b98a2c07713d4516cc3b33a4e4", // guardian / pauser
  "0xece96a5ec46e20e0f9a441c9d787e89ce366b165", // risk
  "0x3a37415981f6f4fc27fa6c8c62f1d4e47115fd17", // Sepolia AssetVaultV2 proxy（V2 合成資產的 MINTER）
  "0x27c21324d101e867e0634bf2ebe3f9dcf3aca585", // 2026-08-07 輪替後的 Base 部署者（KEY_ROTATION_20260807.md）
  "0x0000000000000000000000000000000000000000", // renounceOwnership
  ...(process.env.ADAPTER_NEW_OWNER ? [process.env.ADAPTER_NEW_OWNER.toLowerCase()] : []),
]);
let unexpected = 0;
if (process.env.LOGS_RPC) {
  const logsRpc = async (filter) => {
    const r = await fetch(process.env.LOGS_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", ...filter }] }),
    }).catch((e) => { dieRpc("LOGS_RPC fetch", { message: String(e && e.message || e) }); });
    const j = await r.json();
    if (j.error) dieRpc("LOGS_RPC eth_getLogs", j.error);
    return j.result;
  };
  const RG = "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d";
  const OT = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
  const UPGRADED = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";       // ERC1967 Upgraded(address)
  const ADMIN_CHANGED = "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f"; // AdminChanged(address,address)
  const KNOWN_IMPL = "0xa8a5b0e9c062e0bb1ab3a15788ae823251c41ac1"; // AssetVaultV2 已知實作
  const KNOWN_UPGRADE_COUNT = 3;        // N2：0x3a37 歷史上恰好 3 次 Upgrade（V2.1→V2.5 的升級鏈）
  const LAST_KNOWN_UPGRADE_BLOCK = 11360076; // 最後一次（升到已知實作）的區塊；之後不得再有任何一筆
  const pad = "0x" + leakWord;
  const grants = await logsRpc({ topics: [RG, null, null, pad] });
  const transfers = await logsRpc({ topics: [OT, pad] });
  const bad = [];
  for (const l of grants) { const to = "0x" + l.topics[2].slice(26); if (!ALLOWED.has(to)) bad.push(`RoleGranted ${l.address} role ${l.topics[1].slice(0, 10)}… → ${to}（block ${Number(l.blockNumber)}）`); }
  for (const l of transfers) { const to = "0x" + l.topics[2].slice(26); if (!ALLOWED.has(to)) bad.push(`OwnershipTransferred ${l.address} → ${to}（block ${Number(l.blockNumber)}）`); }
  // M4：代理被 upgradeToAndCall 到惡意實作只會發 Upgraded／AdminChanged，不會發 RoleGranted。
  // 只掃我們凍結角色的那顆 UUPS 代理（Sepolia 的 AssetVaultV2）：掃全盤點會混進 OP 系統合約、
  // Circle USDC、Base 版本沿革等無關升級，純噪音。這顆的 Upgraded 應只有建構時那一次、且實作 = 已知值。
  const PROXIES = { sepolia: ["0x3a37415981f6f4fc27fa6c8c62f1d4e47115fd17"], base: [] }[chainKey] || [];
  let upgrades = [], adminChanges = [];
  if (PROXIES.length) {
    upgrades = await logsRpc({ address: PROXIES, topics: [UPGRADED] });
    adminChanges = await logsRpc({ address: PROXIES, topics: [ADMIN_CHANGED] });
    // N2：嚴格化。這顆代理的升級史是固定的——恰好 3 筆，最後一筆在區塊 11360076（升到已知實作）。
    //   (a) 11360076 之後出現任何一筆 Upgraded → 一定是計畫外升級（含「升到惡意實作再升回來」）；
    //   (b) 總數 ≠ 3 → 升級史被動過；
    //   (c) 最後一筆實作 ≠ 已知值 → 目前跑在未知實作上。
    for (const l of upgrades) {
      if (Number(l.blockNumber) > LAST_KNOWN_UPGRADE_BLOCK) {
        bad.push(`區塊 ${LAST_KNOWN_UPGRADE_BLOCK} 之後的 Upgraded ${l.address} → impl 0x${l.topics[1].slice(26)}（block ${Number(l.blockNumber)}）`);
      }
    }
    if (upgrades.length !== KNOWN_UPGRADE_COUNT) {
      bad.push(`${PROXIES[0]} 的 Upgraded 共 ${upgrades.length} 筆，預期 ${KNOWN_UPGRADE_COUNT} 筆——升級史被動過`);
    }
    const lastUp = upgrades.slice().sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber)).pop();
    if (lastUp) { const impl = "0x" + lastUp.topics[1].slice(26); if (impl !== KNOWN_IMPL) bad.push(`最後一次 Upgraded 的實作 ${impl} ≠ 已知值（block ${Number(lastUp.blockNumber)}）`); }
    for (const l of adminChanges) { bad.push(`AdminChanged ${l.address}（block ${Number(l.blockNumber)}）— 代理 admin 換手，需人工確認`); }
  }
  unexpected = bad.length;
  console.log(`[${chainArg}] 事件掃描：RoleGranted(sender=leak) ${grants.length}、OwnershipTransferred(prev=leak) ${transfers.length}、Upgraded ${upgrades.length}、AdminChanged ${adminChanges.length}；可疑 ${bad.length} 筆`);
  if (bad.length) console.log("  " + bad.join("\n  ") + "\n  ↑ 計畫外的授權／移交／升級，凍結外洩地址擋不住，需另行處理。");
} else {
  console.log(`[${chainArg}] 注意：未設 LOGS_RPC，略過事件掃描（計畫外授權／升級無法偵測）。驗收時必須設 LOGS_RPC（見 runbook §7.4）。`);
}

// M5：整輪一個成功的 eth_call 都沒有，代表 RPC 壞了或接錯鏈，不能當成「都沒有權限」。
if (okCalls === 0) dieRpc("整輪沒有任何成功的 eth_call", { message: "0 ok calls" });

console.log(`[${chainArg}] 讀回 ${chain.contracts.length} 顆合約（盤點全集，不只凍結計畫）；成功 eth_call ${okCalls} 次`);
if (held.length) {
  console.log(`外洩地址仍持有 ${held.length} 顆：\n  ${held.join("\n  ")}`);
} else {
  console.log("外洩地址已不持有任何 owner／pendingOwner／guardian／marketOperator／authorizedAgents／verifiers／已知角色");
}
console.log(`platformTreasury（immutable，凍結無法處理，只能重部署）= 外洩地址：${treasury.length} 顆${treasury.length ? "\n  " + treasury.join("\n  ") : ""}`);
process.exit(held.length || unexpected ? 1 : 0);
