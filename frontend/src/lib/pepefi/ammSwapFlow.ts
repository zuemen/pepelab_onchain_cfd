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
//   3. `executeSwap`      ：送任何交易（含 approve）之前，先確認庫存、餘額、再以 eth_call
//                           模擬 swap；必定失敗就一筆都不送。minOut 不低於**畫面上顯示的
//                           最低收到數量**，也不低於即時報價 × 0.995（#220、PR #223 M1/M2）；
//                           價格變差就停下來讓使用者重新確認。
//   4. `scheduleAmmRefresh`：定時重讀＋分頁回到前景時立刻重讀一次（#220）。

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
  let priceRead = price
  if (detected.pricing === 'oracle-fixed' && !confirmed) {
    let check = checkOracleFixed(priceRead, oracle8)
    if (check === 'contradicted') {
      // #220：getPrice() 與 oracle 是兩次讀取，oracle 剛好在兩者之間更新就會不相等。
      // 第一次不相等時立刻**同時**重讀這兩個值再判一次，不讓畫面為了這個競態閃成
      // 「無法確認」一整輪（15 秒）。真的不是 oracle 定價（L3）的合約，重讀也一樣不相等。
      const [price2, oracle2] = await Promise.all([readOrNull(reader.getPrice()), readOrNull(reader.oracleEthPrice8())])
      const recheck = checkOracleFixed(price2, oracle2)
      // 重讀失敗（unverified）不算翻案：已經有一次「讀到了卻不相等」，維持 contradicted
      // （PR #223 審查 L1）。只有重讀**確認**相等才改判。
      if (recheck === 'confirmed') {
        check = 'confirmed'
        if (price2 !== null) priceRead = price2
      }
    }
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
      getPrice: priceRead,
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
  /** 使用者的 USDC 餘額（`balanceOf(user)`）。只有 USDC→ETH 會讀。 */
  balance(): Promise<bigint>
  simulateSwap(isEthIn: boolean, amountIn: bigint, minOut: bigint): Promise<unknown>
  approve(amount: bigint): Promise<TxLike>
  swap(isEthIn: boolean, amountIn: bigint, minOut: bigint): Promise<TxLike>
}

/**
 * 使用者按下兌換時，畫面上顯示的那一筆報價（`readQuoteSnapshot` 的結果即可）。
 * 畫面上的「最低收到數量」就是 `minOutWithSlippage(out)`——送出的 minOut 必須是同一個數字。
 */
export interface DisplayedQuote {
  isEthIn: boolean
  amountIn: bigint
  out: bigint
}

export type SwapResult =
  | { ok: true; quoted: bigint; minOut: bigint; hash: string; approved: boolean }
  /** 庫存不足。`approved` 為 false = 沒有送出任何交易。 */
  | { ok: false; stage: 'inventory'; needed: bigint; available: bigint; approved: boolean }
  /** USDC 餘額不足（approve 之前就讀 balanceOf）。一筆交易都沒送。 */
  | { ok: false; stage: 'balance'; needed: bigint; available: bigint; approved: false }
  /**
   * 價格已變動（#220）：即時 quote 低於畫面上顯示的「最低收到數量」，swap 沒有送出，
   * 要使用者看過新報價再按一次。`displayed` 是使用者確認過的報價、`quoted` 是剛讀到的。
   */
  | { ok: false; stage: 'priceMoved'; displayed: bigint; quoted: bigint; minOut: bigint; approved: boolean }
  /**
   * 算出來的 minOut 是 0（金額太小，報價打 0.5% 之後無條件捨去成 0）。minOut 0 等於沒有
   * 滑點保護，不送（PR #223 審查 M1）。
   */
  | { ok: false; stage: 'zeroMinOut'; quoted: bigint; approved: boolean }
  /** 同一個 gateway 已經有一筆兌換在跑（重入保護）。什麼都沒做。 */
  | { ok: false; stage: 'busy'; approved: false }
  /** eth_call 模擬失敗。`approved` 為 false = 沒有送出任何交易。 */
  | { ok: false; stage: 'preflight'; error: unknown; approved: boolean }

/**
 * 實際送出的 minOut（PR #223 審查 M1/M2）：
 *   max(畫面報價 × 0.995, 即時報價 × 0.995)
 * - 不低於畫面上的「最低收到數量」——使用者確認過的底線（#220）。
 * - 也不低於即時報價的 99.5%——畫面報價是舊的（例如分頁放在背景很久）而即時價大幅變好時，
 *   只用畫面的底線等於容忍度變成 30%，送出前被夾擊或價格回彈就只拿到即時報價的 70%。
 * - 畫面報價被傳成 1 wei 之類（minOut 0）也一樣有即時報價這道底線。
 */
export function sendMinOut(displayedOut: bigint, quoted: bigint): bigint {
  const a = minOutWithSlippage(displayedOut)
  const b = minOutWithSlippage(quoted)
  return a > b ? a : b
}

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
 * 兌換。送出的交易與原本的 doSwap 相同：
 *   ETH→USDC：`swapETHForUSDC(minOut, { value: ethIn })`
 *   USDC→ETH：額度不足才 `approve(amm, usdcIn)`，再 `swapUSDCForETH(usdcIn, minEthOut)`
 *
 * **minOut 的底線是畫面上顯示的「最低收到數量」**（`displayed.out` 打 DEFAULT_SLIPPAGE_BPS，
 * #220）：原本 approve 之後會重新 quote、再以新 quote 打 0.995 送出——價格在等簽名、等上鏈
 * 的期間變差時，使用者實際收到的會低於他確認過的最低收到數量，沒有提示也沒有中止。
 * 每次讀到即時 quote 後，實際送出的是 `sendMinOut(displayed.out, quoted)`：同時不低於即時
 * 報價的 99.5%（PR #223 M1/M2）。算出來是 0 就不送（`zeroMinOut`）。
 *
 * 送出前的檢查，全部在 approve **之前**：
 *
 * 1. 即時 quote 與儲備同一次讀：
 *    - `quotedOut` 超過輸出側庫存 → 停（舊版合約的 quote 不看庫存）。
 *    - `quotedOut` 低於 minOut → 「價格已變動」，停。
 * 2. USDC→ETH：讀 `balanceOf`，餘額不足就停。額度不足時模擬撞到的是額度不足，那個 revert
 *    會遮住餘額不足（OZ v5 先扣額度再轉帳），不先讀餘額就會白付一筆 approve。
 * 3. eth_call 模擬 swap（minOut 同上）。額度已足夠時這是完整模擬。額度不足時模擬一定會在
 *    transferFrom revert「額度不足」——那不算失敗：
 *      - 新版合約的 transferFrom 排在所有檢查（過期、滑點、池價偏離）之後，撞到額度不足
 *        代表前面的檢查都過了；撞到別的錯就是 approve 之後也必定失敗 → 不送 approve。
 *      - 舊版合約的 transferFrom 排在最前面，後面會失敗的條件是庫存與 minOut（第 1 點已擋）。
 *
 * approve 上鏈之後（等錢包簽名、等上鏈的這段時間價格可能已經動了）再讀一次即時 quote：
 * 低於畫面的最低收到數量就回「價格已變動」、不送 swap；否則以新的 `sendMinOut` 完整模擬，
 * 過了才送 swap（模擬與 swap 用同一個數字）。
 *
 * 重入：同一個 gateway 物件上一筆還沒結束時再呼叫，直接回 `busy`、什麼都不做。頁面另外以
 * busy 狀態停用按鈕、以 ref 擋連按（每次按下都會建新的 gateway，所以模組這層只是保險）。
 *
 * 使用者拒簽、RPC 斷線等「不是合約拒絕」的錯誤照舊往外丟，由呼叫端的 catch 處理。
 */
/** 正在跑 executeSwap 的 gateway（重入保護）。WeakSet：gateway 被丟掉就自動清掉。 */
const inFlight = new WeakSet<SwapGateway>()

export async function executeSwap(
  gateway: SwapGateway,
  caps: AmmCapabilities,
  displayed: DisplayedQuote,
  hooks: { onApproving?: () => void } = {},
): Promise<SwapResult> {
  if (inFlight.has(gateway)) return { ok: false, stage: 'busy', approved: false }
  inFlight.add(gateway)
  try {
    return await runSwap(gateway, caps, displayed, hooks)
  } finally {
    inFlight.delete(gateway)
  }
}

async function runSwap(
  gateway: SwapGateway,
  caps: AmmCapabilities,
  displayed: DisplayedQuote,
  hooks: { onApproving?: () => void },
): Promise<SwapResult> {
  const { isEthIn, amountIn } = displayed
  if (amountIn <= 0n || displayed.out <= 0n) {
    // 呼叫端的錯：沒有報價就沒有 minOut 可送（畫面上按鈕此時是停用的）。
    throw new Error('executeSwap: displayed quote must have a positive amountIn and out')
  }
  /** 畫面上的「最低收到數量」：即時 quote 低於它就是「價格已變動」。 */
  const minOut = minOutWithSlippage(displayed.out)

  const price = async (): Promise<{ quoted: bigint; inventory: InventoryCheck }> => {
    const [quoted, reserves] = await Promise.all([
      gateway.quote(isEthIn, amountIn),
      readOrNull(gateway.getReserves()),
    ])
    return { quoted, inventory: checkInventory(caps, isEthIn, quoted, reserves) }
  }
  type Stop = Extract<SwapResult, { stage: 'inventory' | 'priceMoved' | 'zeroMinOut' }>
  /**
   * 即時 quote 換不成（庫存）、低於畫面的最低收到（價格已變動）、或算出的 minOut 是 0
   * → 停下來的結果；否則 null。
   */
  const stopFor = (quoted: bigint, inventory: InventoryCheck, approved: boolean): Stop | null => {
    if (inventory.status === 'exceeded') {
      return { ok: false, stage: 'inventory', needed: inventory.needed, available: inventory.available, approved }
    }
    if (quoted < minOut) {
      return { ok: false, stage: 'priceMoved', displayed: displayed.out, quoted, minOut, approved }
    }
    if (sendMinOut(displayed.out, quoted) <= 0n) return { ok: false, stage: 'zeroMinOut', quoted, approved }
    return null
  }

  let { quoted, inventory } = await price()
  const before = stopFor(quoted, inventory, false)
  if (before) return before
  /** 實際送出（與模擬）的 minOut。每讀一次即時 quote 就重算。 */
  let sendMin = sendMinOut(displayed.out, quoted)

  let needsApproval = false
  if (!isEthIn) {
    const [balance, allowance] = await Promise.all([gateway.balance(), gateway.allowance()])
    if (balance < amountIn) return { ok: false, stage: 'balance', needed: amountIn, available: balance, approved: false }
    needsApproval = allowance < amountIn
  }
  try {
    await gateway.simulateSwap(isEthIn, amountIn, sendMin)
  } catch (error) {
    if (!(needsApproval && isAllowanceRevert(error))) {
      return { ok: false, stage: 'preflight', error, approved: false }
    }
  }

  if (needsApproval) {
    hooks.onApproving?.()
    const approveTx = await gateway.approve(amountIn)
    await approveTx.wait()

    ;({ quoted, inventory } = await price())
    const after = stopFor(quoted, inventory, true)
    if (after) return after
    sendMin = sendMinOut(displayed.out, quoted)
    try {
      await gateway.simulateSwap(isEthIn, amountIn, sendMin)
    } catch (error) {
      return { ok: false, stage: 'preflight', error, approved: true }
    }
  }

  const tx = await gateway.swap(isEthIn, amountIn, sendMin)
  await tx.wait()
  return { ok: true, quoted, minOut: sendMin, hash: tx.hash, approved: needsApproval }
}

// ── 4. 定時重讀＋回到前景立刻重讀 ───────────────────────────────────────────

/** 頁面傳 `document`；測試傳一個 EventTarget＋可改的 hidden。 */
export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * 每 `intervalMs` 呼叫一次 `refresh`；分頁在背景時跳過（不讀鏈）。分頁**回到前景時立刻**
 * 呼叫一次（#220）——原本要等下一次定時器，最多 15 秒畫面上都是背景前的舊報價。
 *
 * 回到前景時先呼叫 `onResume`（頁面把報價標成 pending：背景前的報價在新報價回來前不能
 * 拿來送出，PR #223 L3），再 `refresh`。回前景觸發的重讀有節流：距離上一次回前景重讀不到
 * `resumeThrottleMs` 就略過（快速來回切分頁不會打一串 RPC）——那時的報價本來就是剛讀的。
 * 回傳清除函式（給 useEffect 的 cleanup）。
 */
export function scheduleAmmRefresh(
  refresh: () => void,
  intervalMs: number,
  doc: VisibilitySource | null,
  opts: { onResume?: () => void; resumeThrottleMs?: number; now?: () => number } = {},
): () => void {
  const now = opts.now ?? (() => Date.now())
  const throttle = opts.resumeThrottleMs ?? 2_000
  let lastResume = -Infinity
  const timer = setInterval(() => {
    if (doc?.hidden) return
    refresh()
  }, intervalMs)
  const onVisibility = () => {
    if (!doc || doc.hidden) return
    const t = now()
    if (t - lastResume < throttle) return
    lastResume = t
    opts.onResume?.()
    refresh()
  }
  doc?.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    doc?.removeEventListener('visibilitychange', onVisibility)
  }
}
