import { id } from 'ethers'
import { it, expect, describe } from 'vitest'

import { priceImpactBps } from './ammQuote'
import fixtures from './__fixtures__/ammBytecode.json'
import {
  format18,
  AMM_SELECTORS,
  impactReference,
  reservePrice18,
  buildPoolInfoView,
  UNKNOWN_CAPABILITIES,
  detectAmmCapabilities,
} from './ammPoolView'

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n

// #165 實測值（Base Sepolia，eth_call 唯讀，block 47534004 附近）。
const LIVE = {
  ethReserve:  69213729059706683n,        // 0.0692 ETH
  usdcReserve: 382725180400000000000n,    // 382.73 USDC
  getPrice:    2681080000000000000000n,   // 2681.08 —— 是 oracle 報價，不是儲備比例
  quote001Eth: 26730367600000000000n,     // quoteETHForUSDC(0.01 ETH)
  quote100Usd: 37186506930043116n,        // quoteUSDCForETH(100 USDC)
}

const liveCode = fixtures['baseSepolia_0x93be44a81a2796d378f65ebcc8d5f8b40166ad63']
const v3Code = fixtures['compiled_v3_fdd94e4']

describe('AMM_SELECTORS', () => {
  it('每個 selector 都等於函式簽章的 keccak 前 4 bytes', () => {
    const sigs: Record<keyof typeof AMM_SELECTORS, string> = {
      getPrice: 'getPrice()',
      getReserves: 'getReserves()',
      oracle: 'oracle()',
      oraclePrice: 'oraclePrice()',
      maxOracleAge: 'maxOracleAge()',
    }
    for (const [k, sig] of Object.entries(sigs)) {
      expect(AMM_SELECTORS[k as keyof typeof AMM_SELECTORS]).toBe(id(sig).slice(0, 10))
    }
  })

  it('沒有一個以 0x00 開頭（PUSH4 掃描的已知限制）', () => {
    for (const s of Object.values(AMM_SELECTORS)) expect(s.startsWith('0x00')).toBe(false)
  })
})

describe('detectAmmCapabilities', () => {
  it('線上 Base Sepolia PepeAMM 是 oracle-fixed 舊版：沒有 oraclePrice()、沒有 maxOracleAge()', () => {
    expect(detectAmmCapabilities(liveCode)).toEqual({
      pricing: 'oracle-fixed',
      hasOraclePrice: false,
      hasMaxOracleAge: false,
    })
  })

  it('目前原始碼（fdd94e4）編出的 bytecode 是 banded-cp', () => {
    expect(detectAmmCapabilities(v3Code)).toEqual({
      pricing: 'banded-cp',
      hasOraclePrice: true,
      hasMaxOracleAge: true,
    })
  })

  it('沒有 oracle() 也沒有 oraclePrice() → 最早的純恆定乘積版', () => {
    // 只留 getPrice / getReserves 兩個 dispatcher 分支的極簡 bytecode。
    const code = `0x60806040${'63' + AMM_SELECTORS.getPrice.slice(2)}14${'63' + AMM_SELECTORS.getReserves.slice(2)}14`
    expect(detectAmmCapabilities(code).pricing).toBe('plain-cp')
  })

  it('讀不到、沒部署、或不像 PepeAMM → unknown', () => {
    expect(detectAmmCapabilities(null)).toEqual(UNKNOWN_CAPABILITIES)
    expect(detectAmmCapabilities('0x')).toEqual(UNKNOWN_CAPABILITIES)
    expect(detectAmmCapabilities('0x6080604052')).toEqual(UNKNOWN_CAPABILITIES)
  })
})

describe('reservePrice18', () => {
  it('與合約 getPrice() 同一條公式：usdcReserve * 1e18 / ethReserve', () => {
    const p = reservePrice18(LIVE.ethReserve, LIVE.usdcReserve)!
    expect(format18(p, 2)).toBe('5529.61')
  })

  it('任一側為 0 → null，不是 0', () => {
    expect(reservePrice18(0n, E(1))).toBeNull()
    expect(reservePrice18(E(1), 0n)).toBeNull()
  })
})

describe('buildPoolInfoView —— 線上舊版（#165 的實際畫面）', () => {
  const caps = detectAmmCapabilities(liveCode)
  const view = buildPoolInfoView(caps, {
    getPrice: LIVE.getPrice,
    reserves: [LIVE.ethReserve, LIVE.usdcReserve],
    oraclePrice: null,
  })

  it('getPrice() 標成「依 Oracle 的兌換價」，而不是「池內現價」', () => {
    expect(view.oracleRate).toEqual({ kind: 'value', text: '2681.08' })
    expect(view.poolPrice).toEqual({ kind: 'unsupported' })
  })

  it('合約沒有 oraclePrice() → Oracle 參考價欄不顯示（unsupported），不是「—」或 0', () => {
    expect(view.oracleRef).toEqual({ kind: 'unsupported' })
  })

  it('儲備量照實顯示', () => {
    expect(view.reserves).toEqual({ kind: 'value', eth: '0.0692', usdc: '382.73' })
  })

  it('getPrice() 讀不到 → 兌換價顯示「無法取得」', () => {
    const v = buildPoolInfoView(caps, { getPrice: null, reserves: null, oraclePrice: null })
    expect(v.oracleRate).toEqual({ kind: 'unavailable' })
    expect(v.reserves).toEqual({ kind: 'unavailable' })
  })
})

describe('buildPoolInfoView —— 新版恆定乘積池', () => {
  const caps = detectAmmCapabilities(v3Code)

  it('池內現價由儲備算出，與儲備量必然一致（不理會 getPrice() 給什麼）', () => {
    const view = buildPoolInfoView(caps, {
      getPrice: E(9999), // 故意給一個對不上的值：畫面不可以用它
      reserves: [E(10), E(30_000)],
      oraclePrice: E(3010),
    })
    expect(view.poolPrice).toEqual({ kind: 'value', text: '3000.00' })
    expect(view.oracleRef).toEqual({ kind: 'value', text: '3010.00' })
    expect(view.oracleRate).toEqual({ kind: 'unsupported' })
  })

  it('oraclePrice() 讀不到 → 「無法取得」，不是空白或 0', () => {
    const view = buildPoolInfoView(caps, { getPrice: E(3000), reserves: [E(10), E(30_000)], oraclePrice: null })
    expect(view.oracleRef).toEqual({ kind: 'unavailable' })
    const zero = buildPoolInfoView(caps, { getPrice: E(3000), reserves: [E(10), E(30_000)], oraclePrice: 0n })
    expect(zero.oracleRef).toEqual({ kind: 'unavailable' })
  })

  it('儲備讀不到或為 0 → 池內現價「無法取得」', () => {
    expect(buildPoolInfoView(caps, { getPrice: E(3000), reserves: null, oraclePrice: E(3000) }).poolPrice)
      .toEqual({ kind: 'unavailable' })
    expect(buildPoolInfoView(caps, { getPrice: 0n, reserves: [0n, 0n], oraclePrice: E(3000) }).poolPrice)
      .toEqual({ kind: 'unavailable' })
  })
})

describe('buildPoolInfoView —— 版本不明', () => {
  it('價格一律「無法取得」，不拿意義不明的 getPrice() 充數', () => {
    const view = buildPoolInfoView(UNKNOWN_CAPABILITIES, {
      getPrice: LIVE.getPrice,
      reserves: [LIVE.ethReserve, LIVE.usdcReserve],
      oraclePrice: null,
    })
    expect(view.poolPrice).toEqual({ kind: 'unavailable' })
    expect(view.oracleRef).toEqual({ kind: 'unavailable' })
    expect(view.oracleRate).toEqual({ kind: 'unsupported' })
  })
})

describe('impactReference + priceImpactBps', () => {
  const live = detectAmmCapabilities(liveCode)
  const reads = { getPrice: LIVE.getPrice, reserves: [LIVE.ethReserve, LIVE.usdcReserve] as const }

  it('舊做法（以儲備比例當中價）在線上合約會算出假數字——這是 #165 的「0.00%」', () => {
    // USDC→ETH：成交價優於「儲備中價」→ 被夾成 0
    expect(priceImpactBps({
      amountIn: E(100), amountOut: LIVE.quote100Usd,
      reserveIn: LIVE.usdcReserve, reserveOut: LIVE.ethReserve,
    })).toBe(0)
    // ETH→USDC：同一個合約、同一個 0.3% 手續費，卻算出 50% 以上的「衝擊」
    expect(priceImpactBps({
      amountIn: E(1) / 100n, amountOut: LIVE.quote001Eth,
      reserveIn: LIVE.ethReserve, reserveOut: LIVE.usdcReserve,
    })).toBeGreaterThan(5000)
  })

  it('oracle-fixed 版以 oracle 價為中價 → 兩個方向都只剩 0.30% 手續費', () => {
    const ethIn = impactReference(live, true, reads)!
    expect(priceImpactBps({ amountIn: E(1) / 100n, amountOut: LIVE.quote001Eth, ...ethIn })).toBe(30)
    const usdcIn = impactReference(live, false, reads)!
    const bps = priceImpactBps({ amountIn: E(100), amountOut: LIVE.quote100Usd, ...usdcIn })!
    expect(bps).toBeGreaterThanOrEqual(30)
    expect(bps).toBeLessThanOrEqual(31) // 整數除法捨入
  })

  it('恆定乘積版沿用儲備比例', () => {
    const cp = detectAmmCapabilities(v3Code)
    expect(impactReference(cp, true, { getPrice: null, reserves: [E(10), E(30_000)] }))
      .toEqual({ reserveIn: E(10), reserveOut: E(30_000) })
    expect(impactReference(cp, false, { getPrice: null, reserves: [E(10), E(30_000)] }))
      .toEqual({ reserveIn: E(30_000), reserveOut: E(10) })
  })

  it('缺資料或版本不明 → null（不顯示衝擊，而不是顯示 0%）', () => {
    expect(impactReference(live, true, { getPrice: null, reserves: null })).toBeNull()
    expect(impactReference(detectAmmCapabilities(v3Code), true, { getPrice: E(1), reserves: null })).toBeNull()
    expect(impactReference(UNKNOWN_CAPABILITIES, true, reads)).toBeNull()
  })
})
