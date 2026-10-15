import { useState, useEffect } from 'react';

import { fetchHeroIndex } from 'src/lib/pepefi/heroData';

// 動態牆與個人頁共用（issue #335）：哪些位址是 #309 的模擬交易者，用來掛「模擬」標示。
// 判斷沿用 heroData：chainId 不符或沒有績效資料就是空集合。

/** 模擬交易者（#309）的小寫位址；這條鏈沒有績效資料時是空集合。 */
export function useSimulatedTraders(chainId: number | null): ReadonlySet<string> {
  const [set, setSet] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    setSet(new Set());
    void fetchHeroIndex(chainId).then((index) => {
      if (!cancelled && index) setSet(new Set(index.traders.map((h) => h.address.toLowerCase())));
    });
    return () => { cancelled = true; };
  }, [chainId]);
  return set;
}
