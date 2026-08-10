import { useRef, useState, useEffect, useCallback } from 'react'

// 終端機的版面分級。
//
// 關鍵觀念：斷點對著「終端機容器現在有多寬」，不是「使用者是手機還是桌機」。
// 同一台機器的可用寬度會因為 Chrome 側邊欄（MetaMask 常駐在那裡就少掉約 400px）、
// 分割視窗、瀏覽器縮放而改變，而且這一頁還被 DashboardLayout 的側邊欄吃掉一截，
// 所以 viewport 斷點會高估實際可用空間。
//
// 為什麼用 ResizeObserver 而不是 CSS container query：這個值要在 JS 裡做**邏輯**
// 判斷，不只是藏東西。窄版面時訂單簿是收在分頁裡的，那條輪詢根本不該建立——
// container query 只能把它隱藏起來，被隱藏的元件還是在打 API。

export type LayoutTier = 'wide' | 'medium' | 'narrow' | 'mobile'

/**
 * 三欄的最小寬度預算：訂單簿 200 + 圖表 480（再窄蠟燭就糊了）+ 下單 320 + 間距 24
 * ≈ 1024。留一點餘裕到 1400 才開三欄，1400 以下先讓訂單簿退成分頁。
 */
const WIDE = 1400
const MEDIUM = 1100
const NARROW = 768

function tierOf(width: number): LayoutTier {
  if (width >= WIDE) return 'wide'
  if (width >= MEDIUM) return 'medium'
  if (width >= NARROW) return 'narrow'
  return 'mobile'
}

const PANEL_PREF_KEY = 'terminal-panels-v1'

interface PanelPrefs {
  /** 手動收合訂單簿。自動分級之外的覆寫，存 localStorage。 */
  bookCollapsed: boolean
}

function loadPrefs(): PanelPrefs {
  try {
    const raw = localStorage.getItem(PANEL_PREF_KEY)
    if (raw) return { bookCollapsed: false, ...(JSON.parse(raw) as Partial<PanelPrefs>) }
  } catch {
    /* 隱私模式 / 壞掉的 JSON */
  }
  return { bookCollapsed: false }
}

export interface TerminalLayout {
  /** 掛到終端機根節點上。 */
  ref: (el: HTMLElement | null) => void
  tier: LayoutTier
  width: number
  /** 訂單簿是否該獨立成一欄（否則收進圖表下方的分頁）。 */
  bookAsColumn: boolean
  /** 訂單簿的資料訂閱是否該啟用——收起來時不要白打 API。 */
  bookActive: boolean
  bookCollapsed: boolean
  toggleBook: () => void
}

export function useTerminalLayout(): TerminalLayout {
  // 初始值取 viewport 當粗估，避免第一幀閃一下錯的版面；掛載後立刻被實測值取代。
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  )
  const [bookCollapsed, setBookCollapsed] = useState(() => loadPrefs().bookCollapsed)
  const roRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect()
    if (!el) {
      roRef.current = null
      return
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    roRef.current = ro

    // 同步先量一次，讓第一幀就用對的分級（observe() 的首次回呼要等到下一個
    // frame）。但只在量到有意義的值時才覆寫 viewport 推估——ref callback 可能
    // 早於首次版面計算，這時 clientWidth 會是 0 或只有 padding 的寬度，直接
    // 採用會讓版面先閃一次 mobile：面板被卸載又掛回來，連帶把剛建立的輪詢
    // 砍掉重來。
    if (el.clientWidth > NARROW / 2) setWidth(el.clientWidth)
  }, [])

  useEffect(() => () => roRef.current?.disconnect(), [])

  const toggleBook = useCallback(() => {
    setBookCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(PANEL_PREF_KEY, JSON.stringify({ bookCollapsed: next }))
      } catch {
        /* 存不了就算了，只是偏好 */
      }
      return next
    })
  }, [])

  const tier = tierOf(width)
  // 自動分級決定「能不能」給訂單簿一整欄，手動收合決定「要不要」。
  const bookAsColumn = tier === 'wide' && !bookCollapsed

  return {
    ref,
    tier,
    width,
    bookAsColumn,
    // 三欄時常駐，其餘情況由分頁自己決定要不要啟用（見 BookPanel）。
    bookActive: bookAsColumn,
    bookCollapsed,
    toggleBook,
  }
}
