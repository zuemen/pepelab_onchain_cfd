import { vi, it, expect, describe, afterEach } from 'vitest'

import en from 'src/locales/en'
import zhTW from 'src/locales/zh-TW'

import { prettyError } from './errorMessages'
import fixtures from './__fixtures__/ammBytecode.json'
import { priceImpactBps, minOutWithSlippage } from './ammQuote'
import {
  format18,
  type Cell,
  parseAmountIn,
  mergePoolReads,
  resolveLiveQuote,
  impactReference,
  buildSwapCardView,
  type SwapCardView,
  UNKNOWN_CAPABILITIES,
  detectAmmCapabilities,
} from './ammPoolView'
import {
  ammCacheKey,
  executeSwap,
  type AmmReader,
  loadAmmSnapshot,
  type SwapGateway,
  isAllowanceRevert,
  readQuoteSnapshot,
  type AmmCapsCache,
  sendMinOut,
  type DisplayedQuote,
  scheduleAmmRefresh,
  type VisibilitySource,
  ERC20_INSUFFICIENT_ALLOWANCE,
} from './ammSwapFlow'

// 這個檔測的是「頁面層級」的流程：假合約 → 讀取 → 畫面模型 → 送出。三種合約版本
// （線上舊版、原始碼新版、認不出來）各走一遍，全部在 node 裡跑，不碰任何鏈。

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n
const liveCode = fixtures['baseSepolia_0x93be44a81a2796d378f65ebcc8d5f8b40166ad63']
const v3Code = fixtures['compiled_v3_fdd94e4']
const KEY = ammCacheKey(84532, '0x93BE44a81a2796d378f65ebcc8d5f8b40166ad63')!

// #215 審查當天的線上實測值（Base Sepolia，唯讀）。
const LIVE = {
  ethReserve: 69213729059706683n, // 0.0692 ETH
  usdcReserve: 382725180400000000000n, // 382.73 USDC
  price8AtLoad: 268108000000n, // 作者快照：2681.08
  price8Later: 272005000000n, // 21 分鐘後：2720.05
}

/** 合約 revert 的樣子（ethers v6 的 CALL_EXCEPTION 形狀）。 */
function revert(name: string, data?: string) {
  return Object.assign(new Error(`execution reverted: ${name}`), {
    code: 'CALL_EXCEPTION',
    shortMessage: `execution reverted: "${name}"`,
    reason: name,
    data: data ?? null,
    revert: data ? null : { name },
  })
}
/** OZ v5 的 `ERC20InsufficientBalance(address,uint256,uint256)`。 */
const balanceRevert = () =>
  Object.assign(new Error('execution reverted (unknown custom error)'), {
    code: 'CALL_EXCEPTION',
    shortMessage: 'execution reverted (unknown custom error)',
    reason: null,
    revert: null,
    data: `0xe450d38c${'00'.repeat(96)}`,
  })
const allowanceRevert = () =>
  Object.assign(new Error('execution reverted (unknown custom error)'), {
    code: 'CALL_EXCEPTION',
    shortMessage: 'execution reverted (unknown custom error)',
    reason: null,
    revert: null,
    data: `${ERC20_INSUFFICIENT_ALLOWANCE}${'00'.repeat(96)}`,
  })

interface Fake {
  reader: AmmReader
  gateway: SwapGateway
  /** 依呼叫順序記下每一次讀寫。 */
  calls: string[]
  /** 真的送出的交易（approve / swap）。 */
  sent: { kind: 'approve' | 'swap'; args: bigint[]; value?: bigint }[]
  /** 畫面上會顯示的那筆報價（以目前狀態算，不記進 calls）。 */
  displayed(isEthIn: boolean, amountIn: bigint): DisplayedQuote
  state: {
    code: string | null
    price8: bigint
    updatedAt: bigint
    now: bigint
    eth: bigint
    usdc: bigint
    allowance: bigint
    /** 使用者錢包裡的 USDC。 */
    userUsdc: bigint
    codeFails: boolean
    oracleFails: boolean
    reservesFail: boolean
  }
}

/**
 * 假的 PepeAMM。`version` 決定行為，照合約原始碼寫：
 * - 'v2'（9030ff1，線上）：oracle 價 × 數量扣 0.3%，quote 不看庫存；swapUSDCForETH 的
 *   transferFrom 在最前面。沒有 oraclePrice() / maxOracleAge()（呼叫會 revert）。
 * - 'v3'（fdd94e4）：恆定乘積 + stale 檢查 + band；transferFrom 在所有檢查之後。
 */
function fakeAmm(version: 'v2' | 'v3', init: Partial<Fake['state']> = {}): Fake {
  const state: Fake['state'] = {
    code: version === 'v2' ? liveCode : v3Code,
    price8: LIVE.price8AtLoad,
    updatedAt: 1_000_000n,
    now: 1_000_600n,
    eth: LIVE.ethReserve,
    usdc: LIVE.usdcReserve,
    allowance: 0n,
    userUsdc: E(1_000_000),
    codeFails: false,
    oracleFails: false,
    reservesFail: false,
    ...init,
  }
  const calls: string[] = []
  const sent: Fake['sent'] = []
  const MAX_AGE = 3600n
  const MAX_DEV_BPS = 2000n

  const cpOut = (amountIn: bigint, rIn: bigint, rOut: bigint) => {
    const withFee = amountIn * 9970n
    return (withFee * rOut) / (rIn * 10_000n + withFee)
  }
  const quote = (isEthIn: boolean, amountIn: bigint): bigint => {
    if (version === 'v2') {
      const afterFee = (amountIn * 9970n) / 10_000n
      return isEthIn ? (afterFee * state.price8) / 10n ** 8n : (afterFee * 10n ** 8n) / state.price8
    }
    if (amountIn === 0n || state.eth === 0n || state.usdc === 0n) return 0n
    return isEthIn ? cpOut(amountIn, state.eth, state.usdc) : cpOut(amountIn, state.usdc, state.eth)
  }
  const dev = (pool8: bigint, ref8: bigint) => ((pool8 > ref8 ? pool8 - ref8 : ref8 - pool8) * 10_000n) / ref8

  /** 模擬 swap：通過就回傳輸出數量，不通過就丟 revert。`apply` 為 true 時才改狀態。 */
  const runSwap = (isEthIn: boolean, amountIn: bigint, minOut: bigint, apply: boolean): bigint => {
    const out = quote(isEthIn, amountIn)
    const reserveOut = isEthIn ? state.usdc : state.eth
    if (version === 'v2') {
      if (state.price8 === 0n) throw revert('invalid oracle price')
      if (!isEthIn && state.allowance < amountIn) throw allowanceRevert()
      if (!isEthIn && state.userUsdc < amountIn) throw balanceRevert()
      if (out < minOut) throw revert('InsufficientOutput')
      if (reserveOut < out) throw revert(`insufficient ${isEthIn ? 'USDC' : 'ETH'} reserve in pool`)
    } else {
      if (state.now > state.updatedAt + MAX_AGE) throw revert('StaleOraclePrice')
      if (out === 0n || out >= reserveOut) throw revert('InsufficientOutput')
      if (out < minOut) throw revert('InsufficientOutput')
      const newEth = isEthIn ? state.eth + amountIn : state.eth - out
      const newUsdc = isEthIn ? state.usdc - out : state.usdc + amountIn
      const post = dev((newUsdc * 10n ** 8n) / newEth, state.price8)
      if (post > MAX_DEV_BPS && post >= dev((state.usdc * 10n ** 8n) / state.eth, state.price8)) {
        throw revert('PriceOutOfBand')
      }
      if (!isEthIn && state.allowance < amountIn) throw allowanceRevert()
      if (!isEthIn && state.userUsdc < amountIn) throw balanceRevert()
    }
    if (apply) {
      if (isEthIn) {
        state.eth += amountIn
        state.usdc -= out
      } else {
        state.usdc += amountIn
        state.eth -= out
        state.allowance -= amountIn
        state.userUsdc -= amountIn
      }
    }
    return out
  }

  const read = <T,>(name: string, fn: () => T): Promise<T> => {
    calls.push(name)
    try {
      return Promise.resolve(fn())
    } catch (e) {
      return Promise.reject(e)
    }
  }
  const noSuchFunction = (): never => {
    throw revert('missing revert data')
  }

  const reader: AmmReader = {
    getCode: () =>
      read('getCode', () => {
        if (state.codeFails || state.code === null) throw new Error('rpc timeout')
        return state.code
      }),
    getPrice: () =>
      read('getPrice', () => (version === 'v2' ? state.price8 * 10n ** 10n : (state.usdc * 10n ** 18n) / state.eth)),
    getReserves: () =>
      read('getReserves', () => {
        if (state.reservesFail) throw new Error('rpc timeout')
        return [state.eth, state.usdc] as const
      }),
    oraclePrice: () =>
      read('oraclePrice', () => (version === 'v2' ? noSuchFunction() : ([state.price8 * 10n ** 10n, state.updatedAt] as const))),
    maxOracleAge: () => read('maxOracleAge', () => (version === 'v2' ? noSuchFunction() : MAX_AGE)),
    oracleEthPrice8: () =>
      read('oracleEthPrice8', () => {
        if (state.oracleFails) throw new Error('rpc timeout')
        return state.price8
      }),
    quote: (isEthIn, amountIn) => read('quote', () => quote(isEthIn, amountIn)),
  }

  const gateway: SwapGateway = {
    quote: reader.quote,
    getReserves: reader.getReserves,
    allowance: () => read('allowance', () => state.allowance),
    balance: () => read('balance', () => state.userUsdc),
    simulateSwap: (isEthIn, amountIn, minOut) => read('simulate', () => runSwap(isEthIn, amountIn, minOut, false)),
    approve: (amount) =>
      read('approve', () => {
        sent.push({ kind: 'approve', args: [amount] })
        return {
          hash: '0xapprove',
          wait: async () => {
            state.allowance = amount
          },
        }
      }),
    swap: (isEthIn, amountIn, minOut) =>
      read('swap', () => {
        sent.push(isEthIn ? { kind: 'swap', args: [minOut], value: amountIn } : { kind: 'swap', args: [amountIn, minOut] })
        runSwap(isEthIn, amountIn, minOut, true)
        return { hash: '0xswap', wait: async () => undefined }
      }),
  }

  const displayed = (isEthIn: boolean, amountIn: bigint): DisplayedQuote => ({ isEthIn, amountIn, out: quote(isEthIn, amountIn) })

  return { reader, gateway, calls, sent, state, displayed }
}

const count = (calls: string[], name: string) => calls.filter((c) => c === name).length

// ── loadAmmSnapshot ─────────────────────────────────────────────────────────

describe('loadAmmSnapshot —— 版本探測（#215 L1／L2／L3）', () => {
  it('L2：getCode 與其他讀取並行發出，不是先等 getCode 回來', () => {
    const amm = fakeAmm('v2')
    void loadAmmSnapshot(amm.reader, KEY, new Map())
    // 還沒 await 任何東西：所有讀取都已經送出。
    expect(amm.calls).toEqual(['getCode', 'getPrice', 'getReserves', 'oraclePrice', 'maxOracleAge', 'oracleEthPrice8'])
  })

  it('線上舊版：oracle-fixed，v3 才有的函式 revert 不會被當成「讀不到」', async () => {
    const amm = fakeAmm('v2')
    const snap = await loadAmmSnapshot(amm.reader, KEY, new Map())
    expect(snap.probe).toBe('fresh')
    expect(snap.caps).toEqual({ pricing: 'oracle-fixed', hasOraclePrice: false, hasMaxOracleAge: false })
    expect(snap.reads).toEqual({
      getPrice: 2681080000000000000000n,
      reserves: [LIVE.ethReserve, LIVE.usdcReserve],
      oraclePrice: null,
    })
    expect(snap.oracleUpdatedAt).toBe(0n)
    expect(snap.maxOracleAge).toBe(0n)
  })

  it('新版：banded-cp，帶回 oracle 參考價、updatedAt 與 maxOracleAge', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n })
    const snap = await loadAmmSnapshot(amm.reader, KEY, new Map())
    expect(snap.caps.pricing).toBe('banded-cp')
    expect(snap.reads.oraclePrice).toBe(E(2700))
    expect(snap.oracleUpdatedAt).toBe(1_000_000n)
    expect(snap.maxOracleAge).toBe(3600n)
  })

  it('L1：getCode 失敗 → 這次 unknown（probe=failed）且不快取；下次成功就認得', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2', { codeFails: true })
    const first = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(first.probe).toBe('failed')
    expect(first.caps).toEqual(UNKNOWN_CAPABILITIES)
    expect(cache.size).toBe(0)
    // 儲備照樣讀得到：版本不明不影響「池內儲備量」那一格。
    expect(first.reads.reserves).toEqual([LIVE.ethReserve, LIVE.usdcReserve])

    amm.state.codeFails = false
    const second = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(second.probe).toBe('fresh')
    expect(second.caps.pricing).toBe('oracle-fixed')
  })

  it('L1：判斷成功過一次之後，getCode 再失敗也保留上一次的判定（根本不再讀 bytecode）', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2')
    await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(count(amm.calls, 'getCode')).toBe(1)

    amm.state.codeFails = true
    const again = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(again.probe).toBe('cached')
    expect(again.caps.pricing).toBe('oracle-fixed')
    expect(count(amm.calls, 'getCode')).toBe(1)
  })

  it('版本已知之後，這一版沒有的函式不再呼叫；已確認的 oracle-fixed 也不再讀 oracle', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2')
    await loadAmmSnapshot(amm.reader, KEY, cache)
    amm.calls.length = 0
    await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(amm.calls).toEqual(['getPrice', 'getReserves'])
  })

  it('快取以 chainId＋位址為鍵：位址大小寫不同是同一把，別的鏈是另一把；chainId 不明就不快取', async () => {
    expect(ammCacheKey(84532, '0xABCDEF')).toBe(ammCacheKey(84532, '0xabcdef'))
    expect(ammCacheKey(84532, '0xabc')).not.toBe(ammCacheKey(11155111, '0xabc'))
    expect(ammCacheKey(null, '0xabc')).toBeNull()

    const amm = fakeAmm('v2')
    await loadAmmSnapshot(amm.reader, null, new Map())
    await loadAmmSnapshot(amm.reader, null, new Map())
    expect(count(amm.calls, 'getCode')).toBe(2)
  })

  it('L3：bytecode 像舊版，但 getPrice() 不等於 oracle × 1e10 → unknown，不標成 Oracle 定價', async () => {
    const cache: AmmCapsCache = new Map()
    // 掛著舊版 bytecode、行為卻是恆定乘積（getPrice() = 儲備比例）。
    const amm = fakeAmm('v3', { code: liveCode })
    const snap = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(snap.caps).toEqual(UNKNOWN_CAPABILITIES)
    expect(snap.probe).toBe('fresh')
    // 還沒確認過 → 下一輪會再讀 oracle 重新確認。
    amm.calls.length = 0
    await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(amm.calls).toContain('oracleEthPrice8')
    expect(amm.calls).not.toContain('getCode')
  })

  it('L3：oracle 讀不到 → 維持 bytecode 的判斷（已含「沒有 totalShares()」），下次再確認', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2', { oracleFails: true })
    const snap = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(snap.caps.pricing).toBe('oracle-fixed')
    expect(cache.get(KEY)?.oracleFixedConfirmed).toBe(false)

    amm.state.oracleFails = false
    await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(cache.get(KEY)?.oracleFixedConfirmed).toBe(true)
  })

  it('#220 審查 S8：oracle 剛好在 getPrice 與 oracle 兩次讀取之間更新 → 立刻重讀一次，不閃成 unknown', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2', { price8: LIVE.price8AtLoad })
    // 第一次讀 oracle 時 oracle 已經更新（getPrice 還是舊價）；之後兩者一致。
    const oracleRead = amm.reader.oracleEthPrice8
    let first = true
    amm.reader.oracleEthPrice8 = async () => {
      const v = await oracleRead()
      if (first) {
        first = false
        amm.state.price8 = LIVE.price8Later
        return LIVE.price8Later
      }
      return v
    }
    const snap = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(snap.caps.pricing).toBe('oracle-fixed')
    expect(cache.get(KEY)?.oracleFixedConfirmed).toBe(true)
    // 重讀的那一組（一致的值）也是畫面上的兌換價。
    expect(snap.reads.getPrice).toBe(LIVE.price8Later * 10n ** 10n)
    expect(count(amm.calls, 'getPrice')).toBe(2)
    expect(count(amm.calls, 'oracleEthPrice8')).toBe(2)
  })

  it('#220：一致時不多讀（只有第一次判定不相等才重讀）', async () => {
    const amm = fakeAmm('v2')
    await loadAmmSnapshot(amm.reader, KEY, new Map())
    expect(count(amm.calls, 'getPrice')).toBe(1)
    expect(count(amm.calls, 'oracleEthPrice8')).toBe(1)
  })

  it('#220：L3（真的不是 oracle 定價）重讀後仍不相等 → 照樣 unknown', async () => {
    const amm = fakeAmm('v3', { code: liveCode })
    const snap = await loadAmmSnapshot(amm.reader, KEY, new Map())
    expect(snap.caps).toEqual(UNKNOWN_CAPABILITIES)
    expect(count(amm.calls, 'oracleEthPrice8')).toBe(2)
  })

  it('PR #223 L1：第一次不相等、重讀卻讀不到（unverified）→ 維持 unknown，不判成 oracle-fixed', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2', { price8: LIVE.price8AtLoad })
    const oracleRead = amm.reader.oracleEthPrice8
    let n = 0
    amm.reader.oracleEthPrice8 = async () => {
      n += 1
      if (n === 1) return LIVE.price8Later // 與 getPrice 不相等
      throw new Error('rpc timeout') // 重讀失敗
    }
    const snap = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(snap.caps).toEqual(UNKNOWN_CAPABILITIES)
    expect(cache.get(KEY)?.oracleFixedConfirmed).toBe(false)
    // getPrice 重讀失敗也一樣。
    amm.reader.oracleEthPrice8 = oracleRead
    const amm2 = fakeAmm('v2', { price8: LIVE.price8AtLoad })
    const priceRead = amm2.reader.getPrice
    let m = 0
    amm2.reader.getPrice = async () => {
      m += 1
      if (m === 1) return LIVE.price8Later * 10n ** 10n
      throw new Error('rpc timeout')
    }
    expect((await loadAmmSnapshot(amm2.reader, KEY, new Map())).caps).toEqual(UNKNOWN_CAPABILITIES)
    amm2.reader.getPrice = priceRead
  })

  it('不像 PepeAMM 的 bytecode → unknown（probe=fresh，不是 failed），也不快取', async () => {
    const cache: AmmCapsCache = new Map()
    const amm = fakeAmm('v2', { code: '0x6080604052' })
    const snap = await loadAmmSnapshot(amm.reader, KEY, cache)
    expect(snap.caps).toEqual(UNKNOWN_CAPABILITIES)
    expect(snap.probe).toBe('fresh')
    expect(cache.size).toBe(0)
  })
})

// ── readQuoteSnapshot ───────────────────────────────────────────────────────

describe('readQuoteSnapshot —— 基準與 quote 同一次讀取（#215 M1）', () => {
  const ETH_IN = E(1) / 100n // 0.01 ETH
  const USDC_IN = E(100)

  it('quote 與基準在同一輪發出（Promise.all），不是先後兩輪', () => {
    const amm = fakeAmm('v2')
    void readQuoteSnapshot(amm.reader, detectAmmCapabilities(liveCode), true, ETH_IN)
    expect(amm.calls).toEqual(['quote', 'getPrice', 'getReserves'])

    const cp = fakeAmm('v3', { eth: E(10), usdc: E(27_000) })
    void readQuoteSnapshot(cp.reader, detectAmmCapabilities(v3Code), true, ETH_IN)
    // 恆定乘積版的基準是儲備；getPrice() 用不到，所以不讀。
    expect(cp.calls).toEqual(['quote', 'getReserves', 'oraclePrice'])
  })

  it('審查重現：頁面放 21 分鐘，oracle 從 2681.08 走到 2720.05——舊做法 0.00%／1.73%，新做法兩向都是手續費', async () => {
    const amm = fakeAmm('v2')
    const atLoad = await loadAmmSnapshot(amm.reader, KEY, new Map())
    amm.state.price8 = LIVE.price8Later

    // 舊做法：即時 quote 對上頁面載入時的基準。
    const staleImpact = async (isEthIn: boolean, amountIn: bigint) => {
      const out = await amm.reader.quote(isEthIn, amountIn)
      return priceImpactBps({ amountIn, amountOut: out, ...impactReference(atLoad.caps, isEthIn, atLoad.reads)! })
    }
    expect(await staleImpact(true, ETH_IN)).toBe(0) // #165 的「0.00%」
    expect(await staleImpact(false, USDC_IN)).toBe(173) // 粗體警告色的 1.73%

    // 新做法：基準和 quote 一起讀。
    const ethIn = await readQuoteSnapshot(amm.reader, atLoad.caps, true, ETH_IN)
    expect(ethIn.impactBps).toBe(30)
    expect(ethIn.reads.getPrice).toBe(2720050000000000000000n)
    expect(format18(ethIn.out, 4)).toBe('27.1189')
    const usdcIn = await readQuoteSnapshot(amm.reader, atLoad.caps, false, USDC_IN)
    expect(usdcIn.impactBps).toBeGreaterThanOrEqual(30)
    expect(usdcIn.impactBps).toBeLessThanOrEqual(31)

    // 畫面上的「兌換價」用的是同一次讀到的值，不是載入時的 2681.08。
    const view = buildSwapCardView({
      probing: false,
      caps: atLoad.caps,
      reads: mergePoolReads(atLoad.reads, ethIn.reads),
      isEthIn: true,
      live: { status: 'ready', quote: ethIn },
      oracleStale: false,
      busy: false,
    })
    expect(view.pool.oracleRate).toEqual({ kind: 'value', text: '2720.05' })
    expect(view.impactBps).toBe(30)
  })

  it('恆定乘積版：基準是同一次讀到的儲備，別人動過池子也不會拿舊儲備算衝擊', async () => {
    const caps = detectAmmCapabilities(v3Code)
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n })
    const before = await readQuoteSnapshot(amm.reader, caps, true, E(1) / 10n)
    // 有人賣了 1 ETH 進池子，池價下跌。
    amm.state.eth = E(11)
    amm.state.usdc = E(24_552)
    const after = await readQuoteSnapshot(amm.reader, caps, true, E(1) / 10n)
    expect(after.reads.reserves).toEqual([E(11), E(24_552)])
    expect(after.out).toBeLessThan(before.out)
    // 0.1 ETH 進 11 ETH 的池子：0.3% 手續費 + 約 0.9% 滑點。
    expect(after.impactBps).toBeGreaterThan(100)
    expect(after.impactBps).toBeLessThan(130)
    expect(after.oracleUpdatedAt).toBe(1_000_000n)
  })

  it('基準讀不到 → 不顯示衝擊（null），不退回舊值；庫存狀態 unknown', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), reservesFail: true })
    const q = await readQuoteSnapshot(amm.reader, detectAmmCapabilities(v3Code), true, E(1))
    expect(q.impactBps).toBeNull()
    expect(q.reads.reserves).toBeNull()
    expect(q.inventory).toEqual({ status: 'unknown' })
  })

  it('版本不明 → 沒有衝擊，但報價與庫存檢查照常', async () => {
    const amm = fakeAmm('v2')
    const q = await readQuoteSnapshot(amm.reader, UNKNOWN_CAPABILITIES, true, ETH_IN)
    expect(q.impactBps).toBeNull()
    expect(q.out).toBeGreaterThan(0n)
    expect(q.inventory).toEqual({ status: 'ok' })
    expect(amm.calls).toEqual(['quote', 'getReserves'])
  })

  it('quote 本身失敗 → reject（呼叫端顯示空白）', async () => {
    const amm = fakeAmm('v2')
    amm.reader.quote = () => Promise.reject(revert('InsufficientLiquidity'))
    await expect(readQuoteSnapshot(amm.reader, detectAmmCapabilities(liveCode), true, ETH_IN)).rejects.toThrow()
  })

  it('M2：舊版 0.2 ETH 報出 542.38 USDC，超過庫存 382.73 → inventory exceeded', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const q = await readQuoteSnapshot(amm.reader, detectAmmCapabilities(liveCode), true, E(2) / 10n)
    expect(format18(q.out, 2)).toBe('542.38')
    expect(q.inventory).toEqual({ status: 'exceeded', needed: q.out, available: LIVE.usdcReserve })
  })
})

// ── executeSwap ─────────────────────────────────────────────────────────────

describe('executeSwap —— 必定失敗就一筆交易都不送（#215 M2）', () => {
  const v2caps = detectAmmCapabilities(liveCode)
  const v3caps = detectAmmCapabilities(v3Code)

  it('舊版 ETH→USDC 超過庫存：停在庫存檢查，沒有模擬、沒有交易', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(true, E(2) / 10n))
    expect(r).toMatchObject({ ok: false, stage: 'inventory', available: LIVE.usdcReserve, approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).toEqual(['quote', 'getReserves'])
  })

  it('舊版 USDC→ETH 超過庫存：擋在 approve 之前（審查重現：超過約 188 USDC 就會先送 approve 才失敗）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    let approving = 0
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(false, E(300)), { onApproving: () => { approving += 1 } })
    expect(r).toMatchObject({ ok: false, stage: 'inventory', available: LIVE.ethReserve, approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).not.toContain('approve')
    expect(approving).toBe(0)
  })

  it('舊版 USDC→ETH、額度不足、庫存足夠：讀餘額 → 模擬撞到「額度不足」不算失敗 → approve → 再 quote、再模擬 → swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    let approving = 0
    const shown = amm.displayed(false, E(100))
    const r = await executeSwap(amm.gateway, v2caps, shown, { onApproving: () => { approving += 1 } })
    expect(r.ok).toBe(true)
    expect(amm.calls).toEqual([
      'quote', 'getReserves', 'balance', 'allowance', 'simulate',
      'approve',
      'quote', 'getReserves', 'simulate',
      'swap',
    ])
    expect(approving).toBe(1)
    // approve(amm, usdcIn)、swapUSDCForETH(usdcIn, 畫面報價 × 0.995)。
    const quoted = (((E(100) * 9970n) / 10_000n) * 10n ** 8n) / LIVE.price8Later
    expect(shown.out).toBe(quoted)
    expect(amm.sent).toEqual([
      { kind: 'approve', args: [E(100)] },
      { kind: 'swap', args: [E(100), minOutWithSlippage(quoted)] },
    ])
    expect(r).toMatchObject({ ok: true, quoted, minOut: minOutWithSlippage(quoted), hash: '0xswap', approved: true })
  })

  it('額度已足夠：不送 approve，模擬過了才送 swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(false, E(100)))
    expect(r).toMatchObject({ ok: true, approved: false })
    expect(amm.calls).toEqual(['quote', 'getReserves', 'balance', 'allowance', 'simulate', 'swap'])
    expect(amm.sent.map((s) => s.kind)).toEqual(['swap'])
  })

  it('ETH→USDC：不讀額度與 USDC 餘額；送出 swapETHForUSDC(畫面報價 × 0.995, { value })', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const ethIn = E(1) / 100n
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(true, ethIn))
    const quoted = (((ethIn * 9970n) / 10_000n) * LIVE.price8Later) / 10n ** 8n
    expect(r).toMatchObject({ ok: true, quoted, approved: false })
    expect(amm.calls).toEqual(['quote', 'getReserves', 'simulate', 'swap'])
    expect(amm.sent).toEqual([{ kind: 'swap', args: [minOutWithSlippage(quoted)], value: ethIn }])
  })

  it('新版 USDC→ETH、額度不足、但會被 PriceOutOfBand 拒絕：模擬撞到的不是額度不足 → 不送 approve', async () => {
    // 池價 2700、oracle 2000：池子已經偏高 35%，再買 ETH（USDC→ETH）只會更偏。
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 200000000000n, allowance: 0n })
    const r = await executeSwap(amm.gateway, v3caps, amm.displayed(false, E(500)))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).toEqual(['quote', 'getReserves', 'balance', 'allowance', 'simulate'])
    if (!r.ok && r.stage === 'preflight') {
      expect(prettyError(r.error)).toBe(zhTW.errors.contract.PriceOutOfBand)
    }
  })

  it('新版 USDC→ETH、額度不足、oracle 已過期：StaleOraclePrice → 不送 approve', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n, now: 1_010_000n })
    const r = await executeSwap(amm.gateway, v3caps, amm.displayed(false, E(100)))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
  })

  it('新版 USDC→ETH、額度不足、其他檢查都過：撞到額度不足 → approve → swap', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n, allowance: 0n })
    const r = await executeSwap(amm.gateway, v3caps, amm.displayed(false, E(100)))
    expect(r).toMatchObject({ ok: true, approved: true })
    expect(amm.sent.map((s) => s.kind)).toEqual(['approve', 'swap'])
  })

  it('新版 ETH→USDC 會被 PriceOutOfBand 拒絕（審查 Info：0.01 ETH 進 0.069 ETH 的池）→ 不送交易', async () => {
    // 池價 5529、oracle 2720：池子偏高一倍多；賣 ETH 會把池價往 oracle 拉 → 允許。
    // 反過來 oracle 在 9000：池價偏低，再賣 ETH 更偏 → 拒絕。
    const amm = fakeAmm('v3', { price8: 900000000000n })
    const r = await executeSwap(amm.gateway, v3caps, amm.displayed(true, E(1) / 100n))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
  })

  /** 讓 approve 上鏈的那一刻改動狀態（模擬等簽名、等上鏈期間發生的事）。 */
  const onApproveMined = (amm: Fake, change: () => void) => {
    const approve = amm.gateway.approve
    amm.gateway.approve = async (amount) => {
      const tx = await approve(amount)
      return { hash: tx.hash, wait: async () => { await tx.wait(); change() } }
    }
  }

  it('approve 之後池子庫存被換走：不送 swap，並回報「批准已完成」', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    onApproveMined(amm, () => { amm.state.eth = 1n })
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(false, E(100)))
    expect(r).toMatchObject({ ok: false, stage: 'inventory', approved: true })
    expect(amm.sent.map((s) => s.kind)).toEqual(['approve'])
  })

  it('#220 審查 S5 重現：approve 之後 oracle 翻倍（USDC→ETH 報價剩一半）→「價格已變動」，不送 swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8AtLoad, allowance: 0n })
    const shown = amm.displayed(false, E(20))
    onApproveMined(amm, () => { amm.state.price8 = LIVE.price8AtLoad * 2n })
    const ethBefore = amm.state.eth
    const r = await executeSwap(amm.gateway, v2caps, shown)
    const halved = (((E(20) * 9970n) / 10_000n) * 10n ** 8n) / (LIVE.price8AtLoad * 2n)
    expect(r).toEqual({
      ok: false,
      stage: 'priceMoved',
      displayed: shown.out,
      quoted: halved,
      minOut: minOutWithSlippage(shown.out),
      approved: true,
    })
    // 只送了 approve；swap 一次都沒呼叫（舊行為會以 halved × 0.995 成交）。
    expect(amm.sent.map((s) => s.kind)).toEqual(['approve'])
    expect(amm.calls).not.toContain('swap')
    expect(amm.calls.slice(-2)).toEqual(['quote', 'getReserves'])
    expect(amm.state.eth).toBe(ethBefore)
  })

  it('#220／PR #223 M2：approve 之後價格變好 → 成交，minOut 跟著提高到即時報價 × 0.995（不停在畫面的舊底線）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    const shown = amm.displayed(false, E(100))
    onApproveMined(amm, () => { amm.state.price8 = LIVE.price8AtLoad }) // ETH 變便宜 → 換到更多 ETH
    const r = await executeSwap(amm.gateway, v2caps, shown)
    const fresh = (((E(100) * 9970n) / 10_000n) * 10n ** 8n) / LIVE.price8AtLoad
    expect(fresh > shown.out).toBe(true)
    expect(r).toMatchObject({ ok: true, quoted: fresh, minOut: minOutWithSlippage(fresh) })
    expect(amm.sent[1]).toEqual({ kind: 'swap', args: [E(100), minOutWithSlippage(fresh)] })
  })

  it('#220：approve 之後輕微變差、仍在 0.5% 容忍內 → 成交，minOut 不變', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    const shown = amm.displayed(false, E(100))
    onApproveMined(amm, () => { amm.state.price8 = (LIVE.price8Later * 10_030n) / 10_000n }) // ETH 漲 0.3%
    const r = await executeSwap(amm.gateway, v2caps, shown)
    expect(r).toMatchObject({ ok: true, minOut: minOutWithSlippage(shown.out) })
    if (r.ok) expect(r.quoted < shown.out && r.quoted >= minOutWithSlippage(shown.out)).toBe(true)
    expect(amm.sent[1]).toEqual({ kind: 'swap', args: [E(100), minOutWithSlippage(shown.out)] })
  })

  it('#220：按下之前價格已經變差（超過容忍）→「價格已變動」，連 approve 都不送', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8AtLoad, allowance: 0n })
    const shown = amm.displayed(false, E(100))
    amm.state.price8 = (LIVE.price8AtLoad * 101n) / 100n // ETH 漲 1%
    const r = await executeSwap(amm.gateway, v2caps, shown)
    expect(r).toMatchObject({ ok: false, stage: 'priceMoved', approved: false, displayed: shown.out })
    expect(amm.sent).toEqual([])
    expect(amm.calls).toEqual(['quote', 'getReserves'])
  })

  it('#220：ETH→USDC（不需 approve）同樣以畫面報價的 minOut 送出；價格變差超過容忍就不送', async () => {
    const ethIn = E(1) / 100n
    // 變好：成交，minOut = 即時報價 × 0.995（高於畫面的底線）。
    const up = fakeAmm('v2', { price8: LIVE.price8AtLoad })
    const shownUp = up.displayed(true, ethIn)
    up.state.price8 = LIVE.price8Later
    const liveUp = up.displayed(true, ethIn).out
    const ok = await executeSwap(up.gateway, v2caps, shownUp)
    expect(ok).toMatchObject({ ok: true, minOut: minOutWithSlippage(liveUp) })
    expect(up.sent).toEqual([{ kind: 'swap', args: [minOutWithSlippage(liveUp)], value: ethIn }])
    // 變差 1%：不送。
    const down = fakeAmm('v2', { price8: LIVE.price8Later })
    const shownDown = down.displayed(true, ethIn)
    down.state.price8 = (LIVE.price8Later * 99n) / 100n
    const moved = await executeSwap(down.gateway, v2caps, shownDown)
    expect(moved).toMatchObject({ ok: false, stage: 'priceMoved', approved: false })
    expect(down.sent).toEqual([])
  })

  // ── PR #223 審查 M1／M2：minOut = max(畫面報價 × 0.995, 即時報價 × 0.995) ──────────

  it('sendMinOut：取兩者 × 0.995 的較大值；兩者都太小就是 0', () => {
    expect(sendMinOut(E(100), E(50))).toBe(minOutWithSlippage(E(100)))
    expect(sendMinOut(E(50), E(100))).toBe(minOutWithSlippage(E(100)))
    expect(sendMinOut(1n, E(1))).toBe(minOutWithSlippage(E(1)))
    expect(sendMinOut(1n, 1n)).toBe(0n)
  })

  /** 讓 swap 送出的那一刻（模擬已過、上鏈之前）改動狀態：簽名期間被夾擊／價格回彈。 */
  const beforeSwapMined = (amm: Fake, change: () => void) => {
    const swap = amm.gateway.swap
    amm.gateway.swap = async (e, a, m) => {
      change()
      return swap(e, a, m)
    }
  }

  it('審查 d1：畫面報價是舊的、即時大幅變好（oracle −30%）→ 以即時報價 × 0.995 為 minOut 成交，容忍度不會變成 30%', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const stale = amm.displayed(false, E(20))
    amm.state.price8 = (LIVE.price8Later * 70n) / 100n
    const live = amm.displayed(false, E(20)).out
    const r = await executeSwap(amm.gateway, v2caps, stale)
    expect(r).toMatchObject({ ok: true, quoted: live, minOut: minOutWithSlippage(live) })
    expect(amm.sent).toEqual([{ kind: 'swap', args: [E(20), minOutWithSlippage(live)] }])
    expect(minOutWithSlippage(live) > minOutWithSlippage(stale.out)).toBe(true)
  })

  it('審查 d2：同 d1，但送 swap 前一刻價格回彈到原價 → swap 被 minOut 擋下（不會只拿到即時報價的 70%）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const stale = amm.displayed(false, E(20))
    amm.state.price8 = (LIVE.price8Later * 70n) / 100n
    const live = amm.displayed(false, E(20)).out
    beforeSwapMined(amm, () => { amm.state.price8 = LIVE.price8Later })
    const ethBefore = amm.state.eth
    await expect(executeSwap(amm.gateway, v2caps, stale)).rejects.toThrow('InsufficientOutput')
    expect(amm.sent).toEqual([{ kind: 'swap', args: [E(20), minOutWithSlippage(live)] }])
    expect(amm.state.eth).toBe(ethBefore) // 沒有成交
  })

  it('審查 e1：displayed.out = 1 wei（minOut 0）→ 仍以即時報價 × 0.995 送出，不是 0', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const live = amm.displayed(false, E(20)).out
    const r = await executeSwap(amm.gateway, v2caps, { isEthIn: false, amountIn: E(20), out: 1n })
    expect(r).toMatchObject({ ok: true, minOut: minOutWithSlippage(live) })
    expect(amm.sent).toEqual([{ kind: 'swap', args: [E(20), minOutWithSlippage(live)] }])
  })

  it('審查 e1x：displayed.out = 1 wei、送 swap 前 oracle ×10（ETH 只剩 1/10）→ swap 被擋下，不會成交', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    beforeSwapMined(amm, () => { amm.state.price8 = LIVE.price8Later * 10n })
    const ethBefore = amm.state.eth
    await expect(executeSwap(amm.gateway, v2caps, { isEthIn: false, amountIn: E(20), out: 1n })).rejects.toThrow('InsufficientOutput')
    expect(amm.sent[0].args[1] > 0n).toBe(true)
    expect(amm.state.eth).toBe(ethBefore)
  })

  it('審查 e3：ETH→USDC displayed.out = 1 wei、送 swap 前 oracle ÷10 → swap 被擋下', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const live = amm.displayed(true, E(1) / 100n).out
    beforeSwapMined(amm, () => { amm.state.price8 = LIVE.price8Later / 10n })
    const usdcBefore = amm.state.usdc
    await expect(executeSwap(amm.gateway, v2caps, { isEthIn: true, amountIn: E(1) / 100n, out: 1n })).rejects.toThrow('InsufficientOutput')
    expect(amm.sent).toEqual([{ kind: 'swap', args: [minOutWithSlippage(live)], value: E(1) / 100n }])
    expect(amm.state.usdc).toBe(usdcBefore)
  })

  it('M1：算出的 minOut 是 0（金額小到報價打 0.5% 後為 0）→ zeroMinOut，不模擬、不送任何交易', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    // 1 wei ETH → quote 0；畫面報價 1 wei → minOut 0。
    const r = await executeSwap(amm.gateway, v2caps, { isEthIn: true, amountIn: 1n, out: 1n })
    expect(r).toEqual({ ok: false, stage: 'zeroMinOut', quoted: 0n, approved: false })
    expect(amm.calls).toEqual(['quote', 'getReserves'])
    expect(amm.sent).toEqual([])
    for (const catalog of [zhTW, en]) expect(catalog.exchange.tx.zeroMinOut).toBeTruthy()
  })

  it('模擬與 swap 用同一個 minOut（sendMin）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const stale = amm.displayed(false, E(20))
    amm.state.price8 = (LIVE.price8Later * 90n) / 100n
    const sims: bigint[] = []
    const sim = amm.gateway.simulateSwap
    amm.gateway.simulateSwap = (e, a, m) => { sims.push(m); return sim(e, a, m) }
    const r = await executeSwap(amm.gateway, v2caps, stale)
    expect(r.ok).toBe(true)
    expect(sims).toEqual([amm.sent[0].args[1]])
  })

  it('重入保護：同一個 gateway 上一筆還沒結束 → 第二次呼叫回 busy、什麼都不做；結束後可以再呼叫', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const shown = amm.displayed(true, E(1) / 100n)
    const [a, b] = await Promise.all([
      executeSwap(amm.gateway, v2caps, shown),
      executeSwap(amm.gateway, v2caps, shown),
    ])
    expect(a.ok).toBe(true)
    expect(b).toEqual({ ok: false, stage: 'busy', approved: false })
    expect(amm.sent.map((x) => x.kind)).toEqual(['swap'])
    // 第一筆結束後鎖已釋放；即使上一筆丟錯也會釋放。
    const again = await executeSwap(amm.gateway, v2caps, amm.displayed(true, E(1) / 100n))
    expect(again.ok).toBe(true)
    const swap = amm.gateway.swap
    amm.gateway.swap = () => Promise.reject(new Error('user rejected action'))
    await expect(executeSwap(amm.gateway, v2caps, amm.displayed(true, E(1) / 100n))).rejects.toThrow('user rejected')
    amm.gateway.swap = swap
    expect((await executeSwap(amm.gateway, v2caps, amm.displayed(true, E(1) / 100n))).ok).toBe(true)
  })

  it('#220 L：USDC 餘額不足、額度也不足 → 讀 balanceOf 就停，不送 approve（審查 S6／V5）', async () => {
    for (const [version, caps, init] of [
      ['v2', v2caps, { price8: LIVE.price8Later }],
      ['v3', v3caps, { eth: E(10), usdc: E(27_000), price8: 270000000000n }],
    ] as const) {
      const amm = fakeAmm(version, { ...init, allowance: 0n, userUsdc: E(5) })
      let approving = 0
      const r = await executeSwap(amm.gateway, caps, amm.displayed(false, E(20)), { onApproving: () => { approving += 1 } })
      expect(r).toEqual({ ok: false, stage: 'balance', needed: E(20), available: E(5), approved: false })
      expect(amm.sent).toEqual([])
      expect(approving).toBe(0)
      expect(amm.calls).toEqual(['quote', 'getReserves', 'balance', 'allowance'])
    }
  })

  it('#220 L：額度足夠但餘額不足 → 同樣停在 balance，不模擬、不送 swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000), userUsdc: 0n })
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(false, E(20)))
    expect(r).toMatchObject({ ok: false, stage: 'balance', available: 0n })
    expect(amm.sent).toEqual([])
    expect(amm.calls).not.toContain('simulate')
  })

  it('額度足夠時模擬卻撞到「額度不足」→ 當成失敗（不會無條件放行這個錯誤）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    amm.gateway.simulateSwap = () => Promise.reject(allowanceRevert())
    const r = await executeSwap(amm.gateway, v2caps, amm.displayed(false, E(100)))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
  })

  it('畫面上沒有可用的報價（out = 0）→ 直接丟錯，不會以 minOut 0 送出', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    await expect(executeSwap(amm.gateway, v2caps, { isEthIn: true, amountIn: E(1), out: 0n })).rejects.toThrow('displayed quote')
    await expect(executeSwap(amm.gateway, v2caps, { isEthIn: true, amountIn: 0n, out: E(1) })).rejects.toThrow('displayed quote')
    expect(amm.calls).toEqual([])
  })

  it('舊版合約的 require 字串有對應的說明（不會落到提到保證金的那句通用訊息）', () => {
    for (const catalog of [zhTW, en]) {
      expect(catalog.errors.contract['reserve in pool']).toBeTruthy()
    }
    expect(prettyError(revert('insufficient USDC reserve in pool'))).toBe(zhTW.errors.contract['reserve in pool'])
    expect(prettyError(revert('insufficient ETH reserve in pool'))).toBe(zhTW.errors.contract['reserve in pool'])
    expect(prettyError(revert('invalid oracle price'))).toBe(zhTW.errors.contract['invalid oracle price'])
  })

  it('使用者拒簽等非合約錯誤照舊往外丟', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    amm.gateway.swap = () => Promise.reject(Object.assign(new Error('user rejected action'), { code: 'ACTION_REJECTED' }))
    await expect(executeSwap(amm.gateway, v2caps, amm.displayed(true, E(1) / 100n))).rejects.toThrow('user rejected')
  })

  it('「價格已變動」的兩句話都帶報價、最低收到與幣別（zh-TW 與 en）', () => {
    for (const catalog of [zhTW, en]) {
      for (const k of ['priceMoved', 'priceMovedAfterApprove'] as const) {
        expect(catalog.exchange.tx[k]).toContain('{quoted}')
        expect(catalog.exchange.tx[k]).toContain('{minOut}')
        expect(catalog.exchange.tx[k]).toContain('{token}')
      }
      expect(catalog.exchange.tx.priceMoved).not.toBe(catalog.exchange.tx.priceMovedAfterApprove)
    }
  })
})

// ── 定時重讀＋回到前景立刻重讀（#220）────────────────────────────────────────

describe('scheduleAmmRefresh —— 背景不讀、回到前景立刻讀（#220）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  class FakeDoc extends EventTarget implements VisibilitySource {
    hidden = false
    set(hidden: boolean) {
      this.hidden = hidden
      this.dispatchEvent(new Event('visibilitychange'))
    }
  }

  it('前景每 15 秒一次；背景跳過；回到前景立刻一次；切到背景不讀', () => {
    vi.useFakeTimers()
    const doc = new FakeDoc()
    let n = 0
    const stop = scheduleAmmRefresh(() => { n += 1 }, 15_000, doc)
    vi.advanceTimersByTime(15_000)
    expect(n).toBe(1)

    doc.set(true) // 切到背景
    expect(n).toBe(1)
    vi.advanceTimersByTime(32_000) // 審查 H：背景 32 秒
    expect(n).toBe(1)

    doc.set(false) // 回到前景：不等下一次定時器
    expect(n).toBe(2)

    stop()
    vi.advanceTimersByTime(60_000)
    doc.set(true)
    doc.set(false)
    expect(n).toBe(2) // 卸載後不再讀（審查 I）
  })

  it('PR #223 L3：回前景先呼叫 onResume（頁面把報價標成 pending）再重讀；回前景的重讀有節流', () => {
    vi.useFakeTimers()
    const doc = new FakeDoc()
    const order: string[] = []
    let t = 100_000
    const stop = scheduleAmmRefresh(() => order.push('refresh'), 15_000, doc, {
      onResume: () => order.push('resume'),
      resumeThrottleMs: 2_000,
      now: () => t,
    })
    doc.set(true)
    doc.set(false)
    expect(order).toEqual(['resume', 'refresh'])
    // 1 秒內快速來回切 5 次：都在節流內，不再重讀。
    for (let i = 0; i < 5; i++) {
      t += 200
      doc.set(true)
      doc.set(false)
    }
    expect(order).toEqual(['resume', 'refresh'])
    t += 2_000
    doc.set(true)
    doc.set(false)
    expect(order).toEqual(['resume', 'refresh', 'resume', 'refresh'])
    // 切到背景不觸發任何東西。
    doc.set(true)
    expect(order).toHaveLength(4)
    stop()
  })

  it('沒有 document（SSR／測試）→ 只有定時器', () => {
    vi.useFakeTimers()
    let n = 0
    const stop = scheduleAmmRefresh(() => { n += 1 }, 15_000, null)
    vi.advanceTimersByTime(45_000)
    expect(n).toBe(3)
    stop()
  })
})

// ── 報價與輸入金額對齊（#220）──────────────────────────────────────────────

describe('報價只認目前方向＋目前金額（#220，審查 UI G）', () => {
  const v2caps = detectAmmCapabilities(liveCode)

  /** 走頁面的同一條路：輸入字串 → parseAmountIn → resolveLiveQuote → buildSwapCardView。 */
  const viewFor = (slot: Parameters<typeof resolveLiveQuote>[0], isEthIn: boolean, typed: string) =>
    buildSwapCardView({
      probing: false,
      caps: v2caps,
      reads: { getPrice: null, reserves: [LIVE.ethReserve, LIVE.usdcReserve], oraclePrice: null },
      isEthIn,
      live: resolveLiveQuote(slot, isEthIn, parseAmountIn(typed)),
      oracleStale: false,
      busy: false,
    })

  it('30 → 60：60 的報價回來之前，不顯示 30 的收到數量／衝擊／最低收到，按鈕停用', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const q30 = await readQuoteSnapshot(amm.reader, v2caps, false, E(30))
    const slot30 = { isEthIn: false, amountIn: E(30), quote: q30 }

    const at30 = viewFor(slot30, false, '30')
    expect(at30.receive).toBe(q30.out)
    expect(at30.button).toEqual({ disabled: false, label: 'swap' })

    // 輸入框已經是 60，state 裡還是 30 的報價。
    const typing = viewFor(slot30, false, '60')
    expect(typing.quotePending).toBe(true)
    expect(typing.receive).toBeNull()
    expect(typing.impactBps).toBeNull()
    expect(typing.minReceivedBase).toBeNull()
    expect(typing.button).toEqual({ disabled: true, label: 'quoting' })
    expect(cardText(typing, zhTW).button).toBe('取得報價中…')

    const q60 = await readQuoteSnapshot(amm.reader, v2caps, false, E(60))
    const at60 = viewFor({ isEthIn: false, amountIn: E(60), quote: q60 }, false, '60')
    expect(at60.quotePending).toBe(false)
    expect(at60.receive).toBe(q60.out)
    expect(at60.minReceivedBase).toBe(q60.out)
    expect(at60.button.label).toBe('swap')
  })

  it('遲到的舊回應（10）就算寫進了 state，也不會在輸入 30 時顯示', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const q10 = await readQuoteSnapshot(amm.reader, v2caps, false, E(10))
    const v = viewFor({ isEthIn: false, amountIn: E(10), quote: q10 }, false, '30')
    expect(v.receive).toBeNull()
    expect(v.button.label).toBe('quoting')
  })

  it('同金額寫法不同（"30" 與 "30.0"）是同一筆；方向不同不是', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const q = await readQuoteSnapshot(amm.reader, v2caps, false, E(30))
    const slot = { isEthIn: false, amountIn: E(30), quote: q }
    expect(viewFor(slot, false, '30.0').receive).toBe(q.out)
    expect(viewFor(slot, true, '30').receive).toBeNull()
  })

  it('這組金額的 quote 失敗 → 「無法取得報價」，按鈕停用（不是一直顯示讀取中）', () => {
    const v = viewFor({ isEthIn: true, amountIn: E(1), quote: null }, true, '1')
    expect(v.quotePending).toBe(false)
    expect(v.receive).toBeNull()
    expect(v.button).toEqual({ disabled: true, label: 'quoteUnavailable' })
    for (const catalog of [zhTW, en]) {
      expect(catalog.exchange.swap.quoting).toBeTruthy()
      expect(catalog.exchange.swap.quoteUnavailable).toBeTruthy()
    }
  })

  it('PR #223 M1：報價極小（1 wei，最低收到為 0）→「金額太小」，按鈕停用、不顯示最低收到', () => {
    const v = viewFor(
      { isEthIn: true, amountIn: 1n, quote: { isEthIn: true, amountIn: 1n, out: 1n, impactBps: null, inventory: { status: 'ok' } } },
      true,
      '0.000000000000000001',
    )
    expect(v.button).toEqual({ disabled: true, label: 'amountTooSmall' })
    expect(v.minReceivedBase).toBeNull()
    expect(cardText(v, zhTW).button).toBe('金額太小')
    expect(cardText(v, en).button).toBe('Amount too small')
  })

  it('PR #223 L3：報價放太久（超過 maxAgeMs）→ pending，按鈕停用', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const q = await readQuoteSnapshot(amm.reader, v2caps, true, E(1))
    const slot = { isEthIn: true, amountIn: E(1), quote: q, fetchedAt: 1_000 }
    expect(resolveLiveQuote(slot, true, E(1), { now: 20_000, maxAgeMs: 30_000 }).status).toBe('ready')
    expect(resolveLiveQuote(slot, true, E(1), { now: 40_000, maxAgeMs: 30_000 }).status).toBe('pending')
    // 沒有時間戳卻要求新鮮度 → 不採用。
    expect(resolveLiveQuote({ ...slot, fetchedAt: undefined }, true, E(1), { now: 0, maxAgeMs: 30_000 }).status).toBe('pending')
  })

  it('輸入不是有效金額（空、0、格式錯、超過 18 位小數）→ 請輸入金額', () => {
    for (const typed of ['', '0', '0.0', 'abc', '1e5', '-1', '0.0000000000000000001', '.']) {
      expect(viewFor(null, true, typed).button.label, typed).toBe('enterAmount')
    }
  })
})

describe('isAllowanceRevert', () => {
  it('認得 OZ v5 的 custom error（線上 MockUSDC 實際回傳的資料）', () => {
    const data =
      '0xfb8f41b200000000000000000000000093be44a81a2796d378f65ebcc8d5f8b40166ad63' +
      '0000000000000000000000000000000000000000000000000000000000000000' +
      '0000000000000000000000000000000000000000000000000de0b6b3a7640000'
    expect(isAllowanceRevert({ data })).toBe(true)
    expect(isAllowanceRevert({ info: { error: { data } } })).toBe(true)
    expect(isAllowanceRevert({ error: { data: data.toUpperCase().replace('0X', '0x') } })).toBe(true)
    expect(isAllowanceRevert({ revert: { name: 'ERC20InsufficientAllowance' } })).toBe(true)
  })

  it('認得 OZ v4 的 require 字串', () => {
    expect(isAllowanceRevert({ reason: 'ERC20: insufficient allowance' })).toBe(true)
    expect(isAllowanceRevert({ shortMessage: 'execution reverted: "ERC20: transfer amount exceeds allowance"' })).toBe(true)
  })

  it('其他 revert 與非物件都不是', () => {
    expect(isAllowanceRevert(revert('PriceOutOfBand'))).toBe(false)
    expect(isAllowanceRevert({ data: '0xe450d38c' })).toBe(false) // ERC20InsufficientBalance
    expect(isAllowanceRevert(null)).toBe(false)
    expect(isAllowanceRevert(undefined)).toBe(false)
    expect(isAllowanceRevert('allowance')).toBe(false)
  })
})

// ── 頁面層級：三種合約版本的整張兌換卡（#215 L4）──────────────────────────────

/**
 * 走 ExchangePage 的同一條路：載入（loadAmmSnapshot）→ 輸入金額（readQuoteSnapshot）→
 * 畫面模型（buildSwapCardView）→ 查 catalog 變成畫面上的字。
 */
async function renderCard(amm: Fake, input: { isEthIn: boolean; amountIn: bigint | null; now?: number }) {
  const snap = await loadAmmSnapshot(amm.reader, KEY, new Map())
  const quote = input.amountIn === null ? null : await readQuoteSnapshot(amm.reader, snap.caps, input.isEthIn, input.amountIn)
  const updatedAt = quote?.oracleUpdatedAt ?? snap.oracleUpdatedAt
  const now = BigInt(input.now ?? Number(amm.state.now))
  const view = buildSwapCardView({
    probing: false,
    caps: snap.caps,
    reads: quote ? mergePoolReads(snap.reads, quote.reads) : snap.reads,
    isEthIn: input.isEthIn,
    live: quote ? { status: 'ready', quote } : { status: 'noAmount' },
    oracleStale: snap.maxOracleAge > 0n && updatedAt > 0n && now - updatedAt > snap.maxOracleAge,
    busy: false,
  })
  return { snap, view, text: cardText(view, zhTW) }
}

/** 頁面把畫面模型的 key 換成字的那一步（與 ExchangePage 的 JSX 對應）。 */
function cardText(view: SwapCardView, catalog: typeof zhTW) {
  const s = catalog.exchange.swap
  const cell = (c: Cell) => {
    if (c.kind === 'unsupported') return null
    if (c.kind === 'value') return `1 ETH = ${c.text}`
    return c.kind === 'loading' ? s.loadingValue : s.unavailable
  }
  return {
    badge: view.badge ? s[view.badge] : null,
    poolPrice: cell(view.pool.poolPrice),
    oracleRate: cell(view.pool.oracleRate),
    oracleRef: cell(view.pool.oracleRef),
    reservesLabel: s[view.reservesLabel],
    note: view.notes.map((k) => s[k]).join(' '),
    button: view.button.label === 'swap' ? s.ethToToken : s[view.button.label],
  }
}

describe('兌換卡整體（頁面層級）—— 舊版／新版／unknown（#215 L4）', () => {
  it('舊版（線上 oracle 定價合約）：兌換價、庫存、0.30% 衝擊、無 Oracle 參考價', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const { view, text } = await renderCard(amm, { isEthIn: true, amountIn: E(1) / 100n })
    expect(text).toEqual({
      badge: zhTW.exchange.swap.oracleFixedBadge,
      poolPrice: null, // 不顯示「池內現價」
      oracleRate: '1 ETH = 2720.05',
      oracleRef: null, // 這一版沒有 oraclePrice()，整列不顯示
      reservesLabel: '池內可兌出庫存',
      note: zhTW.exchange.swap.oracleFixedNote,
      button: zhTW.exchange.swap.ethToToken,
    })
    expect(view.pool.reserves).toEqual({ kind: 'value', eth: '0.0692', usdc: '382.73' })
    expect(format18(view.receive!, 2)).toBe('27.12')
    expect(view.impactBps).toBe(30)
    expect(view.button.disabled).toBe(false)
  })

  it('舊版、金額超過庫存：不顯示換不到的數字，按鈕停用並寫明「超過池內可兌出庫存」', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const { view, text } = await renderCard(amm, { isEthIn: true, amountIn: E(2) / 10n })
    expect(text.button).toBe('超過池內可兌出庫存')
    expect(view.button.disabled).toBe(true)
    expect(view.receive).toBeNull()
    expect(view.minReceivedBase).toBeNull()
    expect(format18(view.inventoryExceeded!.needed, 2)).toBe('542.38')
    expect(format18(view.inventoryExceeded!.available, 2)).toBe('382.73')
    // USDC→ETH 同理（審查：超過約 188 USDC）。
    const back = await renderCard(amm, { isEthIn: false, amountIn: E(200) })
    expect(back.view.button).toEqual({ disabled: true, label: 'exceedsInventory' })
    const fits = await renderCard(amm, { isEthIn: false, amountIn: E(180) })
    expect(fits.view.button).toEqual({ disabled: false, label: 'swap' })
  })

  it('新版（恆定乘積 + band）：池內現價由儲備算出、另列 Oracle 參考價、有滑點', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 271000000000n })
    const { view, text } = await renderCard(amm, { isEthIn: true, amountIn: E(1) })
    expect(text).toEqual({
      badge: zhTW.exchange.swap.poolBadge,
      poolPrice: '1 ETH = 2700.00',
      oracleRate: null,
      oracleRef: '1 ETH = 2710.00',
      reservesLabel: '池內儲備量',
      note: zhTW.exchange.swap.constantProductNote,
      button: zhTW.exchange.swap.ethToToken,
    })
    expect(view.pool.reserves).toEqual({ kind: 'value', eth: '10.0000', usdc: '27000.00' })
    // 1 ETH 進 10 ETH 的池子：約 9% 滑點 + 0.3% 手續費。
    expect(view.impactBps).toBeGreaterThan(900)
    expect(view.impactBps).toBeLessThan(960)
    expect(view.button).toEqual({ disabled: false, label: 'swap' })
  })

  it('新版、oracle 過期：按鈕停用並顯示過期', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 271000000000n, now: 1_010_000n })
    const { view, text } = await renderCard(amm, { isEthIn: true, amountIn: E(1) })
    expect(view.button).toEqual({ disabled: true, label: 'oracleStale' })
    expect(text.button).toBe(zhTW.exchange.swap.oracleStale)
  })

  it('unknown（bytecode 認不出來）：不掛徽章、不顯示價格與衝擊，但報價與儲備照常', async () => {
    const amm = fakeAmm('v2', { code: '0x6080604052', price8: LIVE.price8Later })
    const { snap, view, text } = await renderCard(amm, { isEthIn: true, amountIn: E(1) / 100n })
    expect(snap.probe).toBe('fresh')
    expect(text).toEqual({
      badge: null,
      poolPrice: zhTW.exchange.swap.unavailable,
      oracleRate: null,
      oracleRef: zhTW.exchange.swap.unavailable,
      reservesLabel: '池內儲備量',
      note: zhTW.exchange.swap.unknownVersionNote,
      button: zhTW.exchange.swap.ethToToken,
    })
    expect(view.impactBps).toBeNull()
    expect(format18(view.receive!, 2)).toBe('27.12')
    expect(view.pool.reserves).toEqual({ kind: 'value', eth: '0.0692', usdc: '382.73' })
    expect(view.button.disabled).toBe(false)
  })

  it('unknown（getCode 讀不到）：畫面同上，probe 標成 failed 讓下一輪重試', async () => {
    const amm = fakeAmm('v2', { codeFails: true })
    const { snap, text } = await renderCard(amm, { isEthIn: true, amountIn: null })
    expect(snap.probe).toBe('failed')
    expect(text.note).toBe(zhTW.exchange.swap.unknownVersionNote)
    expect(text.button).toBe(zhTW.exchange.swap.enterAmount)
  })

  it('還在探測時的說明與「無法確認」是兩句不同的話（zh-TW 與 en 都是）', () => {
    for (const catalog of [zhTW, en]) {
      const s = catalog.exchange.swap
      expect(s.checkingVersionNote).toBeTruthy()
      expect(s.checkingVersionNote).not.toBe(s.unknownVersionNote)
      expect(s.loadingValue).not.toBe(s.unavailable)
    }
    const loading = buildSwapCardView({
      probing: true,
      caps: UNKNOWN_CAPABILITIES,
      reads: { getPrice: null, reserves: null, oraclePrice: null },
      isEthIn: true,
      live: { status: 'noAmount' },
      oracleStale: false,
      busy: false,
    })
    expect(cardText(loading, zhTW)).toMatchObject({
      badge: null,
      poolPrice: '讀取中…',
      note: '正在確認線上合約版本…',
    })
  })

  it('畫面模型用到的每一個 key 在兩份 catalog 都有字', () => {
    const keys = [
      'oracleFixedBadge', 'poolBadge', 'poolInventory', 'poolReserves',
      'oracleFixedNote', 'constantProductNote', 'noOracleRefNote', 'unknownVersionNote', 'checkingVersionNote',
      'swapping', 'oracleStale', 'enterAmount', 'exceedsInventory', 'exceedsInventoryDetail',
      'loadingValue', 'unavailable',
    ] as const
    for (const catalog of [zhTW, en]) {
      for (const k of keys) expect(catalog.exchange.swap[k], k).toBeTruthy()
      expect(catalog.exchange.swap.exceedsInventoryDetail).toContain('{needed}')
      expect(catalog.exchange.swap.exceedsInventoryDetail).toContain('{available}')
      expect(catalog.exchange.tx.preflightBlocked).toContain('{reason}')
      expect(catalog.exchange.tx.preflightBlockedAfterApprove).toContain('{reason}')
    }
  })
})
