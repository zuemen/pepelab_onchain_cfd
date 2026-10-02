// 這個 build 要連的合約位址。**所有會依租戶而不同的位址都從這裡拿**：
//
//   import { getAddresses, getV2Stack } from 'src/contracts/deployment'
//
// 不要直接從 'src/contracts/addresses' 拿 getAddresses／getV2Stack／CHAIN_MAP…——那是
// 平台（default 租戶）的部署，專屬租戶的站用了它就會連到平台的合約
// （tenantDeployment.test.ts 用原始碼掃描守住這一條）。
// 與租戶無關的東西照舊從 addresses.ts 拿：ASSET_IDS、CHAIN_NAMES、PRIMARY_CHAIN_ID、型別。
// AgentSessionManager 的位址照舊從 ./sessionManager.ts 拿（它也看這裡的登記）。
//
// default 租戶（kind: "platform"）在這裡拿到的每一個值都與 addresses.ts 的原 getter
// 完全相同（同一個物件）。設計與理由見 frontend/docs/adr/0009-tenant-config-layer.md 的增補。

import { tenantDeployment, resolvedDeployment } from './selectedDeployment';

// ----------------------------------------------------------------------

export { tenantDeployment };

/** 這個 build 是否跑在平台的現行部署上（default 與示範租戶）。 */
export const isPlatformDeployment = resolvedDeployment.kind === 'platform';

export const {
  /** 每條鏈的 V1 形狀位址表。專屬部署只有它自己的那條鏈。 */
  chainMap,
  getAddresses,
  getV2Stack,
  hasV2Stack,
  getSynthTokens,
  /** x402 分潤路由；該鏈沒有就是 undefined。 */
  x402FeeRouter,
  /** `/legacy` 的舊合約表：只屬於平台部署，專屬部署一律是空的。 */
  legacyExchangesFor,
} = resolvedDeployment;
