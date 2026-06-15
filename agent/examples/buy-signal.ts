// buy-signal.ts — 任意外部 agent 帶自己的錢包，連 PepeLab 的【公開正式網址】用官方
// Base Sepolia USDC 自己付費購買交易訊號。**這支只依賴公開 npm 套件**（viem + x402-fetch），
// 不依賴本專案 monorepo——複製這支就能在任何地方跑，這就是「CLI/agent 直接上網站購買」。
//
// 跑法（agent 目錄下，已裝 tsx）：
//   export X402_API_URL=https://<your-vercel-app>.vercel.app   # 或 http://localhost:4021
//   export AGENT_PRIVATE_KEY=0x<有 Base Sepolia 官方 USDC + 一點 ETH 的測試金鑰>
//   export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
//   export TRADER=0x<要買訊號的 trader 地址>        # 可選，預設用 API 探索
//   npx tsx examples/buy-signal.ts
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const API = (process.env.X402_API_URL ?? "http://localhost:4021").replace(/\/$/, "");
const PK = process.env.AGENT_PRIVATE_KEY?.trim();
const RPC = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
let TRADER = process.env.TRADER?.trim() || "";

async function main() {
  if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK)) {
    throw new Error("設 AGENT_PRIVATE_KEY=0x…（需持 Base Sepolia 官方 USDC + 一點 ETH）");
  }

  // 1) 先免費探索服務目錄（端點/定價/network/asset）。
  const dir = await (await fetch(`${API}/`)).json();
  console.log("① 服務目錄：", JSON.stringify(dir, null, 2));
  if (!TRADER) {
    // 沒指定 trader → 讓 server 端用鏈上第一個（這裡用 demo 端點探一個）。
    TRADER = "0x0000000000000000000000000000000000000000";
  }

  // 2) 建 viem WalletClient（x402-fetch 需要 chain+transport 才能簽 EIP-3009）。
  const account = privateKeyToAccount(PK as Hex);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC),
  }).extend(publicActions);
  console.log("\n② 付款錢包：", account.address);

  // 3) 包裝 fetch：遇 402 自動用官方 USDC 簽 transferWithAuthorization 並重送。
  //    注意 init 不可省略（x402-fetch 在 402 重送時需要它）。
  const payFetch = wrapFetchWithPayment(
    fetch,
    wallet as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );

  console.log(`\n③ 付費購買 GET /signals/${TRADER} …（402 → 簽章 → 200）`);
  const res = await payFetch(`${API}/signals/${TRADER}`, { method: "GET" });
  const body = (await res.json()) as any;
  console.log("   HTTP", res.status);
  console.log("   訊號：", JSON.stringify(body?.data ?? body, null, 2));
  if (body?.settlementTx) {
    console.log(
      `\n✓ x402 收入已上鏈 70/20/10，settlement tx:\n   https://sepolia.basescan.org/tx/${body.settlementTx}`,
    );
  }
}

main().catch((e) => {
  console.error("buy-signal 失敗：", e?.message ?? e);
  process.exit(1);
});
