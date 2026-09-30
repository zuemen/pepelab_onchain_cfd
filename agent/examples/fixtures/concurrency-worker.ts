// concurrency.test.ts 的 worker：收到 "go" 後連續做 N 次 policy 預留與 VC nonce 記錄。
// 不連鏈、不送交易。由父 process 以 child_process.fork 啟動。
import { ethers } from "ethers";

const { enforcePolicyGate, checkAndRecordVcNonce } = await import("@pepelab/shared");

const N = Number(process.env.WORKER_ITER ?? "20");
const WID = process.env.WORKER_ID ?? "0";
const AGENT = "0x" + "ab".repeat(20);
const ISSUER = "0x" + "cd".repeat(20);
const NOW = Math.floor(Date.now() / 1000);

process.on("message", async (m) => {
  if (m !== "go") return;
  let allowed = 0;
  let nonceOk = 0;
  for (let i = 0; i < N; i++) {
    const g = await enforcePolicyGate({
      action: "open", sessionId: 1, agent: AGENT, user: ISSUER, symbol: "sBTC", isLong: true, marginUsdc: 1, leverage: 2,
    });
    if (g.allowed) allowed++;
    const r = checkAndRecordVcNonce({
      valid: true, version: 2, nonce: ethers.id(`w${WID}-${i}`), digest: ethers.id(`d${WID}-${i}`),
      issuer: ISSUER, sessionId: 1, issuedAt: NOW, validUntil: NOW + 3600,
    });
    if (r.ok) nonceOk++;
  }
  process.send!({ allowed, nonceOk }, () => process.exit(0));
});
process.send!("ready");
