// Display label for the platform's simulated stablecoin (MockUSDC).
// Shown to users as USDT — purely a frontend label; the on-chain contract is
// still MockUSDC. NOTE: this is the PLATFORM collateral only. x402 paid-API
// settlement uses the official Circle USDC (EIP-3009) and must keep showing
// "USDC" — do not route x402 labels through this constant.
export const STABLE_LABEL = 'USDT';
