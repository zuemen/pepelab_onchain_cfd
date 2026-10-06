import type { ReactElement } from 'react'
import type { RwaSnapshot, RwaCardChain } from 'src/lib/pepefi/rwaCards'
import type { ReserveHistory, SolvencySnapshot } from 'src/lib/pepefi/solvency'

import { createElement } from 'react'
import { MemoryRouter } from 'react-router'
import { it, expect, describe } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { paths } from 'src/routes/paths'
import { t, interpolate } from 'src/locales'
import { navData } from 'src/layouts/nav-config-dashboard'
import { RWA_CARD_ORDER } from 'src/lib/pepefi/rwaProfile'
import { buildWaterfall } from 'src/lib/pepefi/solvency'
import { ok, FAILED, UNSUPPORTED } from 'src/lib/pepefi/contractProbe'
import { buildWitnessRows, parseReferenceReport } from 'src/lib/pepefi/oracleWitness'

import { RwaInfoLink } from './RwaInfoLink'
import { RwaPagesNav } from './RwaPagesNav'
import { SolvencyView } from './SolvencyView'
import { RwaAssetCard } from './RwaAssetCard'
import { RwaCardsView } from './RwaCardsView'
import { LossWaterfall } from './LossWaterfall'
import { ChainSourceNote } from './ChainSourceNote'
import { OracleWitnessView } from './OracleWitnessView'
import { ComplianceDisclosure } from './ComplianceDisclosure'
import { chartPath, ReserveRatioChart } from './ReserveRatioChart'

const render = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el))
/** 把 HTML 標籤拿掉，只比對畫面上的文字。 */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

// 2026-10-06 週二 15:00 UTC = 美東 11:00（美股開盤中）；週六 = 休市。
const WEEKDAY_OPEN = Date.UTC(2026, 9, 6, 15, 0) / 1000
const SATURDAY = Date.UTC(2026, 9, 10, 15, 0) / 1000
const KYC = '0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d'

const liveCard = (over: Partial<RwaCardChain> = {}): RwaCardChain => ({
  rwaFlag: ok(true),
  maxLeverage: ok(5),
  maintenanceBps: ok(500),
  carbon: ok({ tier: 'low', freshCount: 1, isRated: true }),
  attestors: ok(1),
  mode: { kind: 'unsupported' },
  ...over,
})

describe('RwaAssetCard', () => {
  it('舊部署（沒有 assetMode）：照實揭露「此部署未啟用休市停單，休市時仍以最後收盤價成交」', () => {
    const html = text(
      render(
        createElement(RwaAssetCard, {
          symbol: 'sAAPL',
          chain: liveCard(),
          kycAddress: ok(KYC),
          modeSupport: 'unsupported',
          nowSec: SATURDAY,
        })
      )
    )
    expect(html).toContain(t.rwa.cards.closure.noStop)
    expect(html).toContain('此部署未啟用休市停單，休市時仍以最後收盤價成交')
    expect(html).toContain(t.rwa.cards.statusValue.closed)
    expect(html).toContain(t.rwa.cards.kycValue.required)
    expect(html).toContain(t.rwa.cards.singleAttestor)
    expect(html).toContain('5×')
    expect(html).toContain('5%（500 bps）')
    expect(html).toContain('Yahoo Finance')
    expect(html).toContain(t.rwa.cards.singleSource)
  })

  it('開盤中仍寫出休市規則（不是只在週末才揭露）', () => {
    const html = text(
      render(
        createElement(RwaAssetCard, { symbol: 'sAAPL', chain: liveCard(), kycAddress: ok(KYC), modeSupport: 'unsupported', nowSec: WEEKDAY_OPEN })
      )
    )
    expect(html).toContain(t.rwa.cards.statusValue.open)
    expect(html).toContain(t.rwa.cards.closure.noStop)
  })

  it('sGOLD 鏈上未標記 rwaAsset：照實顯示「未標記」與說明，KYC 不需要', () => {
    const html = text(
      render(
        createElement(RwaAssetCard, {
          symbol: 'sGOLD',
          chain: liveCard({ rwaFlag: ok(false) }),
          kycAddress: ok(KYC),
          modeSupport: 'unsupported',
          nowSec: WEEKDAY_OPEN,
        })
      )
    )
    expect(html).toContain(t.rwa.cards.rwaUnflagged)
    expect(html).toContain(t.rwa.cards.rwaNote.goldMismatch)
    expect(html).toContain(t.rwa.cards.kycValue.notRequired)
    expect(html).toContain(t.rwa.cards.classLabel.gold)
  })

  it('函式不存在顯示「此部署沒有這個函式」；讀取失敗顯示「讀取失敗」，都不顯示 0', () => {
    const html = text(
      render(
        createElement(RwaAssetCard, {
          symbol: 'sTSLA',
          chain: liveCard({ maxLeverage: UNSUPPORTED, maintenanceBps: FAILED, rwaFlag: FAILED, attestors: FAILED, carbon: FAILED }),
          kycAddress: FAILED,
          modeSupport: 'unknown',
          nowSec: WEEKDAY_OPEN,
        })
      )
    )
    expect(html).toContain(t.rwa.common.notInDeployment)
    expect(html).toContain(t.rwa.common.readFailed)
    expect(html).toContain(t.rwa.cards.kycValue.unknown)
    expect(html).toContain(t.rwa.cards.closure.unknown)
    expect(html).not.toContain('0×')
  })

  it('加密資產：24/7，沒有休市', () => {
    const html = text(
      render(createElement(RwaAssetCard, { symbol: 'sBTC', chain: liveCard({ rwaFlag: ok(false) }), kycAddress: ok(KYC), modeSupport: 'unsupported', nowSec: SATURDAY }))
    )
    expect(html).toContain(t.rwa.cards.closure.crypto)
    expect(html).toContain(t.rwa.cards.rwaNote.cryptoNotRwa)
    expect(html).toContain('CoinGecko')
  })
})

describe('ComplianceDisclosure', () => {
  it('列出定位、法規與「不是法律意見」', () => {
    const html = text(render(createElement(ComplianceDisclosure)))
    for (const v of Object.values(t.rwa.compliance.items)) expect(html).toContain(v)
    expect(html).toContain('《期貨交易法》')
    expect(html).toContain(t.rwa.compliance.notLegalAdvice)
    expect(html).toContain('MockUSDC')
  })
})

describe('RwaCardsView', () => {
  const snapshot: RwaSnapshot = {
    kycAddress: ok(KYC),
    modeSupport: 'unsupported',
    esgDeployed: true,
    perAsset: Object.fromEntries(RWA_CARD_ORDER.map((s) => [s, liveCard({ rwaFlag: ok(s !== 'sGOLD' && s !== 'sBTC' && s !== 'sETH') })])),
  }

  it('11 張卡＋法遵揭露＋讀取來源', () => {
    const raw = render(
      createElement(RwaCardsView, { symbols: RWA_CARD_ORDER, snapshot, loading: false, chainId: 84532, source: 'public', nowSec: SATURDAY })
    )
    expect(raw.match(/data-testid="rwa-card-/g)).toHaveLength(11)
    expect(raw).toContain('data-testid="rwa-compliance"')
    expect(text(raw)).toContain('Base Sepolia (84532)')
    expect(raw).not.toContain('rwa-load-failed')
  })

  it('全部讀不到時顯示讀取失敗提示；沒有節點時顯示提示', () => {
    const failed: RwaSnapshot = {
      ...snapshot,
      kycAddress: FAILED,
      perAsset: Object.fromEntries(RWA_CARD_ORDER.map((s) => [s, liveCard({ rwaFlag: FAILED })])),
    }
    const raw = render(createElement(RwaCardsView, { symbols: RWA_CARD_ORDER, snapshot: failed, loading: false, chainId: 84532, source: 'public', nowSec: SATURDAY }))
    expect(raw).toContain('rwa-load-failed')
    const none = render(createElement(RwaCardsView, { symbols: ['sAAPL'], snapshot: null, loading: false, chainId: null, source: null, nowSec: SATURDAY }))
    expect(none).toContain('rwa-no-provider')
  })
})

describe('ChainSourceNote / RwaInfoLink', () => {
  it('公開節點與錢包節點分開講', () => {
    expect(text(render(createElement(ChainSourceNote, { chainId: 84532, source: 'wallet' })))).toContain(
      interpolate(t.rwa.common.chainSourceWallet, { chain: 'Base Sepolia (84532)' })
    )
  })

  it('三頁切換列：連到三頁、標出目前頁', () => {
    const raw = render(createElement(RwaPagesNav, { current: 'oracle' }))
    for (const p of [paths.pepefi.rwa, paths.pepefi.oracle, paths.pepefi.solvency]) expect(raw).toContain(`href="${p}"`)
    expect(raw.match(/aria-current="page"/g)).toHaveLength(1)
  })

  it('連結到 /rwa', () => {
    const raw = render(createElement(RwaInfoLink))
    expect(raw).toContain(`href="${paths.pepefi.rwa}"`)
    expect(text(raw)).toContain(t.rwa.link.label)
  })
})

describe('OracleWitnessView', () => {
  const onchain = {
    quotes: { sAAPL: { status: 'ok' as const, price: 330, updatedAt: SATURDAY - 600 } },
    blockTime: SATURDAY,
    maxPriceAge: 21_600,
  }
  const report = parseReferenceReport({
    generatedAt: SATURDAY,
    assets: {
      sAAPL: {
        sources: [
          { provider: 'yahoo', ticker: 'AAPL', role: 'keeper-primary', price: 332.89, quoteTime: SATURDAY - 86_400, fetchedAt: SATURDAY },
          { provider: 'nasdaq', ticker: 'AAPL', role: 'independent', price: 332.89, quoteTime: null, quoteTimeText: 'Oct 9, 2026', fetchedAt: SATURDAY },
        ],
      },
    },
  })

  it('區分寫入時間與報價時間、顯示偏離與來源', () => {
    const rows = buildWitnessRows(['sAAPL', 'sGOLD'], onchain, report, 0)
    const raw = render(
      createElement(OracleWitnessView, {
        rows,
        onchainLoading: false,
        reference: report ? { status: 'ok', report } : null,
        localClock: false,
        maxPriceAge: 21_600,
        chainId: 84532,
        source: 'public',
      })
    )
    const s = text(raw)
    expect(s).toContain(t.rwa.oracle.writtenOnlyNote)
    expect(s).toContain('$330.00')
    expect(s).toContain('Oct 9, 2026')
    expect(s).toContain('Nasdaq')
    expect(s).toContain(t.rwa.oracle.role['keeper-primary'])
    expect(s).toContain('+88 bps')
    expect(s).toContain(t.rwa.oracle.onchainFailed)
  })

  it('鏈下參考價讀取失敗：只顯示鏈上資料並說明原因', () => {
    const rows = buildWitnessRows(['sAAPL'], onchain, null, 0)
    const raw = render(
      createElement(OracleWitnessView, {
        rows,
        onchainLoading: false,
        reference: { status: 'failed', reason: 'HTTP 503' },
        localClock: true,
        maxPriceAge: null,
        chainId: 84532,
        source: 'public',
      })
    )
    expect(raw).toContain('oracle-offchain-failed')
    expect(text(raw)).toContain(interpolate(t.rwa.oracle.offchainUnavailable, { reason: 'HTTP 503' }))
    expect(text(raw)).toContain(t.rwa.oracle.ageLocalClock)
  })
})

describe('Solvency 元件', () => {
  const E18 = 10n ** 18n
  const vaultValue = {
    reserve: 201_291_500n * 10n ** 15n,
    liability: 1_375n * E18,
    ratioBps: 1_463_658n,
    unpriced: 0,
    stale: false,
    halted: false,
    minRatioBps: ok(11_000n),
  }
  const snap: SolvencySnapshot = {
    usdcDecimals: 18,
    exchangeBalance: ok(500n * E18),
    positions: { status: 'ok', nextId: 0, scanned: 0, open: 0, missed: 0, pnlMissed: 0, truncated: false, totalMargin: 0n, unrealizedPnl: 0n },
    insuranceAssets: ok(1_000n * E18),
    adl: ok(true),
    vault: ok(vaultValue),
  }

  it('SolvencyView：照實標示「非足額抵押」「儲備是測試幣，不是標的資產的儲備證明」', () => {
    const raw = render(createElement(SolvencyView, { snapshot: snap, loading: false, history: null, historyLoading: true, chainId: 84532, source: 'public' }))
    const s = text(raw)
    expect(s).toContain(t.rwa.solvency.notPoR)
    expect(s).toContain('不是標的資產的儲備證明')
    expect(s).toContain('金庫非足額抵押')
    expect(s).toContain('500.00 USDC')
    expect(s).toContain('14,636.58%')
    expect(s).toContain(t.rwa.solvency.noPositions)
    expect(s).toContain(t.rwa.solvency.historyLoading)
  })

  it('SolvencyView：讀取失敗顯示「讀取失敗」不是 0；有未計價資產時準備率「無法判斷」', () => {
    const failed: SolvencySnapshot = {
      ...snap,
      exchangeBalance: FAILED,
      positions: { ...snap.positions, status: 'failed', nextId: null },
      insuranceAssets: FAILED,
      vault: ok({ ...vaultValue, unpriced: 2, stale: true }),
    }
    const s = text(render(createElement(SolvencyView, { snapshot: failed, loading: false, history: null, historyLoading: false, chainId: 84532, source: 'public' })))
    expect(s).toContain(t.rwa.common.readFailed)
    expect(s).not.toContain('0.00 USDC')
    expect(s).toContain(interpolate(t.rwa.solvency.ratioStale, { n: 2 }))
  })

  it('LossWaterfall：四層依序，ADL 讀鏈上開關', () => {
    const raw = render(createElement(LossWaterfall, { layers: buildWaterfall(snap), decimals: 18 }))
    const order = ['margin', 'insurance', 'adl', 'badDebt'].map((k) => raw.indexOf(`waterfall-${k}`))
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]))).toBe(true)
    const s = text(raw)
    expect(s).toContain(t.rwa.solvency.layerValue.adlOn)
    expect(s).toContain(interpolate(t.rwa.solvency.layerValue.insurance, { amount: '1,000.00 USDC' }))
    expect(s).toContain(t.rwa.solvency.noGuarantee)
    const off = text(render(createElement(LossWaterfall, { layers: buildWaterfall({ ...snap, adl: ok(false) }), decimals: 18 })))
    expect(off).toContain(t.rwa.solvency.layerValue.adlOff)
  })

  it('ReserveRatioChart：讀取失敗、沒有事件、部分失敗、有資料四種狀態', () => {
    const base: ReserveHistory = { status: 'ok', points: [], failedChunks: 0, totalChunks: 96, fromBlock: 1, toBlock: 43_200 }
    expect(render(createElement(ReserveRatioChart, { history: { ...base, status: 'failed', failedChunks: 96 }, loading: false }))).toContain(
      'reserve-history-failed'
    )
    expect(render(createElement(ReserveRatioChart, { history: base, loading: false }))).toContain('reserve-history-empty')
    const point = { block: 10, timestamp: 1_791_000_000, reserve: 2n, liability: 1n, ratioBps: 20_000n, unpriced: 0 }
    const partial = render(
      createElement(ReserveRatioChart, { history: { ...base, status: 'partial', failedChunks: 3, points: [point, { ...point, block: 20, timestamp: 1_791_000_900, ratioBps: 19_000n }] }, loading: false })
    )
    expect(partial).toContain('reserve-history-partial')
    expect(partial).toContain('<path')
    expect(text(partial)).toContain('190.00%')
    expect(partial).toContain('reserve-history-range')
    expect(text(partial)).toContain('200.00%')
    expect(chartPath([])).toBe('')
    expect(chartPath([{ timestamp: 1, ratio: 5 }])).toBe('M320.0,90.0')
  })
})

describe('導覽列', () => {
  it('三頁都在側邊欄（繁中標題）', () => {
    const items = navData.flatMap((s) => s.items)
    for (const [path, title] of [
      [paths.pepefi.rwa, t.rwa.nav.cards],
      [paths.pepefi.oracle, t.rwa.nav.oracle],
      [paths.pepefi.solvency, t.rwa.nav.solvency],
    ]) {
      expect(items.find((i) => i.path === path)?.title).toBe(title)
    }
  })
})
