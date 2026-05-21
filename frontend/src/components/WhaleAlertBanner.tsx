import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import type { WhaleAlert } from '../hooks/useWhaleAlerts'

interface Props { alerts: WhaleAlert[] }

const fNotional = (n: bigint) => {
  const v = Number(n) / 1e18
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

const timeAgo = (ts: number) => {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 120)   return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export default function WhaleAlertBanner({ alerts }: Props) {
  const [visible, setVisible] = useState(true)
  const [idx,     setIdx]     = useState(0)

  const top3 = alerts.slice(0, 3)

  // Auto-rotate every 6 s when multiple alerts
  useEffect(() => {
    if (top3.length < 2) return
    const id = setInterval(() => setIdx(c => (c + 1) % top3.length), 6000)
    return () => clearInterval(id)
  }, [top3.length])

  // Reset when alerts list refreshes
  useEffect(() => { setIdx(0); setVisible(true) }, [alerts])

  if (!visible || top3.length === 0) return null

  const a = top3[idx]
  if (!a) return null

  return (
    <div className="bg-cyan-950/70 border-b border-cyan-800/50 px-4 py-1.5 flex items-center gap-3 text-xs select-none">
      <span className="shrink-0 text-base leading-none">🐋</span>
      <span className="shrink-0 font-bold text-cyan-300 hidden sm:block">Whale Alert</span>

      {/* Message */}
      <span className="flex-1 min-w-0 truncate text-cyan-100">
        <Link
          to={`/whale?addr=${a.owner}`}
          className="font-mono hover:text-white transition-colors hover:underline underline-offset-2"
        >
          {shortAddr(a.owner)}
        </Link>
        {' opened '}
        <span className={`font-semibold ${a.isLong ? 'text-green-300' : 'text-red-300'}`}>
          {a.isLong ? 'LONG' : 'SHORT'}
        </span>
        {' '}{a.assetLabel}
        {' — '}
        <span className="font-bold text-white">{fNotional(a.notional)}</span>
        {' notional'}
        {' · '}
        <span className="text-cyan-400/80">{timeAgo(a.timestamp)}</span>
      </span>

      {/* Pagination dots */}
      {top3.length > 1 && (
        <div className="flex items-center gap-1 shrink-0">
          {top3.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`w-1.5 h-1.5 rounded-full transition-colors ${
                i === idx ? 'bg-cyan-300' : 'bg-cyan-700 hover:bg-cyan-500'
              }`}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => setVisible(false)}
        className="shrink-0 text-cyan-700 hover:text-cyan-300 transition-colors ml-1"
        aria-label="Dismiss whale alert"
      >
        ✕
      </button>
    </div>
  )
}
