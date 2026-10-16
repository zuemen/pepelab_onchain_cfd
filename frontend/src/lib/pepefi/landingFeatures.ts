// 首頁功能卡的順序。
//
// #331 起主軸是 Web3 版 eToro（ADR-023）：第一張是社交交易，接著鏈上透明、ESG、GameFi。
// 以前「代幣化 RWA 現貨排第一」是為了來評估的機構；那個理由隨主軸改變失效，現在只在
// 跟單旗標關閉的租戶（例如機構租戶）頂上第一張——首頁不介紹一個看不到的功能，也不讓
// 這類租戶的首頁只剩兩張卡。

export type LandingFeatureKey = 'social' | 'tokenized' | 'transparency' | 'esg' | 'gamefi' | 'perpetuals';

export interface LandingFeatureFlags {
  copyTrading: boolean;
  gamefi: boolean;
  /** SHOW_PERPETUALS：預設關，打開時永續卡接在最後。 */
  perpetuals: boolean;
}

export function landingFeatureKeys(flags: LandingFeatureFlags): LandingFeatureKey[] {
  return [
    flags.copyTrading ? 'social' : 'tokenized',
    'transparency',
    'esg',
    ...(flags.gamefi ? (['gamefi'] as const) : []),
    ...(flags.perpetuals ? (['perpetuals'] as const) : []),
  ];
}
