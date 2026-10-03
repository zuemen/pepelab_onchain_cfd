// 白標租戶設定的 schema 與驗證。
//
// 這個檔案同時被瀏覽器端（src/tenant/index.ts）與 Node 端（vite.config.ts，經
// src/tenant/node.ts）import，所以：只用相對路徑 import、不碰 import.meta.env、
// 不碰 fs。
//
// 驗證訊息刻意用英文：它是給部署者看的建置錯誤，而 src/ 底下的中文會被 locales.test.ts
// 的 ratchet 當成漏搬的顯示字串。
//
// 設計原則見 frontend/docs/adr/0009-tenant-config-layer.md。重點：
//   - 設定檔是**資料**（JSON），不是程式；每一個欄位都在這裡驗證，未知欄位直接拒絕
//     （strict），打錯字的欄位不會被靜悄悄忽略。
//   - 驗證失敗就丟錯：build 期讓 `vite build` 失敗，執行期讓 app 起不來（fail-closed）。
//     絕不退回 default tenant——那等於把 PepeLab 的品牌掛到別家機構的網域上。
//   - 資產白名單只能是 addresses.ts 已知資產的子集，設定檔**沒有**任何放地址的欄位。

import * as z from 'zod';

import { ASSET_IDS, type AssetSymbol } from '../contracts/addresses';

// ----------------------------------------------------------------------

export const TENANT_SCHEMA_VERSION = 1;

/** 租戶 id：小寫英數與連字號，同時是設定檔檔名與 `VITE_TENANT` 的值。 */
export const TENANT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 前端會出貨的語系。與 src/locales/catalogs.ts 的 LOCALES 鍵一致（schema.test.ts 會檢查）。 */
export const TENANT_LOCALES = ['zh-TW', 'en'] as const;
export type TenantLocale = (typeof TENANT_LOCALES)[number];

/**
 * 租戶可以設定預設值與上限的功能旗標。鍵名與 src/lib/pepefi/featureFlags.ts 的
 * 環境變數一一對應（見 FEATURE_ENV_KEYS）。
 */
export const FEATURE_KEYS = [
  'gamefi',
  'pepeRewards',
  'copyTrading',
  'showLeverage',
  'showPerpetuals',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_ENV_KEYS: Record<FeatureKey, string> = {
  gamefi: 'VITE_FEATURE_GAMEFI',
  pepeRewards: 'VITE_FEATURE_PEPE_REWARDS',
  copyTrading: 'VITE_FEATURE_COPY_TRADING',
  showLeverage: 'VITE_SHOW_LEVERAGE',
  showPerpetuals: 'VITE_SHOW_PERPETUALS',
};

export const KNOWN_ASSET_SYMBOLS = Object.keys(ASSET_IDS) as AssetSymbol[];

// ── 基本型別 ─────────────────────────────────────────────────────────────

const HAN = /\p{Script=Han}/u;

/** 會被當成 catalog 佔位符或 HTML 的字元。品牌字串會被代入 catalog 與 index.html。 */
const UNSAFE_TEXT = /[{}<>]/;

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !UNSAFE_TEXT.test(s), { message: 'must not contain { } < > characters' });

/**
 * 每個語系一份的顯示文字。英文版不可含漢字——與 en catalog 的 ratchet 同一條規則
 * （src/locales/locales.test.ts），否則英文站會混進中文。
 */
const localizedText = (max: number) =>
  z.strictObject({
    'zh-TW': safeText(max),
    en: safeText(max).refine((s) => !HAN.test(s), {
      message: 'en text must not contain Han characters',
    }),
  });

/**
 * 站內靜態資源路徑。CSP 的 img-src 只允許 'self'，外部圖片網址在正式站會被瀏覽器擋掉，
 * 所以這裡只收以 `/` 開頭的站內路徑；`//host`（protocol-relative）與 `..` 一律拒絕。
 */
const localAssetPath = z
  .string()
  .regex(/^\/[A-Za-z0-9._\-/]+$/, {
    message: 'must be a site-local path starting with / (letters, digits, . _ - / only)',
  })
  .refine((p) => !p.startsWith('//') && !p.split('/').includes('..'), {
    message: 'must not be protocol-relative or contain ..',
  });

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: 'must be a #RRGGBB colour' });

/** 只收 https 連結。javascript:、data:、http: 都拒絕。 */
const httpsUrl = z
  .string()
  .max(300)
  .refine(
    (s) => {
      try {
        return new URL(s).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute https:// URL' }
  );

const email = z
  .string()
  .max(120)
  .regex(/^[^\s@<>{}]+@[^\s@<>{}]+\.[A-Za-z]{2,}$/, {
    message: 'not a valid email address',
  });

const paletteColor = z.strictObject({
  lighter: hexColor,
  light: hexColor,
  main: hexColor,
  dark: hexColor,
  darker: hexColor,
  contrastText: hexColor,
});

const featurePolicy = z
  .strictObject({
    /** 這個租戶被授權使用這個功能嗎？false = 環境變數也打不開。 */
    allowed: z.boolean(),
    /** 環境變數沒設定時的值。 */
    default: z.boolean(),
  })
  .refine((f) => f.allowed || !f.default, { message: 'default: true requires allowed: true' });

const assetSymbol = z.enum(KNOWN_ASSET_SYMBOLS as [AssetSymbol, ...AssetSymbol[]], {
  message: `must be an asset known to addresses.ts ASSET_IDS: ${KNOWN_ASSET_SYMBOLS.join(', ')}`,
});

// ── 設定檔 ───────────────────────────────────────────────────────────────

export const tenantSchema = z
  .strictObject({
    schemaVersion: z.literal(TENANT_SCHEMA_VERSION),
    id: z
      .string()
      .regex(TENANT_ID_PATTERN, { message: 'lowercase letters, digits and hyphens only' }),

    brand: z.strictObject({
      /** 平台名稱。代入 catalog 的 `{brand}`、logo 字樣、index.html 標題。 */
      name: safeText(40),
      /** 品牌小圖示（通常是一個 emoji）。代入 catalog 的 `{brandMark}` 與終端機標頭。 */
      mark: safeText(8),
      logo: z.strictObject({
        src: localAssetPath,
        /** 主圖載入失敗時的備援圖。 */
        fallbackSrc: localAssetPath,
      }),
      favicon: localAssetPath,
      /** `<meta name="theme-color">`。 */
      themeColor: hexColor,
      /**
       * 是否顯示 PepeLab 的吉祥物元素：首頁 logo 右下角的品牌小徽章、頂列與帳戶抽屜的
       * Pepe 頭像（與頭像挑選器）。省略 = true（default 租戶就是 PepeLab 本身）。
       * 機構租戶設 false：頭像改成不帶圖的中性識別圓，首頁不放徽章。
       */
      mascot: z.boolean().optional(),
    }),

    /** MUI 色票覆寫。省略的鍵沿用 src/theme/theme-config.ts 的預設值。 */
    theme: z.strictObject({
      primary: paletteColor.optional(),
      secondary: paletteColor.optional(),
    }),

    /** `VITE_LOCALE` 沒設定時用的語系。 */
    defaultLocale: z.enum(TENANT_LOCALES),

    assets: z.strictObject({
      /**
       * 可以**新開**部位／買進的資產。`"all"` = addresses.ts 的全部資產（含日後新增的）；
       * 陣列 = 明確白名單，必須非空、不重複、全部是已知資產。
       * 不在白名單的資產：既有持倉仍顯示、仍可賣出／平倉。
       */
      enabled: z.union([
        z.literal('all'),
        z
          .array(assetSymbol)
          .min(1)
          .refine((a) => new Set(a).size === a.length, { message: 'assets must not repeat' }),
      ]),
    }),

    compliance: z.strictObject({
      /** 營運機構名稱，顯示在揭露區塊。null = 不顯示（預設 tenant）。 */
      operatorName: localizedText(80).nullable(),
      /**
       * 附加揭露條目，**只能追加**在平台核心揭露之後，不能取代或刪減核心揭露
       * （測試網、合成曝險、非投資建議）。兩個語系條數必須相同。
       */
      additionalDisclosures: z
        .strictObject({
          'zh-TW': z.array(safeText(300)).max(5),
          en: z
            .array(
              safeText(300).refine((s) => !HAN.test(s), {
                message: 'en text must not contain Han characters',
              })
            )
            .max(5),
        })
        .refine((d) => d['zh-TW'].length === d.en.length, {
          message: 'both locales must have the same number of disclosures',
        }),
    }),

    support: z.strictObject({
      email: email.nullable(),
      url: httpsUrl.nullable(),
    }),

    legal: z.strictObject({
      links: z.array(z.strictObject({ label: localizedText(40), href: httpsUrl })).max(6),
    }),

    features: z.strictObject(
      Object.fromEntries(FEATURE_KEYS.map((k) => [k, featurePolicy])) as Record<
        FeatureKey,
        typeof featurePolicy
      >
    ),
  })
  // 跟單（CopyTracker.followTrader）在鏈上鏡射交易者的**全部**部位，合約沒有依資產
  // 過濾的參數，前端也無法在送單前知道之後會鏡射哪些資產——它是白名單管不到的進場路徑。
  // 所以只要租戶有白名單（不是 "all"），就不得授權跟單。見 ADR 0009。
  .superRefine((cfg, ctx) => {
    if (cfg.assets.enabled !== 'all' && cfg.features.copyTrading.allowed) {
      ctx.addIssue({
        code: 'custom',
        path: ['features', 'copyTrading', 'allowed'],
        message:
          'copy trading mirrors every asset the trader holds and cannot be filtered on chain; ' +
          'it must not be allowed when assets.enabled is a whitelist',
      });
    }
  });

export type TenantConfig = z.infer<typeof tenantSchema>;
export type TenantPaletteColor = z.infer<typeof paletteColor>;
export type FeaturePolicy = z.infer<typeof featurePolicy>;

// ----------------------------------------------------------------------

export class TenantConfigError extends Error {
  constructor(
    readonly tenantId: string,
    readonly issues: readonly string[]
  ) {
    super(`[tenant] invalid tenant config "${tenantId}":\n  - ${issues.join('\n  - ')}`);
    this.name = 'TenantConfigError';
  }
}

/**
 * 驗證並回傳租戶設定。任何問題都丟 TenantConfigError（fail-closed）。
 *
 * `expectedId` 是 `VITE_TENANT` 選到的名字；設定檔裡的 `id` 必須與它相同，防止
 * 「檔名是 bank-a、內容其實是從 bank-b 複製來沒改」這種錯誤上線。
 */
export function parseTenant(raw: unknown, expectedId: string): TenantConfig {
  const result = tenantSchema.safeParse(raw);
  if (!result.success) {
    throw new TenantConfigError(
      expectedId,
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    );
  }
  if (result.data.id !== expectedId) {
    throw new TenantConfigError(expectedId, [
      `id: config file says "${result.data.id}" but the selected tenant is "${expectedId}"`,
    ]);
  }
  return result.data;
}

/**
 * 把 `VITE_TENANT` 的原始值換成租戶 id。沒設定 = `default`。
 *
 * 與 pickLocale 刻意相反：語系認不出來可以退回預設（最壞是語言不對），租戶認不出來
 * **不能**退回預設（最壞是別家機構的網域掛著我們的品牌、開著它沒授權的資產），所以丟錯。
 */
export function tenantIdFrom(raw: unknown): string {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'default';
  const id = String(raw).trim();
  if (!TENANT_ID_PATTERN.test(id)) {
    throw new TenantConfigError(id, [
      `VITE_TENANT "${id}" is not a valid tenant id (lowercase letters, digits, hyphens)`,
    ]);
  }
  return id;
}
