// 首頁「平台特色」卡的順序。每張卡講一個痛點與平台的做法，所以「要解決的問題」與「功能」
// 是同一段，不會講兩次。
//
// #331 起主軸是 Web3 版 eToro（ADR-023）：社交交易排第一。跟單旗標關閉的租戶（例如機構
// 租戶）不放社交交易卡——首頁不介紹一個看不到的功能——整合四大資產自然排到第一。

export type LandingFeatureKey = 'social' | 'assets' | 'transparency' | 'esg' | 'gamefi' | 'agent' | 'perpetuals';

export interface LandingFeatureFlags {
  copyTrading: boolean;
  gamefi: boolean;
  /** SHOW_PERPETUALS：預設關，打開時永續卡接在最後。 */
  perpetuals: boolean;
}

export function landingFeatureKeys(flags: LandingFeatureFlags): LandingFeatureKey[] {
  return [
    ...(flags.copyTrading ? (['social'] as const) : []),
    'assets',
    'transparency',
    'esg',
    ...(flags.gamefi ? (['gamefi'] as const) : []),
    'agent',
    ...(flags.perpetuals ? (['perpetuals'] as const) : []),
  ];
}
