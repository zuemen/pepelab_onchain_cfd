// x402 分潤路由（FeeRouter，綁 Circle 官方 USDC）的位址設定來源。
//
// 為什麼不放進 addresses.ts：
//   • 它不是 V1 部署的 `ChainAddresses.FeeRouter`（那顆綁 MockUSDC，0x00f6…3e0c）。
//     x402 的 `exact` scheme 走官方 USDC（0x036CbD…CF7e）的 EIP-3009，必須由
//     contracts/script/DeployX402Router.s.sol 另外部署一顆 FeeRouter。兩者混用正是
//     settlement.ts 守衛要擋的最常見誤配。
//   • addresses.ts 被 signal-api 的 Vercel bundle 內聯（bundle:check 指紋），改它
//     就必須重新打包；這裡是純設定，不影響 bundle。
//
// 誰讀它：
//   • scripts/check-addresses.mjs —— workflow env 的 X402_FEE_ROUTER 必須等於這裡；
//     x402-settlement-worker.yml 也以 `--print 84532 X402FeeRouter` 在執行期比對
//     repository variable `vars.X402_FEE_ROUTER`，不一致就讓 job 失敗。
//   • 其餘副本（agent/.env.example、X402DocsPage.tsx）目前仍各自寫死，改位址時要一起改。
//
// 2026-09-29 唯讀核對：0x29e5…B57d.usdc() == 0x036CbD53842c5426634e7929541eC2318f3dCF7e。
export const X402_FEE_ROUTER: Record<number, string> = {
  84532: '0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d',
}
