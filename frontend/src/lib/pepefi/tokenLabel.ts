// Display label for the platform's simulated stablecoin (MockUSDC).
// Shown to users as mUSDC, matching the on-chain contract symbol. NOTE: this is
// the PLATFORM collateral (a mock token) only. x402 paid-API settlement uses the
// official Circle USDC (EIP-3009) and is labelled plain "USDC" — the "m" prefix
// is what distinguishes the mock margin token from real USDC. Do not route x402
// labels through this constant.
export const STABLE_LABEL = 'mUSDC';
