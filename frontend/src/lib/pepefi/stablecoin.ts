// Which mock stablecoin the user has selected for balances and on-ramp.
//
// Note: trading margin always settles in USDC — PerpetualExchange hardcodes it.
// This selection covers holding, the faucet, and display; margin support for
// USDT is a follow-up. The UI states that limitation rather than hiding it.

export type Stable = 'USDC' | 'USDT';

const KEY = 'pepefi:stablecoin';

export function getStable(): Stable {
  try {
    return (localStorage.getItem(KEY) as Stable) ?? 'USDC';
  } catch {
    return 'USDC';
  }
}

export function setStable(s: Stable): void {
  try {
    localStorage.setItem(KEY, s);
    // Broadcast so every mounted useStablecoin() updates, not just the caller.
    window.dispatchEvent(new CustomEvent('pepefi:stable-changed', { detail: s }));
  } catch {
    /* storage unavailable (private mode) — selection just won't persist */
  }
}

export const stableLabel = (s: Stable) => s;
