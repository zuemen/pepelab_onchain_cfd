import type { LegacyReader, LegacyExchangeScan } from 'src/lib/pepefi/legacyExchange';

import { useRef, useState, useEffect, useCallback } from 'react';

import { legacyExchangesFor } from 'src/contracts/legacyExchanges';
import { scanLegacyExchange } from 'src/lib/pepefi/legacyExchange';

// ----------------------------------------------------------------------

/**
 * 連上的錢包在「目前這條鏈」的舊版 exchange 上有什麼。
 *
 * 讀取一律走錢包的 provider（BrowserProvider）：站台的 CSP connect-src 只放行
 * sepolia.base.org，而錢包的節點不受 CSP 限制，Sepolia 也讀得到。
 *
 * 只掃一次（加上手動 refresh），不輪詢：舊合約不會有新部位，價格新鮮度在使用者按下
 * 按鈕時會重新預檢一次（見 LegacyPage 的 runAction），不需要靠輪詢維持。
 */
export interface LegacyAssetsState {
  /** null = 尚未讀完（或沒有錢包）。 */
  scans: LegacyExchangeScan[] | null;
  loading: boolean;
  /** 這條鏈上登記的舊合約數量；0 代表這條鏈沒有舊合約。 */
  registered: number;
  refresh: () => void;
}

export function useLegacyAssets(
  reader: LegacyReader | null,
  chainId: number | null,
  account: string | null
): LegacyAssetsState {
  const entries = legacyExchangesFor(chainId);
  const [scans, setScans] = useState<LegacyExchangeScan[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const mySeq = ++seq.current;
    setScans(null);
    if (!reader || !account || entries.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      const out: LegacyExchangeScan[] = [];
      for (const e of entries) {
        // 刻意循序，見 scanLegacyExchange
        out.push(await scanLegacyExchange(reader, e, account, Math.floor(Date.now() / 1000)));
        if (seq.current !== mySeq) return; // 錢包或鏈在讀取中途換了
      }
      setScans(out);
      setLoading(false);
    })();
    // entries 由 chainId 決定，不放進依賴（每次 render 都是新陣列）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, chainId, account, tick]);

  return { scans, loading, registered: entries.length, refresh };
}
