// 租戶的合約部署登記：這個 build 的前端要連哪一組合約。
//
// 設計原則（frontend/docs/adr/0009-tenant-config-layer.md 的增補）：
//   - 租戶設定檔（src/tenant/tenants/<id>.json）**沒有任何位址欄位**，這裡也不改變這一點。
//     位址只來自 checked-in、經過審查與 CI 比對的登記檔 src/contracts/deployments/<id>.json。
//   - 登記檔有兩種：
//       kind: "platform"   明確宣告「這個租戶跑在平台的現行部署上」（addresses.ts）。
//                          default 租戶是這一種；示範租戶也是（只換品牌、不隔離資金）。
//       kind: "dedicated"  這個租戶自己的整組合約（DeployTenant.s.sol 的產出，ADR-008）。
//   - 被選中的租戶**沒有登記檔就 build 失敗**（fail-closed）。不退回平台部署：退回的最壞
//     情況是 A 機構的網域把使用者的錢送進共用的 exchange 與保險金，而且沒有任何錯誤。
//     要用平台部署必須寫一份 kind: "platform" 的登記檔，那是一個看得見、審得到的決定。
//   - default 租戶的行為逐位元不變：platform 的每一個 getter 直接轉呼叫 addresses.ts，
//     回傳的是同一個物件（tenantDeployment.test.ts 釘住）。addresses.ts 本身完全沒動——
//     agent 端直接 import 它，signal-api 的 bundle 指紋也涵蓋它。
//
// 這個檔案同時被瀏覽器端（./deployment.ts）與 Node 端（vite.config.ts，經
// ./tenantDeployment.node.ts）import：只用相對路徑、不碰 import.meta.env、不碰 fs。
// 驗證訊息用英文，理由同 src/tenant/schema.ts。

import * as z from 'zod';

import { X402_FEE_ROUTER } from './x402';
import { legacyExchangesFor, type LegacyExchange } from './legacyExchanges';
import {
  ASSET_IDS,
  CHAIN_MAP,
  V2_STACK,
  getV2Stack,
  hasV2Stack,
  SYNTH_TOKENS,
  getAddresses,
  getSynthTokens,
  type AssetSymbol,
  type ChainAddresses,
  BASE_SEPOLIA_ORACLE_SHOWCASE,
} from './addresses';

// ----------------------------------------------------------------------

export const DEPLOYMENT_SCHEMA_VERSION = 1;

const ZERO = '0x0000000000000000000000000000000000000000';
const TENANT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 前端目前能連的專屬部署鏈。只有 Base Sepolia：錢包切換、RPC、CSP、區塊瀏覽器連結都
 * 只為它設定過。部署設定（deploy/tenants）允許 Base 主網，但前端要支援它是另一件工作，
 * 在那之前登記主網部署會讓 build 失敗，而不是出貨一個連不上的站。
 */
export const DEDICATED_CHAIN_ID = 84532;

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address')
  .refine((a) => a.toLowerCase() !== ZERO, { message: 'must not be the zero address' });

const assetSymbol = z.enum(Object.keys(ASSET_IDS) as [AssetSymbol, ...AssetSymbol[]]);

const tenantId = z.string().regex(TENANT_ID_PATTERN, 'tenant must be lowercase letters, digits and hyphens');

const platformDeployment = z.strictObject({
  schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
  tenant: tenantId,
  kind: z.literal('platform'),
  /** 為什麼這個租戶跑在平台部署上（default 以外的租戶必填，給審查的人看）。 */
  note: z.string().trim().min(1).max(300).optional(),
});

/** 專屬部署裡，每個租戶各自一份的合約。SettlementToken 是唯一允許與平台共用的位址。 */
export const DEDICATED_CONTRACT_KEYS = [
  'Oracle',
  'ESGRegistryV2',
  'KYCRegistry',
  'InsuranceVault',
  'FeeRouter',
  'TraderStake',
  'PerpetualExchange',
  'StrategyRegistry',
  'CopyTracker',
  'AgentSessionManager',
] as const;

const dedicatedDeployment = z.strictObject({
  schemaVersion: z.literal(DEPLOYMENT_SCHEMA_VERSION),
  tenant: tenantId,
  kind: z.literal('dedicated'),
  chainId: z.literal(DEDICATED_CHAIN_ID),
  oracleKind: z.enum(['guarded', 'mock']),
  contracts: z.strictObject({
    SettlementToken: address,
    Oracle: address,
    ESGRegistryV2: address,
    KYCRegistry: address,
    InsuranceVault: address,
    FeeRouter: address,
    TraderStake: address,
    PerpetualExchange: address,
    StrategyRegistry: address,
    CopyTracker: address,
    AgentSessionManager: address,
    /** 選用：租戶有代幣化資產金庫時才有（params.deployVault）。 */
    AssetVaultV2: address.optional(),
    /** 選用：租戶自己的 x402 分潤路由（DeployX402Router.s.sol，綁官方 USDC）。 */
    X402FeeRouter: address.optional(),
  }),
  /** 金庫發行的合成資產代幣；有金庫才有。 */
  tokens: z.partialRecord(assetSymbol, address).optional(),
});

export const tenantDeploymentSchema = z.discriminatedUnion('kind', [
  platformDeployment,
  dedicatedDeployment,
]);

export type TenantDeployment = z.infer<typeof tenantDeploymentSchema>;
export type DedicatedDeployment = z.infer<typeof dedicatedDeployment>;

// ── 平台部署的位址集合（租戶隔離的比對對象）───────────────────────────────

/**
 * 平台（default）在某條鏈上用到的所有位址，小寫。專屬部署除了結算幣以外，
 * 不得與其中任何一個相同——共用 exchange、金庫、FeeRouter 或保險金，就等於共用資金、
 * 收款地址與暫停鍵（ADR-008）。
 *
 * `extra` 讓呼叫端補上不在這個純資料模組裡的位址（AgentSessionManager 的表在
 * sessionManager.ts，那個檔案 import ethers，Node 端的 vite.config.ts 拿不到）。
 */
export function platformAddressSet(chainId: number, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (a: string | undefined) => {
    if (a && a.toLowerCase() !== ZERO) out.add(a.toLowerCase());
  };
  Object.values(CHAIN_MAP[chainId] ?? {}).forEach(add);
  const v2 = V2_STACK[chainId];
  if (v2) {
    add(v2.GuardedOracle);
    add(v2.AssetVaultV2);
    add(v2.ESGRegistryV2);
    add(v2.SustainabilityBadge);
    Object.values(v2.tokens).forEach(add);
  }
  Object.values(SYNTH_TOKENS[chainId] ?? {}).forEach(add);
  add(X402_FEE_ROUTER[chainId]);
  if (chainId === 84532) Object.values(BASE_SEPOLIA_ORACLE_SHOWCASE).forEach(add);
  legacyExchangesFor(chainId).forEach((e) => add(e.address));
  extra.forEach(add);
  return out;
}

/** 專屬部署的所有位址：[欄位路徑, 位址]。 */
export function dedicatedAddressEntries(d: DedicatedDeployment): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(d.contracts)) if (v) out.push([`contracts.${k}`, v]);
  for (const [k, v] of Object.entries(d.tokens ?? {})) if (v) out.push([`tokens.${k}`, v]);
  return out;
}

/**
 * 專屬部署的結構檢查，回傳問題清單（空 = 通過）：
 *   - 同一個租戶的各合約位址不得重複；
 *   - 除了 SettlementToken，不得出現平台部署的任何位址（租戶隔離）；
 *   - 有金庫才有代幣、有代幣就要有金庫；金庫需要 guarded oracle。
 */
export function dedicatedProblems(d: DedicatedDeployment, platform: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [path, value] of dedicatedAddressEntries(d)) {
    const low = value.toLowerCase();
    const prev = seen.get(low);
    if (prev) problems.push(`${path} and ${prev} are the same address`);
    else seen.set(low, path);
    if (path !== 'contracts.SettlementToken' && platform.has(low)) {
      problems.push(
        `${path} (${value}) is an address of the platform deployment — a dedicated tenant shares only the settlement token`
      );
    }
  }
  const tokenCount = Object.keys(d.tokens ?? {}).length;
  if (d.contracts.AssetVaultV2 && tokenCount === 0) {
    problems.push('contracts.AssetVaultV2 is set but tokens is empty');
  }
  if (!d.contracts.AssetVaultV2 && tokenCount > 0) {
    problems.push('tokens are listed but contracts.AssetVaultV2 is missing');
  }
  if (d.contracts.AssetVaultV2 && d.oracleKind !== 'guarded') {
    problems.push('contracts.AssetVaultV2 requires oracleKind "guarded"');
  }
  return problems;
}

/**
 * 驗證一份登記檔。`expectedTenant` 是被選中的租戶 id：檔內 `tenant` 必須相同，
 * 否則把 A 的登記檔複製成 B 的檔名就會讓 B 的站連到 A 的合約。
 */
export function parseTenantDeployment(
  raw: unknown,
  expectedTenant: string,
  extraPlatformAddresses: readonly string[] = []
): TenantDeployment {
  const res = tenantDeploymentSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`[tenant] invalid deployment registry for "${expectedTenant}":\n${lines.join('\n')}`);
  }
  const dep = res.data;
  if (dep.tenant !== expectedTenant) {
    throw new Error(
      `[tenant] deployment registry tenant "${dep.tenant}" does not match the selected tenant "${expectedTenant}"`
    );
  }
  if (dep.kind === 'platform') {
    if (dep.tenant !== 'default' && !dep.note) {
      throw new Error(
        `[tenant] deployment registry for "${dep.tenant}" is kind "platform" without a note — say why this tenant runs on the shared platform contracts`
      );
    }
    return dep;
  }
  if (dep.tenant === 'default') {
    throw new Error('[tenant] the default tenant is the platform deployment (addresses.ts), not a dedicated one');
  }
  const problems = dedicatedProblems(dep, platformAddressSet(dep.chainId, extraPlatformAddresses));
  if (problems.length) {
    throw new Error(
      `[tenant] deployment registry for "${dep.tenant}" breaks tenant isolation:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
  }
  return dep;
}

// ── 專屬部署沒有的合約 → 不能授權的功能 ──────────────────────────────────

/**
 * 只存在於平台部署的合約所支撐的功能。專屬部署沒有 PepeToken／PepeAMM／PepeClaim／
 * PepeStaking／PepeIncentives／EsgRewardDistributor，租戶設定若授權了這些功能，頁面會對
 * 零位址發請求。寧可讓 build 失敗，也不出貨一個按了沒反應的功能。
 */
export const PLATFORM_ONLY_FEATURES = ['gamefi', 'pepeRewards'] as const;

export function deploymentFeatureProblems(
  dep: TenantDeployment,
  features: Readonly<Record<string, { allowed: boolean }>>
): string[] {
  if (dep.kind !== 'dedicated') return [];
  return PLATFORM_ONLY_FEATURES.filter((key) => features[key]?.allowed).map(
    (key) =>
      `features.${key}.allowed is true, but a dedicated deployment has none of the platform-only contracts behind it — set it to false`
  );
}

// ── 解析成前端用的 getter ────────────────────────────────────────────────

export type V2Stack = NonNullable<ReturnType<typeof getV2Stack>>;

export interface ResolvedDeployment {
  kind: TenantDeployment['kind'];
  /** 每條鏈的 V1 形狀位址表（useContracts 用）。 */
  chainMap: Readonly<Record<number, ChainAddresses>>;
  getAddresses: (chainId: number | null) => ChainAddresses | null;
  getV2Stack: (chainId: number | null) => V2Stack | undefined;
  hasV2Stack: (chainId: number | null) => boolean;
  getSynthTokens: (chainId: number | null) => Partial<Record<AssetSymbol, string>>;
  /** 專屬部署在該鏈的 AgentSessionManager；platform 回 undefined（由 sessionManager.ts 的表決定）。 */
  dedicatedSessionManager: (chainId: number | null) => string | undefined;
  x402FeeRouter: (chainId: number | null) => string | undefined;
  /** `/legacy` 的舊合約表只屬於平台部署；專屬部署沒有任何舊合約。 */
  legacyExchangesFor: (chainId: number | null | undefined) => readonly LegacyExchange[];
}

/** 專屬部署 → V1 形狀的位址表。租戶沒有的合約是零位址，UI 的「未部署」守衛會處理。 */
export function dedicatedChainAddresses(d: DedicatedDeployment): ChainAddresses {
  const c = d.contracts;
  return {
    MockUSDC: c.SettlementToken,
    MockUSDT: ZERO,
    // 租戶 exchange 讀的那一個 oracle（GuardedOracle 與 MockOracle 的讀取介面相同）。
    MockOracle: c.Oracle,
    TraderStake: c.TraderStake,
    InsuranceVault: c.InsuranceVault,
    FeeRouter: c.FeeRouter,
    PerpetualExchange: c.PerpetualExchange,
    StrategyRegistry: c.StrategyRegistry,
    CopyTracker: c.CopyTracker,
    MockSwapRouter: ZERO,
    // 與平台的 Base Sepolia 相同的慣例：ESGRegistry 這一格放的是 ESGRegistryV2。
    ESGRegistry: c.ESGRegistryV2,
    KYCRegistry: c.KYCRegistry,
    PepeAMM: ZERO,
    PepeToken: ZERO,
    PepeClaim: ZERO,
    EsgRewardDistributor: ZERO,
    PepeIncentives: ZERO,
    PepeStaking: ZERO,
    AssetVault: ZERO,
  };
}

const NO_TOKENS: Partial<Record<AssetSymbol, string>> = Object.freeze({});
const NO_LEGACY: readonly LegacyExchange[] = Object.freeze([]);

export function resolveDeployment(dep: TenantDeployment): ResolvedDeployment {
  if (dep.kind === 'platform') {
    // 直接轉呼叫 addresses.ts：回傳值與改版前是同一個物件。
    return {
      kind: 'platform',
      chainMap: CHAIN_MAP,
      getAddresses,
      getV2Stack,
      hasV2Stack,
      getSynthTokens,
      dedicatedSessionManager: () => undefined,
      x402FeeRouter: (chainId) => (chainId === null ? undefined : X402_FEE_ROUTER[chainId]),
      legacyExchangesFor,
    };
  }

  // 專屬部署：只有它自己的那條鏈。其他鏈（含平台的 Sepolia、本機 Anvil）一律「不支援」，
  // 不能讓租戶的站在換鏈之後悄悄連到平台的合約。
  const addresses = Object.freeze(dedicatedChainAddresses(dep));
  const c = dep.contracts;
  const stack: V2Stack | undefined = c.AssetVaultV2
    ? Object.freeze({
        GuardedOracle: c.Oracle,
        AssetVaultV2: c.AssetVaultV2,
        ESGRegistryV2: c.ESGRegistryV2,
        tokens: Object.freeze({ ...(dep.tokens ?? {}) }),
      })
    : undefined;
  const here = (chainId: number | null | undefined) => chainId === dep.chainId;
  return {
    kind: 'dedicated',
    chainMap: Object.freeze({ [dep.chainId]: addresses }),
    getAddresses: (chainId) => (here(chainId) ? addresses : null),
    getV2Stack: (chainId) => (here(chainId) ? stack : undefined),
    hasV2Stack: (chainId) => here(chainId) && !!stack,
    // V1 的代幣化資產（AssetVault V1）不屬於專屬部署。
    getSynthTokens: () => NO_TOKENS,
    dedicatedSessionManager: (chainId) => (here(chainId) ? c.AgentSessionManager : ZERO),
    x402FeeRouter: (chainId) => (here(chainId) ? c.X402FeeRouter : undefined),
    legacyExchangesFor: () => NO_LEGACY,
  };
}
