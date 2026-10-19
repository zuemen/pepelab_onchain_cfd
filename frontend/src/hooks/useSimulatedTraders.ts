import { useState, useEffect } from 'react';

import { fetchHeroIndex } from 'src/lib/pepefi/heroData';

// 動態牆與個人頁共用（issue #335）：哪些位址是 #309 的模擬交易者，用來掛「模擬」標示。
// 判斷沿用 heroData：讀連線那條鏈的資料；沒有績效資料就是空集合。

export interface HeroDataset {
  /** 模擬交易者的小寫位址；這條鏈沒有績效資料時是空集合。 */
  addresses: ReadonlySet<string>;
  /** 這條鏈的資料是時間壓縮的回放（公開站，#344）：揭露要用另一段。 */
  timeCompressed: boolean;
}

const EMPTY: HeroDataset = { addresses: new Set(), timeCompressed: false };

export function useHeroDataset(chainId: number | null): HeroDataset {
  const [dataset, setDataset] = useState<HeroDataset>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    setDataset(EMPTY);
    void fetchHeroIndex(chainId).then((index) => {
      if (!cancelled && index) {
        setDataset({ addresses: new Set(index.traders.map((h) => h.address.toLowerCase())), timeCompressed: index.timeCompressed });
      }
    });
    return () => { cancelled = true; };
  }, [chainId]);
  return dataset;
}

/** 模擬交易者（#309）的小寫位址；這條鏈沒有績效資料時是空集合。 */
export function useSimulatedTraders(chainId: number | null): ReadonlySet<string> {
  return useHeroDataset(chainId).addresses;
}
