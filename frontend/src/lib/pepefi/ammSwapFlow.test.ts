import { it, expect, describe } from 'vitest'

import en from 'src/locales/en'
import zhTW from 'src/locales/zh-TW'

import { prettyError } from './errorMessages'
import fixtures from './__fixtures__/ammBytecode.json'
import { priceImpactBps, minOutWithSlippage } from './ammQuote'
import {
  format18,
  type Cell,
  mergePoolReads,
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
  state: {
    code: string | null
    price8: bigint
    updatedAt: bigint
    now: bigint
    eth: bigint
    usdc: bigint
    allowance: bigint
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
    }
    if (apply) {
      if (isEthIn) {
        state.eth += amountIn
        state.usdc -= out
      } else {
        state.usdc += amountIn
        state.eth -= out
        state.allowance -= amountIn
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

  return { reader, gateway, calls, sent, state }
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
      hasAmount: true,
      quote: ethIn,
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
    const r = await executeSwap(amm.gateway, v2caps, true, E(2) / 10n)
    expect(r).toMatchObject({ ok: false, stage: 'inventory', available: LIVE.usdcReserve, approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).toEqual(['quote', 'getReserves'])
  })

  it('舊版 USDC→ETH 超過庫存：擋在 approve 之前（審查重現：超過約 188 USDC 就會先送 approve 才失敗）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    let approving = 0
    const r = await executeSwap(amm.gateway, v2caps, false, E(300), { onApproving: () => { approving += 1 } })
    expect(r).toMatchObject({ ok: false, stage: 'inventory', available: LIVE.ethReserve, approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).not.toContain('approve')
    expect(approving).toBe(0)
  })

  it('舊版 USDC→ETH、額度不足、庫存足夠：模擬撞到「額度不足」不算失敗 → approve → 再模擬 → swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    let approving = 0
    const r = await executeSwap(amm.gateway, v2caps, false, E(100), { onApproving: () => { approving += 1 } })
    expect(r.ok).toBe(true)
    expect(amm.calls).toEqual([
      'quote', 'getReserves', 'allowance', 'simulate',
      'approve',
      'quote', 'getReserves', 'simulate',
      'swap',
    ])
    expect(approving).toBe(1)
    // 送出的參數與原本的 doSwap 相同：approve(amm, usdcIn)、swapUSDCForETH(usdcIn, quote × 0.995)。
    const quoted = (((E(100) * 9970n) / 10_000n) * 10n ** 8n) / LIVE.price8Later
    expect(amm.sent).toEqual([
      { kind: 'approve', args: [E(100)] },
      { kind: 'swap', args: [E(100), minOutWithSlippage(quoted)] },
    ])
    expect(r).toMatchObject({ ok: true, quoted, hash: '0xswap', approved: true })
  })

  it('額度已足夠：不送 approve，模擬過了才送 swap', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    const r = await executeSwap(amm.gateway, v2caps, false, E(100))
    expect(r).toMatchObject({ ok: true, approved: false })
    expect(amm.calls).toEqual(['quote', 'getReserves', 'allowance', 'simulate', 'swap'])
    expect(amm.sent.map((s) => s.kind)).toEqual(['swap'])
  })

  it('ETH→USDC：不讀額度；送出 swapETHForUSDC(quote × 0.995, { value })', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later })
    const ethIn = E(1) / 100n
    const r = await executeSwap(amm.gateway, v2caps, true, ethIn)
    const quoted = (((ethIn * 9970n) / 10_000n) * LIVE.price8Later) / 10n ** 8n
    expect(r).toMatchObject({ ok: true, quoted, approved: false })
    expect(amm.calls).toEqual(['quote', 'getReserves', 'simulate', 'swap'])
    expect(amm.sent).toEqual([{ kind: 'swap', args: [minOutWithSlippage(quoted)], value: ethIn }])
  })

  it('新版 USDC→ETH、額度不足、但會被 PriceOutOfBand 拒絕：模擬撞到的不是額度不足 → 不送 approve', async () => {
    // 池價 2700、oracle 2000：池子已經偏高 35%，再買 ETH（USDC→ETH）只會更偏。
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 200000000000n, allowance: 0n })
    const r = await executeSwap(amm.gateway, v3caps, false, E(500))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
    expect(amm.calls).toEqual(['quote', 'getReserves', 'allowance', 'simulate'])
    if (!r.ok && r.stage === 'preflight') {
      expect(prettyError(r.error)).toBe(zhTW.errors.contract.PriceOutOfBand)
    }
  })

  it('新版 USDC→ETH、額度不足、oracle 已過期：StaleOraclePrice → 不送 approve', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n, now: 1_010_000n })
    const r = await executeSwap(amm.gateway, v3caps, false, E(100))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
  })

  it('新版 USDC→ETH、額度不足、其他檢查都過：撞到額度不足 → approve → swap', async () => {
    const amm = fakeAmm('v3', { eth: E(10), usdc: E(27_000), price8: 270000000000n, allowance: 0n })
    const r = await executeSwap(amm.gateway, v3caps, false, E(100))
    expect(r).toMatchObject({ ok: true, approved: true })
    expect(amm.sent.map((s) => s.kind)).toEqual(['approve', 'swap'])
  })

  it('新版 ETH→USDC 會被 PriceOutOfBand 拒絕（審查 Info：0.01 ETH 進 0.069 ETH 的池）→ 不送交易', async () => {
    // 池價 5529、oracle 2720：池子偏高一倍多；賣 ETH 會把池價往 oracle 拉 → 允許。
    // 反過來 oracle 在 9000：池價偏低，再賣 ETH 更偏 → 拒絕。
    const amm = fakeAmm('v3', { price8: 900000000000n })
    const r = await executeSwap(amm.gateway, v3caps, true, E(1) / 100n)
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
  })

  it('approve 之後價格動了、模擬不過：不送 swap，並回報「批准已完成」', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: 0n })
    const approve = amm.gateway.approve
    amm.gateway.approve = async (amount) => {
      const tx = await approve(amount)
      return {
        hash: tx.hash,
        wait: async () => {
          await tx.wait()
          // 等上鏈的期間，池子的 ETH 被別人換走，庫存不夠了。
          amm.state.eth = 1n
        },
      }
    }
    const r = await executeSwap(amm.gateway, v2caps, false, E(100))
    expect(r).toMatchObject({ ok: false, stage: 'inventory', approved: true })
    expect(amm.sent.map((s) => s.kind)).toEqual(['approve'])
  })

  it('approve 之後重新 quote：minOut 以新的報價為準，不是 approve 前的舊報價', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8AtLoad, allowance: 0n })
    const approve = amm.gateway.approve
    amm.gateway.approve = async (amount) => {
      const tx = await approve(amount)
      return { hash: tx.hash, wait: async () => { await tx.wait(); amm.state.price8 = LIVE.price8Later } }
    }
    const r = await executeSwap(amm.gateway, v2caps, false, E(100))
    const fresh = (((E(100) * 9970n) / 10_000n) * 10n ** 8n) / LIVE.price8Later
    expect(r).toMatchObject({ ok: true, quoted: fresh })
    expect(amm.sent[1]).toEqual({ kind: 'swap', args: [E(100), minOutWithSlippage(fresh)] })
  })

  it('額度足夠時模擬卻撞到「額度不足」→ 當成失敗（不會無條件放行這個錯誤）', async () => {
    const amm = fakeAmm('v2', { price8: LIVE.price8Later, allowance: E(1000) })
    amm.gateway.simulateSwap = () => Promise.reject(allowanceRevert())
    const r = await executeSwap(amm.gateway, v2caps, false, E(100))
    expect(r).toMatchObject({ ok: false, stage: 'preflight', approved: false })
    expect(amm.sent).toEqual([])
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
    await expect(executeSwap(amm.gateway, v2caps, true, E(1) / 100n)).rejects.toThrow('user rejected')
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
    hasAmount: input.amountIn !== null,
    quote,
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
      hasAmount: false,
      quote: null,
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
