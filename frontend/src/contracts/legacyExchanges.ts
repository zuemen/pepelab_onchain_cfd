// 已退役的 PerpetualExchange 部署。
//
// 每一次重部署（#102、#129 …）都只是把 addresses.ts 的 PerpetualExchange 換成新位址，
// 舊合約仍在鏈上、仍保存使用者當時的可用保證金（freeMargin）與未平倉部位，而 UI 原本
// 沒有任何入口能取回。/legacy 頁只讀這張表——**位址一律來自這裡的常數**，不從使用者
// 輸入、URL 或任何鏈上讀到的資料取得，避免被引導去對任意合約簽名。
//
// 盤點方法、實測數字與限制見 docs/LEGACY_EXCHANGES.md。新增一筆的時機：之後任何一次
// 重部署換掉 PerpetualExchange 時，把被換下來的位址加進來（不是刪掉）。
//
// 只收曾經寫進 addresses.ts、使用者真的可能用過的位址。Sepolia 上另有一顆
// `0xdc5cc6ab…` 只出現在 broadcast、從未接上前端，餘額為 0，不列入。

export interface LegacyExchange {
  chainId: number;
  address: string;
  /** 在 addresses.ts 上線的日期（YYYY-MM-DD）。 */
  activeFrom: string;
  /** 被新部署取代的日期（YYYY-MM-DD）。 */
  activeUntil: string;
  /** 對應時期的 ABI 來源（git commit），只供文件與除錯；頁面一律用最小 ABI + selector 探測。 */
  abiSource: string;
}

export const LEGACY_EXCHANGES: readonly LegacyExchange[] = [
  // ── Base Sepolia（84532）────────────────────────────────────────────────────
  {
    chainId: 84532,
    address: '0xEf75ECA6514cE96B18382E921aC6190a0cF8c072',
    activeFrom: '2026-06-14',
    activeUntil: '2026-09-04',
    abiSource: '9f4de1f frontend/src/contracts/abi/PerpetualExchange.json',
  },
  {
    chainId: 84532,
    address: '0xfAEf549C687C37064cEaB5728989a839B08955cf',
    activeFrom: '2026-09-04',
    activeUntil: '2026-09-10',
    abiSource: '680cce2 frontend/src/contracts/abi/PerpetualExchange.json',
  },

  // ── Ethereum Sepolia（11155111，前端仍可連，標為 legacy demo）──────────────
  {
    chainId: 11155111,
    address: '0x00f6cf0113399a7A451c7f85fe094a28092d3e0c',
    activeFrom: '2026-05-06',
    activeUntil: '2026-05-11',
    abiSource: '597eff3 contracts/src/PerpetualExchange.sol',
  },
  {
    chainId: 11155111,
    address: '0xb3e978E96e36FeDa703827D9dfE142d502C3bd1d',
    activeFrom: '2026-05-11',
    activeUntil: '2026-05-12',
    abiSource: '9a232c4 frontend/src/contracts/abi/PerpetualExchange.json',
  },
  {
    chainId: 11155111,
    address: '0xc100f942366305E2917d5a7B5eD0F5F1E930a49c',
    activeFrom: '2026-05-12',
    activeUntil: '2026-05-18',
    abiSource: '98a8452 frontend/src/contracts/abi/PerpetualExchange.json',
  },
  {
    chainId: 11155111,
    address: '0x4cC711AEa7c6D7E19e99676b51b7A69ee08c31Eb',
    activeFrom: '2026-05-18',
    activeUntil: '2026-05-21',
    abiSource: '02dab0b frontend/src/contracts/abi/PerpetualExchange.json',
  },
];

export function legacyExchangesFor(chainId: number | null | undefined): readonly LegacyExchange[] {
  if (chainId === null || chainId === undefined) return [];
  return LEGACY_EXCHANGES.filter((e) => e.chainId === chainId);
}
