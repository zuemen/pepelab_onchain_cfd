// History 頁「日誌已經掃過哪一段」的簿記（純函式，可測）。
//
// 覆蓋範圍 Coverage = [from, to]：這段區塊的每一段 getLogs 都**確實讀成功**過。
// from 可以等於 to + 1，代表「還沒有任何確定讀到的區塊，但『載入較舊』從 to 往下走」。
//
// 為什麼不再只記一個 scannedFrom：
//   - 以前掃描一有失敗段就整個不推進，首訪時只要有一段失敗，scannedFrom 永遠是 null，
//     「載入較舊」按鈕就一直不出現。
//   - 隔天回訪時新視窗和舊覆蓋之間有缺口，若把失敗段也算進覆蓋，缺口會被永久吃掉——
//     「載入較舊」從更低的地方開始，永遠不會回頭補那一段。
// 現在的規則：只把「從這次掃描的最高塊往下、連續成功」的那一段算進覆蓋；
// 它與舊覆蓋相接才合併，不相接（中間有缺口或失敗段）就以新的一段為準，
// 讓「載入較舊」從它的下緣往下走，自然會重掃缺口與失敗段。

export interface Coverage {
  from: number
  to: number
}

/**
 * 從最高的一段往下，連續成功的最低塊。最高那一段就失敗回 null。
 * ranges 是 chunkRanges 的輸出（由低到高、閉區間），failedStarts 是失敗段的起點。
 */
export function lowestContiguousFromTop(
  ranges: ReadonlyArray<readonly [number, number]>,
  failedStarts: ReadonlySet<number>,
): number | null {
  let low: number | null = null
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (failedStarts.has(ranges[i][0])) break
    low = ranges[i][0]
  }
  return low
}

/** 重新整理（掃最新視窗 [window.from, window.to]）之後的覆蓋範圍。 */
export function coverageAfterRefresh(
  prev: Coverage | null,
  window: Coverage,
  contiguousLow: number | null,
): Coverage {
  if (contiguousLow === null) {
    // 最高那段就失敗：什麼都不能宣稱。首訪時仍給一個空覆蓋，讓「載入較舊」有起點。
    return prev ?? { from: window.to + 1, to: window.to }
  }
  const fresh = { from: contiguousLow, to: window.to }
  if (prev && prev.to >= fresh.from - 1 && prev.from <= fresh.to + 1) {
    return { from: Math.min(prev.from, fresh.from), to: Math.max(prev.to, fresh.to) }
  }
  // 首訪，或與舊覆蓋之間有缺口：以新的一段為準，缺口留給「載入較舊」往下補。
  return fresh
}

/** 「載入較舊」掃了 [scanned.from, prev.from − 1] 之後的覆蓋範圍。 */
export function coverageAfterLoadOlder(prev: Coverage, contiguousLow: number | null): Coverage {
  // 最高那段（緊貼著舊覆蓋下緣）就失敗：不往下推，下次重掃同一段。
  if (contiguousLow === null) return prev
  return { from: Math.min(prev.from, contiguousLow), to: prev.to }
}

/** 還能不能往更舊的區塊走。 */
export const canLoadOlder = (c: Coverage | null): boolean => c !== null && c.from > 0
