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
//   • pages/pepefi/X402DocsPage.tsx 直接 import 這裡。
//   • agent/.env.example 的 X402_FEE_ROUTER 也由 check-addresses.mjs 比對這裡。
//
// 2026-10-10 重新部署（OWNER_ACTIONS 第 4 步）：舊 router 0x29e5…B57d 的 platformTreasury 是外洩地址
// （immutable），已由金庫 owner 斷開。新 router 讀回：usdc() == 0x036CbD53842c5426634e7929541eC2318f3dCF7e、
// platformTreasury() == 0x27C2…A585、insuranceVault() == 0xc7Af…7B9f（沿用舊 x402 金庫，已存 1 USDC 種子）、
// exchange()／copyTracker() == 0。repository variable X402_FEE_ROUTER 已同步。
export const X402_FEE_ROUTER: Record<number, string> = {
  84532: '0x780E18146Bc77E50c3e5EcaED913FC31F62c0f6A',
}
