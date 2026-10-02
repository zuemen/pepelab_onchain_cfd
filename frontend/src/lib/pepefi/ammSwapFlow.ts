// /exchange 兌換卡的鏈上讀取與送出流程（#215 審查修正）。
//
// 這裡是「會碰鏈」的那一半：ammPoolView 是純函式（判斷版本、算畫面模型），這個檔把
// 它們串成三個動作。全部透過注入的 reader / gateway 讀寫，不直接 import ethers 的
// Contract——頁面把 ethers 接上來，測試接假的，所以三種合約版本都能在 node 裡跑完整條流程。
//
//   1. `loadAmmSnapshot`  ：版本探測（getCode）與池子讀數**並行**；探測成功的結果以
//                           chainId＋位址快取——bytecode 不會變，之後 getCode 失敗也不會
//                           把已知的版本蓋成 unknown。
//   2. `readQuoteSnapshot`：quote 與衝擊基準在**同一次讀取**取得。頁面載入時讀的基準
//                           放久了會過期（oracle 每幾分鐘更新），拿它對即時 quote 算
//                           衝擊，會重現 #165 的 0.00% ／ 假衝擊。
//   3. `executeSwap`      ：送任何交易（含 approve）之前，先確認庫存、再以 eth_call
//                           模擬 swap；必定失敗就一筆都不送。

import { safeRead, withTimeout } from './safeRead'
import { priceImpactBps, minOutWithSlippage } from './ammQuote'
import {
  type PoolReads,
  checkInventory,
  type QuoteView,
  impactReference,
  checkOracleFixed,
  type InventoryCheck,
  UNKNOWN_CAPABILITIES,
  type AmmCapabilities,
  detectAmmCapabilities,
} from './ammPoolView'

/** 讀不到 → null。和 safeRead(p, 0n) 不同：0 會被畫面當成一個真的數字。 */
const readOrNull = <T,>(p: Promise<T>, ms?: number) => safeRead<T | null>(p, null, ms)

// ── 讀取介面 ────────────────────────────────────────────────────────────────

/** 頁面以 ethers Contract 實作；測試以假合約實作。每個方法失敗就 reject。 */
export interface AmmReader {
  getCode(): Promise<string>
  getPrice(): Promise<bigint>
  getReserves(): Promise<readonly [bigint, bigint]>
  /** v3 才有：`[price18, updatedAt]`。 */
  oraclePrice(): Promise<readonly [bigint, bigint]>
  /** v3 才有。 */
  maxOracleAge(): Promise<bigint>
  /** AMM 自己指向的 oracle（`oracle()`）對 `ETH_ASSET_ID()` 的報價，8 dec。 */
  oracleEthPrice8(): Promise<bigint>
  quote(isEthIn: boolean, amountIn: bigint): Promise<bigint>
}

// ── 1. 版本探測 + 池子讀數 ──────────────────────────────────────────────────

interface CapsCacheEntry {
  /** bytecode 判斷出來的版本（一定不是 unknown）。 */
  caps: AmmCapabilities
  /** oracle-fixed 是否已經以 getPrice() == oracle × 1e10 正向確認過。 */
  oracleFixedConfirmed: boolean
}

export type AmmCapsCache = Map<string, CapsCacheEntry>

/** 模組層級的快取：換頁再回來也不必重讀 bytecode。 */
export const ammCapsCache: AmmCapsCache = new Map()

/** chainId 不明就不快取（null）——同一個位址在不同鏈上可以是不同的合約。 */
export function ammCacheKey(chainId: number | null | undefined, address: string): string | null {
  if (chainId === null || chainId === undefined) return null
  return `${chainId}:${address.toLowerCase()}`
}

export interface AmmSnapshot {
  caps: AmmCapabilities
  /**
   * - `fresh`：這次讀到 bytecode。
   * - `cached`：沿用先前成功的判斷（沒有再呼叫 getCode）。
   * - `failed`：getCode 讀不到、也沒有快取 → caps 是 unknown，下次再試。
   */
  probe: 'fresh' | 'cached' | 'failed'
  reads: PoolReads
  /** v3 的 oraclePrice().updatedAt；其他版本為 0（＝不擋單，那些版本也不檢查）。 */
  oracleUpdatedAt: bigint
  maxOracleAge: bigint
}

export async function loadAmmSnapshot(
  reader: AmmReader,
  cacheKey: string | null,
  cache: AmmCapsCache = ammCapsCache,
): Promise<AmmSnapshot> {
  const cached = cacheKey ? cache.get(cacheKey) : undefined
  const known = cached?.caps
  const skip = Promise.resolve(null)

  // getCode 與其他讀取並行：串在前面會讓整張卡多等一輪（最壞 8 秒逾時）。
  // 版本還不知道時，v3 才有的函式先試讀——舊版會 revert，但結果只在 caps 說「有」的時候
  // 才採用，所以 revert 不會被誤讀成「讀不到」。版本已知之後，缺的函式就不再呼叫。
  const [code, price, reserves, oraclePx, maxAge, oracle8] = await Promise.all([
    known ? skip : readOrNull(reader.getCode()),
    readOrNull(reader.getPrice()),
    readOrNull(reader.getReserves()),
    !known || known.hasOraclePrice ? readOrNull(reader.oraclePrice()) : skip,
    !known || known.hasMaxOracleAge ? readOrNull(reader.maxOracleAge()) : skip,
    !known || (known.pricing === 'oracle-fixed' && !cached?.oracleFixedConfirmed)
      ? readOrNull(reader.oracleEthPrice8())
      : skip,
  ])

  const detected = known ?? detectAmmCapabilities(code)
  let probe: AmmSnapshot['probe'] = 'fresh'
  if (known) probe = 'cached'
  else if (code === null) probe = 'failed'

  // oracle-fixed 的正向確認。確認過一次就記住（bytecode 不會變，語意也不會變），之後
  // oracle 在兩次讀取之間剛好更新造成的不相等不會把畫面閃成 unknown。
  let caps = detected
  let confirmed = cached?.oracleFixedConfirmed ?? false
  if (detected.pricing === 'oracle-fixed' && !confirmed) {
    const check = checkOracleFixed(price, oracle8)
    if (check === 'confirmed') confirmed = true
    else if (check === 'contradicted') caps = UNKNOWN_CAPABILITIES
  }
  if (cacheKey && detected.pricing !== 'unknown') {
    cache.set(cacheKey, { caps: detected, oracleFixedConfirmed: confirmed })
  }

  return {
    caps,
    probe,
    reads: {
      getPrice: price,
      reserves: reserves ? [reserves[0], reserves[1]] : null,
      oraclePrice: caps.hasOraclePrice && oraclePx ? oraclePx[0] : null,
    },
    oracleUpdatedAt: caps.hasOraclePrice && oraclePx ? oraclePx[1] : 0n,
    maxOracleAge: caps.hasMaxOracleAge && maxAge !== null ? maxAge : 0n,
  }
}

// ── 2. quote 與衝擊基準同一次讀取 ───────────────────────────────────────────

export interface QuoteSnapshot extends QuoteView {
  amountIn: bigint
  /** 與這筆 quote 同一次讀到的池子讀數；畫面上的兌換價／儲備也用這一組。 */
  reads: PoolReads
  /** v3：同一次讀到的 oraclePrice().updatedAt；其他版本或讀不到 → null。 */
  oracleUpdatedAt: bigint | null
}

/**
 * quote 失敗（revert／逾時）→ reject：這筆金額換不成，呼叫端顯示空白。
 * 基準讀不到 → 對應欄位為 null、`impactBps` 為 null（不顯示衝擊），**不**退回頁面載入時的舊值。
 */
export async function readQuoteSnapshot(
  reader: AmmReader,
  caps: AmmCapabilities,
  isEthIn: boolean,
  amountIn: bigint,
): Promise<QuoteSnapshot> {
  const skip = Promise.resolve(null)
  const [out, price, reserves, oraclePx] = await Promise.all([
    withTimeout(reader.quote(isEthIn, amountIn)),
    // 舊版的基準是 getPrice()（oracle 報價）；恆定乘積版的基準是儲備，getPrice() 用不到。
    caps.pricing === 'oracle-fixed' ? readOrNull(reader.getPrice()) : skip,
    readOrNull(reader.getReserves()),
    caps.hasOraclePrice ? readOrNull(reader.oraclePrice()) : skip,
  ])
  const reads: PoolReads = {
    getPrice: price,
    reserves: reserves ? [reserves[0], reserves[1]] : null,
    oraclePrice: oraclePx ? oraclePx[0] : null,
  }
  const ref = impactReference(caps, isEthIn, reads)
  return {
    isEthIn,
    amountIn,
    out,
    reads,
    oracleUpdatedAt: oraclePx ? oraclePx[1] : null,
    impactBps: ref ? priceImpactBps({ amountIn, amountOut: out, ...ref }) : null,
    inventory: checkInventory(caps, isEthIn, out, reads.reserves),
  }
}

// ── 3. 送出：先預檢，必定失敗就一筆都不送 ───────────────────────────────────

export interface TxLike {
  wait(): Promise<unknown>
  hash: string
}

/** 頁面以 ethers Contract 實作。`simulateSwap` 是 eth_call（from = 使用者），不送交易。 */
export interface SwapGateway {
  quote(isEthIn: boolean, amountIn: bigint): Promise<bigint>
  getReserves(): Promise<readonly [bigint, bigint]>
  /** 使用者給 AMM 的 USDC 額度。 */
  allowance(): Promise<bigint>
  simulateSwap(isEthIn: boolean, amountIn: bigint, minOut: bigint): Promise<unknown>
  approve(amount: bigint): Promise<TxLike>
  swap(isEthIn: boolean, amountIn: bigint, minOut: bigint): Promise<TxLike>
}

export type SwapResult =
  | { ok: true; quoted: bigint; hash: string; approved: boolean }
  /** 庫存不足。`approved` 為 false = 沒有送出任何交易。 */
  | { ok: false; stage: 'inventory'; needed: bigint; available: bigint; approved: boolean }
  /** eth_call 模擬失敗。`approved` 為 false = 沒有送出任何交易。 */
  | { ok: false; stage: 'preflight'; error: unknown; approved: boolean }

/** OpenZeppelin v5 的 `ERC20InsufficientAllowance(address,uint256,uint256)`。 */
export const ERC20_INSUFFICIENT_ALLOWANCE = '0xfb8f41b2'

/** 這個 revert 是不是「額度不足」（還沒 approve 時模擬 USDC→ETH 一定會撞到）。 */
export function isAllowanceRevert(err: unknown): boolean {
  const e = (err ?? {}) as {
    data?: unknown
    message?: unknown
    reason?: unknown
    shortMessage?: unknown
    revert?: { name?: unknown } | null
    error?: { data?: unknown; message?: unknown } | null
    info?: { error?: { data?: unknown; message?: unknown } | null } | null
  }
  const datas = [e.data, e.error?.data, e.info?.error?.data]
  if (datas.some((d) => typeof d === 'string' && d.toLowerCase().startsWith(ERC20_INSUFFICIENT_ALLOWANCE))) return true
  const text = [e.revert?.name, e.reason, e.shortMessage, e.message, e.error?.message, e.info?.error?.message]
    .filter((x): x is string => typeof x === 'string')
    .join(' ')
    .toLowerCase()
  // v5 的 custom error 名稱；v4 的 require 字串（"ERC20: insufficient allowance"、
  // 更早的 "transfer amount exceeds allowance"）。
  return text.includes('erc20insufficientallowance') || text.includes('insufficient allowance') || text.includes('exceeds allowance')
}

/**
 * 兌換。送出的參數與原本的 doSwap 相同：
 *   ETH→USDC：`swapETHForUSDC(minOut, { value: ethIn })`
 *   USDC→ETH：額度不足才 `approve(amm, usdcIn)`，再 `swapUSDCForETH(usdcIn, minEthOut)`
 * minOut 一律是**當下的 quote** 打 DEFAULT_SLIPPAGE_BPS。
 *
 * 多出來的是送出前的兩道檢查，而且都在 approve **之前**：
 *
 * 1. 庫存：quote 與儲備同一次讀，`quotedOut` 超過輸出側庫存就停。舊版合約的 quote 不看
 *    庫存，這是它唯一一個「quote 得出來、swap 換不成」的原因。
 * 2. eth_call 模擬 swap。額度已足夠時這是完整模擬。額度不足時模擬一定會在 transferFrom
 *    revert「額度不足」——那不算失敗：
 *      - 新版合約的 transferFrom 排在所有檢查（過期、滑點、池價偏離）之後，撞到額度不足
 *        代表前面的檢查都過了；撞到別的錯就是 approve 之後也必定失敗 → 不送 approve。
 *      - 舊版合約的 transferFrom 排在最前面，後面會失敗的條件只有庫存（第 1 點已擋）。
 *    approve 上鏈之後再完整模擬一次（等錢包簽名、等上鏈的這段時間價格可能已經動了），
 *    過了才送 swap。
 *
 * 使用者拒簽、RPC 斷線等「不是合約拒絕」的錯誤照舊往外丟，由呼叫端的 catch 處理。
 */
export async function executeSwap(
  gateway: SwapGateway,
  caps: AmmCapabilities,
  isEthIn: boolean,
  amountIn: bigint,
  hooks: { onApproving?: () => void } = {},
): Promise<SwapResult> {
  const price = async (): Promise<{ quoted: bigint; minOut: bigint; inventory: InventoryCheck }> => {
    const [quoted, reserves] = await Promise.all([
      gateway.quote(isEthIn, amountIn),
      readOrNull(gateway.getReserves()),
    ])
    return { quoted, minOut: minOutWithSlippage(quoted), inventory: checkInventory(caps, isEthIn, quoted, reserves) }
  }

  let { quoted, minOut, inventory } = await price()
  if (inventory.status === 'exceeded') {
    return { ok: false, stage: 'inventory', needed: inventory.needed, available: inventory.available, approved: false }
  }

  const needsApproval = !isEthIn && (await gateway.allowance()) < amountIn
  try {
    await gateway.simulateSwap(isEthIn, amountIn, minOut)
  } catch (error) {
    if (!(needsApproval && isAllowanceRevert(error))) {
      return { ok: false, stage: 'preflight', error, approved: false }
    }
  }

  if (needsApproval) {
    hooks.onApproving?.()
    const approveTx = await gateway.approve(amountIn)
    await approveTx.wait()

    ;({ quoted, minOut, inventory } = await price())
    if (inventory.status === 'exceeded') {
      return { ok: false, stage: 'inventory', needed: inventory.needed, available: inventory.available, approved: true }
    }
    try {
      await gateway.simulateSwap(isEthIn, amountIn, minOut)
    } catch (error) {
      return { ok: false, stage: 'preflight', error, approved: true }
    }
  }

  const tx = await gateway.swap(isEthIn, amountIn, minOut)
  await tx.wait()
  return { ok: true, quoted, hash: tx.hash, approved: needsApproval }
}
