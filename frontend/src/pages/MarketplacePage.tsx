import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import type { WalletAPI } from '../hooks/useWallet'
import { useContracts } from '../hooks/useContracts'
import { ASSET_IDS } from '../contracts/addresses'

// ── Config ──────────────────────────────────────────────────────────────────
const ASSET_LABEL: Record<string, string> = {
  [ASSET_IDS.sBTC]:  'sBTC',
  [ASSET_IDS.sETH]:  'sETH',
  [ASSET_IDS.sAAPL]: 'sAAPL',
  [ASSET_IDS.sTSLA]: 'sTSLA',
}

// ── Types ────────────────────────────────────────────────────────────────────
interface RawAlloc {
  asset:    string
  weight:   bigint
  isLong:   boolean
  leverage: bigint
}

interface TraderCard {
  address:       string
  displayName:   string
  allocs:        RawAlloc[]
  followerCount: bigint
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const parseAllocs = (arr: unknown[]): RawAlloc[] =>
  arr.map(a => {
    const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
    return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
  })

const shortAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

const summarize = (allocs: RawAlloc[]): string =>
  allocs
    .map(a =>
      `${a.isLong ? 'L' : 'S'} ${ASSET_LABEL[a.asset] ?? '?'} ` +
      `${(Number(a.weight) / 100).toFixed(0)}% ${String(a.leverage)}×`,
    )
    .join(' | ')

// ── Component ────────────────────────────────────────────────────────────────
interface Props { wallet: WalletAPI }

export default function MarketplacePage({ wallet }: Props) {
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [traders,   setTraders]   = useState<TraderCard[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!contracts) return
    setIsLoading(true)
    try {
      const addresses = (await contracts.registry.getAllTraders()) as string[]

      const cards = await Promise.all(
        addresses.map(async (addr): Promise<TraderCard> => {
          const [traderRaw, stratRaw, fc] = await Promise.all([
            contracts.registry.traders(addr),
            contracts.registry.getLatestStrategy(addr),
            contracts.copyTracker.getFollowerCount(addr),
          ])
          const tRaw = traderRaw as unknown as [boolean, string, bigint]
          const sRaw = stratRaw  as unknown as [unknown[], bigint]
          return {
            address:       addr,
            displayName:   tRaw[1],
            allocs:        parseAllocs(sRaw[0] as unknown[]),
            followerCount: fc as bigint,
          }
        }),
      )
      setTraders(cards)
    } catch { /* ignore */ }
    finally { setIsLoading(false) }
  }, [contracts])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // ── Guard ─────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-gray-400">
        Connect wallet to browse the marketplace.
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Strategy Marketplace</h1>
          <p className="text-sm text-gray-400 mt-0.5">Browse and copy public trader strategies</p>
        </div>
        <button
          onClick={() => void fetchAll()}
          className="text-xs text-gray-500 hover:text-white transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-12 text-center text-gray-500">
          Loading traders…
        </div>
      ) : traders.length === 0 ? (
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-12 text-center text-gray-600">
          No traders registered yet. Be the first on{' '}
          <Link to="/trader" className="text-emerald-400 hover:underline">
            Trader Dashboard
          </Link>
          .
        </div>
      ) : (
        <div className="rounded-xl border border-gray-700 bg-gray-900 overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="border-b border-gray-700">
              <tr className="text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-5 py-3 font-medium">Trader</th>
                <th className="px-5 py-3 font-medium">Latest Strategy</th>
                <th className="px-5 py-3 font-medium text-center">Followers</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {traders.map(t => (
                <tr key={t.address} className="hover:bg-gray-800/40 transition-colors">
                  {/* Trader identity */}
                  <td className="px-5 py-4">
                    <div className="font-semibold text-white">
                      {t.displayName || '—'}
                    </div>
                    <div className="font-mono text-xs text-gray-500 mt-0.5">
                      {shortAddr(t.address)}
                    </div>
                  </td>

                  {/* Strategy summary */}
                  <td className="px-5 py-4 max-w-xs">
                    {t.allocs.length === 0 ? (
                      <span className="text-gray-600 italic text-xs">No strategy</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {t.allocs.map((a, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                              a.isLong
                                ? 'bg-green-950 border-green-800 text-green-300'
                                : 'bg-red-950  border-red-800  text-red-300'
                            }`}
                          >
                            {a.isLong ? '↑' : '↓'}
                            {' '}{ASSET_LABEL[a.asset] ?? '?'}
                            {' '}{(Number(a.weight) / 100).toFixed(0)}%
                            {' '}{String(a.leverage)}×
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* Follower count */}
                  <td className="px-5 py-4 text-center">
                    <span className="font-mono text-white font-semibold">
                      {String(t.followerCount)}
                    </span>
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-4">
                    <div className="flex gap-2 justify-end">
                      <Link
                        to={`/copy/${t.address}`}
                        className="px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 text-xs font-medium hover:border-gray-400 hover:text-white transition-colors"
                      >
                        View
                      </Link>
                      {t.allocs.length > 0 && (
                        <Link
                          to={`/copy/${t.address}`}
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold transition-colors"
                        >
                          Copy
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Summary bar */}
          <div className="border-t border-gray-800 px-5 py-2.5 flex justify-between text-xs text-gray-600">
            <span>{traders.length} trader{traders.length !== 1 ? 's' : ''} listed</span>
            <span>
              {traders.reduce((s, t) => s + Number(t.followerCount), 0)} total followers
            </span>
          </div>
        </div>
      )}

      {/* Hidden: generate text summary for quick copy (useful for demo) */}
      {traders.length > 0 && (
        <details className="text-xs text-gray-700">
          <summary className="cursor-pointer hover:text-gray-500 w-fit">
            Raw strategy text
          </summary>
          <pre className="mt-2 p-3 rounded bg-gray-900 border border-gray-800 overflow-x-auto text-gray-500">
            {traders.map(t => `${t.displayName}: ${summarize(t.allocs)}`).join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
