// 顯示層的功能旗標。
//
// 這裡只關「畫面上看不看得到」，**不改任何鏈上行為**。合約照舊收 leverage
// 參數、照舊算保證金；旗標關掉的時候前端一律傳 1，等同現貨。這樣要把功能開
// 回來是改一個環境變數，不是回頭改合約與測試。
//
// 值的解析規則統一：`VITE_X=1` / `true` / `on` 才算開，其餘（含未設定）用租戶的預設值。
//
// 白標：每個旗標的有效值 = 租戶授權（allowed）且 readFlag(env, 租戶預設)。環境變數可以
// 把功能關掉，但打不開租戶未授權的功能。default 租戶五個旗標都是
// { allowed: true, default: false }，結果與改版前的 readFlag(env, false) 完全相同。
// 規則在 src/tenant/flags.ts（vite.config.ts 也要用，不能碰 import.meta.env）。
import { tenant } from 'src/tenant';
import { resolveFeatureFlag } from 'src/tenant/flags';

import { readFlag } from './flagParse';

/**
 * 下單面板要不要露出槓桿選擇器。
 *
 * 預設 **關**。平台的門面是代幣化 RWA 的現貨買賣（AssetVault mint/redeem），
 * 永續終端機是進階功能；一進站就看到 5× 按鈕，會讓人以為這是炒幣平台，而那
 * 是我們最不想給的第一印象。開發或要展示永續時設 `VITE_SHOW_LEVERAGE=1`。
 */
export const SHOW_LEVERAGE = resolveFeatureFlag(
  tenant.features.showLeverage,
  import.meta.env.VITE_SHOW_LEVERAGE
);

/** 旗標關閉時強制的槓桿倍數——1× 就是「保證金 = 部位大小」。 */
export const FIXED_LEVERAGE = 1;

/**
 * 要不要露出永續合約的**入口**。
 *
 * 預設 **關**。平台呈現的主要動作是在 /tokens 用 USDC 買賣代幣化的股債金幣
 * （AssetVault mint/redeem），那是現貨；永續是進階功能。旗標關閉時收起來的是
 * 三個入口：側邊欄的專業終端、首頁的永續功能卡、/exchange 的開倉面板。
 *
 * **收的是入口，不是路徑**——`/terminal` 直接打網址仍然到得了。既有部位的平倉
 * 不依賴終端機：Portfolio 的「部位」頁籤每一列都有平倉按鈕（送出前檢查價格新鮮度
 * 與 AssetMode），所以旗標關閉時使用者仍然看得到、平得掉。把路徑鎖起來會變成一套假的權限系統：擋不住真的要繞過的人
 * （前端路由本來就攔不住），卻會擋到照著舊連結進來的正常使用者，而且會讓已經
 * 開著的部位無法平倉——那比多一個入口糟得多。
 *
 * 合約完全沒有改動。要展示永續時設 `VITE_SHOW_PERPETUALS=1`。
 */
export const SHOW_PERPETUALS = resolveFeatureFlag(
  tenant.features.showPerpetuals,
  import.meta.env.VITE_SHOW_PERPETUALS
);

/**
 * 這個租戶有沒有被授權**新開**永續部位。
 *
 * 跟 SHOW_PERPETUALS 不同層：SHOW_PERPETUALS 收的是入口（路徑仍到得了）；這裡是授權
 * ——租戶設定 `showPerpetuals.allowed=false` 的站，就算有人直接打 `/terminal`，下單面板
 * 也不送 openPosition。平倉**不**看這個值（Portfolio 與終端機的平倉照舊可用）。
 * default 租戶 allowed=true，行為與改版前相同。
 */
export const PERPETUALS_AUTHORIZED = tenant.features.showPerpetuals.allowed;

// ── 商業版（B2B 白標）功能旗標 ────────────────────────────────────────────────
//
// 以下三個旗標收的是「零售／遊戲化」功能。平台定位是賣給持牌金融機構的白標引擎，
// 盡職調查（DD）時看到的站不該出現養成遊戲、平台幣獎勵或槓桿跟單。程式碼全部保留，
// 改一個環境變數就能打開。
//
// 與上面 SHOW_* 的差別：SHOW_* 收的是入口、路徑仍到得了；FEATURE_* 關閉時**連路由
// 也收起來**——直接打網址會看到「此功能未啟用」。唯一例外是既有部位：使用者已經
// 開著的跟單，Portfolio 仍然顯示並可以取消（見 copyDeskVisibility.ts），不能讓旗標
// 把別人的錢鎖在看不到的地方。

/**
 * GameFi：Pepe 養成中心／PepeLab 扭蛋（`/pepe`、帳戶選單的藥水／坐騎／外觀）。
 * 預設 **關**。開啟：`VITE_FEATURE_GAMEFI=1`。
 */
export const FEATURE_GAMEFI = resolveFeatureFlag(
  tenant.features.gamefi,
  import.meta.env.VITE_FEATURE_GAMEFI
);

/**
 * PEPE 平台幣獎勵：`/rewards`、帳戶選單的獎勵入口、Exchange 的 PEPE 水龍頭卡片。
 * 預設 **關**。開啟：`VITE_FEATURE_PEPE_REWARDS=1`。
 */
export const FEATURE_PEPE_REWARDS = resolveFeatureFlag(
  tenant.features.pepeRewards,
  import.meta.env.VITE_FEATURE_PEPE_REWARDS
);

/**
 * Expert 跟單（CopyTracker 的槓桿跟單）：Expert 模式的交易者排行榜、`/copy/:addr`、
 * 交易者頁與巨鯨動態上的「跟單」按鈕與跟隨者統計、首頁的跟單功能卡與文案、
 * meta description。`/stake`（交易員信譽質押）不受影響。
 * 預設 **關**。開啟：`VITE_FEATURE_COPY_TRADING=1`。
 */
export const FEATURE_COPY_TRADING = resolveFeatureFlag(
  tenant.features.copyTrading,
  import.meta.env.VITE_FEATURE_COPY_TRADING
);

export interface FeatureFlags {
  gamefi: boolean;
  pepeRewards: boolean;
  copyTrading: boolean;
}

export const FEATURES: FeatureFlags = {
  gamefi: FEATURE_GAMEFI,
  pepeRewards: FEATURE_PEPE_REWARDS,
  copyTrading: FEATURE_COPY_TRADING,
};

/**
 * 路徑 → 需要的旗標。只列「整條路由屬於某個功能」的路徑；`/marketplace`、
 * `/trader/:addr` 這類頁面本身是商業版的一部分，只有頁內的跟單入口跟著旗標走。
 */
const GATED_PREFIXES: ReadonlyArray<{ prefix: string; flag: keyof FeatureFlags }> = [
  { prefix: '/pepe', flag: 'gamefi' },
  { prefix: '/rewards', flag: 'pepeRewards' },
  { prefix: '/copy', flag: 'copyTrading' },
  // /stake（交易員信譽質押）刻意**不**在這裡：它是配置市集（ADR-007 的 Adopt 無槓桿
  // 現貨配置）發布策略的前提，屬於商業版本身，不屬於跟單。只有頁內提到跟單罰沒的
  // 文案跟著旗標換成中性說法。
];

/** 這條路徑在給定旗標下是否可用。比對到路徑段為止，`/pepelab` 不會被 `/pepe` 吃掉。 */
export function isPathEnabled(path: string, flags: FeatureFlags = FEATURES): boolean {
  const clean = path.split(/[?#]/)[0];
  for (const { prefix, flag } of GATED_PREFIXES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) return flags[flag];
  }
  return true;
}

/**
 * Mock Wallet（無錢包的簡報測試通道）要不要出現。
 *
 * `yarn dev` 一律出現（開發與簡報排練用）；正式 build 只有明確設
 * `VITE_ENABLE_MOCK_WALLET=1` 才出現。正式站不該有一顆「不用錢包就能進站」的按鈕——
 * 它登入的是一個假位址，所有鏈上讀取都會是空的，做 DD 的人看到只會以為系統壞了。
 */
export function mockWalletEnabled(dev: boolean, raw: unknown): boolean {
  return dev || readFlag(raw, false);
}

export const MOCK_WALLET_ENABLED = mockWalletEnabled(
  import.meta.env.DEV,
  import.meta.env.VITE_ENABLE_MOCK_WALLET
);

export const __test__ = { readFlag };
