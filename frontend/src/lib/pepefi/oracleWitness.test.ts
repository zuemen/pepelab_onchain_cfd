import { it, expect, describe } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import {
  ageUnit,
  priceAgeSec,
  deviationBps,
  deviationLevel,
  buildWitnessRows,
  loadOnchainQuotes,
  fetchReferencePrices,
  parseReferenceReport,
} from './oracleWitness'

const T = 1_791_258_460

const REPORT = {
  ok: true,
  generatedAt: T,
  assets: {
    sAAPL: {
      symbol: 'sAAPL',
      singleSource: false,
      okCount: 1,
      spreadBps: null,
      sources: [
        { provider: 'yahoo', ticker: 'AAPL', role: 'keeper-primary', price: 332.89, quoteTime: T - 30_000, fetchedAt: T },
        { provider: 'nasdaq', ticker: 'AAPL', role: 'independent', price: null, quoteTime: null, fetchedAt: T, error: 'timeout' },
      ],
    },
    sBTC: {
      symbol: 'sBTC',
      singleSource: false,
      okCount: 2,
      spreadBps: 1,
      sources: [
        { provider: 'coingecko', ticker: 'bitcoin', role: 'keeper-primary', price: 85_500, quoteTime: T - 10, fetchedAt: T },
        { provider: 'coinbase', ticker: 'BTC-USD', role: 'independent', price: 85_510, quoteTime: null, fetchedAt: T },
        { provider: 'evil', ticker: 'X', role: 'independent', price: 1, quoteTime: null, fetchedAt: T },
      ],
    },
  },
}

describe('鏈上報價', () => {
  it('8 位小數價格與寫入時間；單一資產讀不到只讓那一檔 failed', async () => {
    const snap = await loadOnchainQuotes(
      {
        getPrice: async (id) => {
          if (id === ASSET_IDS.sTSLA) throw new Error('revert')
          return [33_289_000_000n, BigInt(T - 600)] as const
        },
        latestBlockTime: async () => T,
        maxPriceAge: async () => 21_600n,
      },
      ['sAAPL', 'sTSLA']
    )
    expect(snap.quotes.sAAPL).toEqual({ status: 'ok', price: 332.89, updatedAt: T - 600 })
    expect(snap.quotes.sTSLA).toEqual({ status: 'failed', price: null, updatedAt: null })
    expect(snap.blockTime).toBe(T)
    expect(snap.maxPriceAge).toBe(21_600)
  })

  it('區塊時間讀不到 → null（呼叫端改用本機時鐘並標示）；價格 0 視為讀取失敗', async () => {
    const snap = await loadOnchainQuotes(
      {
        getPrice: async () => [0n, 0n] as const,
        latestBlockTime: () => Promise.reject(new Error('rpc')),
      },
      ['sAAPL']
    )
    expect(snap.blockTime).toBeNull()
    expect(snap.maxPriceAge).toBeNull()
    expect(snap.quotes.sAAPL.status).toBe('failed')
  })

  it('priceAgeSec 用區塊時間；任何一邊缺就是 null', () => {
    expect(priceAgeSec(T, T - 600)).toBe(600)
    expect(priceAgeSec(T, T + 5)).toBe(0)
    expect(priceAgeSec(null, T)).toBeNull()
    expect(priceAgeSec(T, null)).toBeNull()
  })
})

describe('鏈下參考價', () => {
  it('parseReferenceReport 丟掉形狀不對的來源，價格非正數為 null', () => {
    const r = parseReferenceReport(REPORT)
    expect(r).not.toBeNull()
    expect(r!.assets.sBTC.sources.map((s) => s.provider)).toEqual(['coingecko', 'coinbase'])
    expect(r!.assets.sAAPL.okCount).toBe(1)
    expect(r!.assets.sAAPL.sources[1].error).toBe('timeout')
    expect(parseReferenceReport({ ok: false, error: 'x' })).toBeNull()
    expect(parseReferenceReport(null)).toBeNull()
  })

  it('fetchReferencePrices：非 2xx、網路錯誤、壞 JSON 都回 failed，不 throw', async () => {
    const okFetch = (async () => new Response(JSON.stringify(REPORT), { status: 200 })) as typeof fetch
    const r = await fetchReferencePrices('https://api.example/', okFetch)
    expect(r.status).toBe('ok')

    const calls: string[] = []
    const spy = (async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 503 })
    }) as unknown as typeof fetch
    expect(await fetchReferencePrices('https://api.example///', spy)).toEqual({ status: 'failed', reason: 'HTTP 503' })
    expect(calls[0]).toBe('https://api.example/reference-prices')

    const down = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    expect(await fetchReferencePrices('https://api.example', down)).toEqual({ status: 'failed', reason: 'network' })

    const bad = (async () => new Response('{"nope":1}', { status: 200 })) as typeof fetch
    expect(await fetchReferencePrices('https://api.example', bad)).toEqual({ status: 'failed', reason: 'bad response' })
  })
})

describe('合成看板列', () => {
  it('偏離（bps，帶正負號）與等級', () => {
    expect(deviationBps(100, 101)).toBe(100)
    expect(deviationBps(100, 99.5)).toBe(-50)
    expect(deviationBps(null, 1)).toBeNull()
    expect(deviationBps(100, null)).toBeNull()
    expect(deviationLevel(10)).toBe('ok')
    expect(deviationLevel(-120)).toBe('warn')
    expect(deviationLevel(500)).toBe('alert')
    expect(deviationLevel(null)).toBeNull()
  })

  it('buildWitnessRows：年齡用區塊時間；鏈下讀不到時 sources 為 null（只顯示鏈上）', () => {
    const onchain = {
      quotes: {
        sAAPL: { status: 'ok' as const, price: 330, updatedAt: T - 900 },
        sBTC: { status: 'ok' as const, price: 85_000, updatedAt: T - 60 },
      },
      blockTime: T,
      maxPriceAge: 21_600,
    }
    const ref = parseReferenceReport(REPORT)
    const rows = buildWitnessRows(['sAAPL', 'sBTC', 'sTSLA'], onchain, ref, 0)
    expect(rows[0].ageSec).toBe(900)
    expect(rows[0].sources?.[0].deviationBps).toBe(deviationBps(330, 332.89))
    expect(rows[0].sources?.[1].deviationBps).toBeNull()
    expect(rows[0].okCount).toBe(1)
    expect(rows[1].maxDeviationBps).toBe(deviationBps(85_000, 85_510))
    expect(rows[2].onchain.status).toBe('failed')
    expect(rows[2].sources).toBeNull()

    const noRef = buildWitnessRows(['sAAPL'], onchain, null, 0)
    expect(noRef[0].sources).toBeNull()
    expect(noRef[0].onchain.price).toBe(330)

    const localClock = buildWitnessRows(['sAAPL'], { ...onchain, blockTime: null }, null, T + 100)
    expect(localClock[0].ageSec).toBe(1000)
  })

  it('ageUnit', () => {
    expect(ageUnit(30)).toEqual({ unit: 'seconds', n: 30 })
    expect(ageUnit(900)).toEqual({ unit: 'minutes', n: 15 })
    expect(ageUnit(21_600)).toEqual({ unit: 'hours', n: 6 })
    expect(ageUnit(3 * 86_400)).toEqual({ unit: 'days', n: 3 })
  })
})
