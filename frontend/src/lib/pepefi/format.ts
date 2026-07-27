// Number formatting for on-chain figures.
//
// Two problems this solves, both specific to a trading surface.
//
// 1. PROPORTIONAL DIGITS JITTER. In most sans fonts a "1" is narrower than a
//    "8", so a price ticking 1.11 → 8.88 changes the string's pixel width and
//    shoves whatever sits next to it. On a page where the oracle keeper rewrites
//    prices every 15 minutes, and PnL recomputes on every block, that reads as
//    the layout twitching. `font-variant-numeric: tabular-nums` forces every
//    digit to one advance width and the movement stops. Use `tabularNums` on any
//    element whose digits can change — that includes anything in a column, even
//    when the value looks static.
//
//    Places already using the MONO stack get this for free (monospace is
//    tabular by definition), which is why prices in the terminal views were
//    stable while the same figure in a Typography was not.
//
// 2. EVERY CALLER ROLLED ITS OWN. There were ~146 bare toFixed/toLocaleString
//    calls, so "$1,234.5" and "$1234.50" and "1,234.50 USDC" all appeared for
//    the same quantity depending on which page you were on. These helpers are
//    deliberately boring so there is no reason to hand-roll another one.
//
// Formatting is locale-aware (`undefined` locale = the user's), because a
// platform sold to institutions in other markets should not hard-code
// thousands separators.

/** Reusable sx fragment. Apply to anything whose digits can change. */
export const tabularNums = { fontVariantNumeric: 'tabular-nums' } as const;

/** Convert an on-chain integer to a JS number. Mirrors the `Number(v)/1e18`
 *  pattern this codebase used inline, but names the decimals so 1e8 oracle
 *  prices and 1e18 balances stop being visually interchangeable. */
export const fromUnits = (v: bigint | number, decimals: number): number =>
  Number(v) / 10 ** decimals;

type NumOpts = {
  /** Fixed decimal places. Omit to let the value pick (see `fAuto`). */
  dp?: number;
  /** Prefix an explicit "+" on positive values. For PnL and deltas. */
  signed?: boolean;
};

const nf = (n: number, dp: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

const sign = (n: number, signed?: boolean) => (signed && n >= 0 ? '+' : '');

/** Plain number with grouping. */
export function fNum(n: number, { dp = 2, signed }: NumOpts = {}): string {
  if (!Number.isFinite(n)) return '—';
  return sign(n, signed) + nf(n, dp);
}

/** USD-denominated value: `$1,234.56`, or `-$1,234.56` (minus outside the $,
 *  which is how finance writes it — `$-1,234.56` looks like a typo). */
export function fUsd(n: number, { dp = 2, signed }: NumOpts = {}): string {
  if (!Number.isFinite(n)) return '—';
  const s = n < 0 ? '-' : sign(n, signed);
  return `${s}$${nf(Math.abs(n), dp)}`;
}

/** Percentage. Always signed by default — a percentage change without its sign
 *  is ambiguous, and this platform shows a lot of them. */
export function fPct(n: number, { dp = 2, signed = true }: NumOpts = {}): string {
  if (!Number.isFinite(n)) return '—';
  return `${sign(n, signed)}${nf(n, dp)}%`;
}

/** Token amount with its ticker: `1,234.5678 USDC`. */
export function fToken(n: number, symbol: string, { dp = 4, signed }: NumOpts = {}): string {
  if (!Number.isFinite(n)) return '—';
  return `${sign(n, signed)}${nf(n, dp)} ${symbol}`;
}

/** Picks decimals by magnitude: big numbers do not need four places, and small
 *  ones are useless without them. `$1,204.35` but `$0.004821`. */
export function fAuto(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0.00';
  if (a >= 1000) return nf(n, 2);
  if (a >= 1) return nf(n, 2);
  if (a >= 0.01) return nf(n, 4);
  return nf(n, 6);
}

/** Compact notation for headline figures: 1.2M, 45.3K. Not for anything the
 *  user might need to reconcile against a block explorer — it rounds. */
export function fCompact(n: number, dp = 1): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${nf(n / 1e9, dp)}B`;
  if (a >= 1e6) return `${nf(n / 1e6, dp)}M`;
  if (a >= 1e3) return `${nf(n / 1e3, dp)}K`;
  return nf(n, 0);
}

/** Basis points → human percent. Contracts speak bps (10000 = 100%); users do
 *  not. `fBps(30)` → "0.30%". */
export function fBps(bps: number | bigint, dp = 2): string {
  const n = Number(bps) / 100;
  if (!Number.isFinite(n)) return '—';
  return `${nf(n, dp)}%`;
}
