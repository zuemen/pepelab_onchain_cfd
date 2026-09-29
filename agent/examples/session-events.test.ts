// positionId 解析回歸測試（2026-09-29 P0）。離線、不打鏈。
//   cd agent && npx tsx examples/session-events.test.ts
//
// 根因：shared/abis.ts 的 AGENT_SESSION_MANAGER_ABI（write.ts 建 Contract 用的那份）
// 沒有任何 event fragment。ethers v6 的 Interface.parseLog 對未知事件回 null（不丟錯），
// 所以 SessionOpenedPosition 永遠解不出來 → positionId 永遠 undefined。
//
// 這裡用「合約編譯出的完整 JSON ABI」（獨立來源）以 Interface.encodeEventLog 造出事件
// log，驗證 shared 的解析器解得出 positionId，並核對兩份 ABI 的事件 topic 一致。
import assert from "node:assert";
import { ethers } from "ethers";
import { AGENT_SESSION_MANAGER_ABI, parseSessionOpenedPositionId } from "@pepelab/shared";
import fullAbiJson from "../../frontend/src/contracts/abi/AgentSessionManager.json" with { type: "json" };

const fullAbi = ((fullAbiJson as { abi?: unknown }).abi ?? fullAbiJson) as ethers.InterfaceAbi;
const full = new ethers.Interface(fullAbi);
const shared = new ethers.Interface(AGENT_SESSION_MANAGER_ABI);

const MANAGER = "0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B";
const OTHER = "0x827eA0c62a32e995927101259042F8A27D99124D";
const AGENT = "0x" + "22".repeat(20);

function logOf(address: string, iface: ethers.Interface, name: string, values: unknown[]) {
  const ev = iface.getEvent(name)!;
  const { topics, data } = iface.encodeEventLog(ev, values);
  return { address, topics, data };
}

// 1) 兩份 ABI 的事件 topic 完全一致（shared 的簽章沒寫錯、indexed 沒漏）
for (const name of ["SessionCreated", "SessionOpenedPosition", "SessionClosedPosition"]) {
  const a = full.getEvent(name)?.topicHash;
  const b = shared.getEvent(name)?.topicHash;
  assert.ok(a, `完整 ABI 應有 ${name}`);
  assert.equal(b, a, `shared ABI 的 ${name} topic 必須與合約一致`);
}
console.log("✓ shared ABI 的三個 session 事件 topic 與合約 JSON ABI 一致");

// 2) 本 manager 發出的 SessionOpenedPosition → 解出 positionId
{
  const logs = [
    // 交易所自己的事件（不同地址、不同簽章）排在前面，必須被略過
    { address: OTHER, topics: [ethers.id("PositionOpened(uint256,address)"), ethers.zeroPadValue("0x01", 32)], data: "0x" },
    logOf(MANAGER, full, "SessionOpenedPosition", [7n, AGENT, 1234n, 10n * 10n ** 18n]),
  ];
  assert.equal(parseSessionOpenedPositionId(logs, MANAGER), "1234");
  assert.equal(parseSessionOpenedPositionId(logs, MANAGER.toLowerCase()), "1234", "地址大小寫不敏感");
  console.log("✓ encodeEventLog 造出的 SessionOpenedPosition → positionId=1234");
}

// 3) 別的地址發出同簽章事件 → 不採信
{
  const logs = [logOf(OTHER, full, "SessionOpenedPosition", [7n, AGENT, 999n, 1n])];
  assert.equal(parseSessionOpenedPositionId(logs, MANAGER), undefined);
  console.log("✓ 非本 manager 發出的同名事件 → 不採信");
}

// 4) 沒有該事件 → undefined（呼叫端才會誠實回報「無法解析」）
{
  const logs = [logOf(MANAGER, full, "SessionClosedPosition", [7n, AGENT, 5n])];
  assert.equal(parseSessionOpenedPositionId(logs, MANAGER), undefined);
  console.log("✓ 只有 SessionClosedPosition → undefined");
}

// 5) 回歸：舊 ABI（沒有事件）確實解不出來——這就是 bug 本身
{
  const legacy = new ethers.Interface(
    AGENT_SESSION_MANAGER_ABI.filter((f) => !f.startsWith("event ")),
  );
  const l = logOf(MANAGER, full, "SessionOpenedPosition", [7n, AGENT, 1234n, 1n]);
  assert.equal(legacy.parseLog({ topics: l.topics, data: l.data }), null);
  console.log("✓ 回歸：沒有 event fragment 的 ABI parseLog 回 null（舊 bug 的機制）");
}

console.log("\n✅ session-events.test.ts 全過（positionId 解析）");
