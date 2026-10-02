// 建置期（Node 端）讀部署登記檔。只有 vite.config.ts 與測試會 import 這個檔案；
// 瀏覽器端走 ./selectedDeployment.ts，經 `@tenant-deployment` alias 拿到同一個 JSON。

import fs from 'node:fs';
import path from 'node:path';

import { resolveSignalApiUrl } from '../lib/pepefi/signalApiUrl';
import {
  parseTenantDeployment,
  type TenantDeployment,
  deploymentFeatureProblems,
} from './tenantDeployment';

// ----------------------------------------------------------------------

/** 部署登記檔所在目錄（相對於 frontend/）。 */
export const DEPLOYMENTS_DIR = path.join('src', 'contracts', 'deployments');

/** 平台已退役合約的機器可讀清單（相對於 frontend/）。只在建置期讀，不進瀏覽器 bundle。 */
export const RETIRED_PLATFORM_FILE = path.join('src', 'contracts', 'retiredPlatformAddresses.json');

/** 退役清單裡的位址。檔案壞掉就丟錯：讀不懂清單時不能默默少擋。 */
export function retiredPlatformAddresses(frontendRoot: string): string[] {
  const file = path.resolve(frontendRoot, RETIRED_PLATFORM_FILE);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { addresses?: { address?: unknown }[] };
  if (!Array.isArray(raw.addresses) || raw.addresses.length === 0) {
    throw new Error(`[tenant] ${file}: "addresses" must be a non-empty array`);
  }
  return raw.addresses.map((e, i) => {
    if (typeof e.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(e.address)) {
      throw new Error(`[tenant] ${file}: addresses[${i}].address is not an address`);
    }
    return e.address;
  });
}

/**
 * 審查 F4：專屬租戶的 build 必須明確設定自己的 signal-api。沒設時 app 會退回平台的
 * signal-api（DEFAULT_SIGNAL_API_URL），租戶的使用者就會在自己的站上看到平台 exchange 的
 * 訊號、funding 與新鮮度，再拿去租戶自己的 exchange 下單。平台與示範租戶（kind: platform）
 * 本來就連平台的 signal-api，行為不變。
 */
export function dedicatedSignalApiProblem(
  deployment: TenantDeployment,
  raw: string | undefined | null
): string | null {
  if (deployment.kind !== 'dedicated') return null;
  if (!raw || raw.trim() === '') {
    return `tenant "${deployment.tenant}" is a dedicated deployment: set VITE_SIGNAL_API_URL to the tenant's own signal-api (leaving it unset falls back to the platform's signal-api)`;
  }
  if (resolveSignalApiUrl(raw.trim()) === resolveSignalApiUrl(undefined)) {
    return `tenant "${deployment.tenant}" is a dedicated deployment: VITE_SIGNAL_API_URL points at the platform's signal-api`;
  }
  return null;
}

export function tenantDeploymentPath(frontendRoot: string, id: string): string {
  return path.resolve(frontendRoot, DEPLOYMENTS_DIR, `${id}.json`);
}

/** 列出所有有登記檔的租戶 id（依檔名）。 */
export function listDeploymentIds(frontendRoot: string): string[] {
  return fs
    .readdirSync(path.resolve(frontendRoot, DEPLOYMENTS_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * 載入並驗證被選中租戶的部署登記。**沒有登記檔就丟錯**——不退回平台部署
 * （見 ./tenantDeployment.ts 開頭）。`id` 必須是已經過 tenantIdFrom() 的租戶 id。
 */
export function loadTenantDeploymentForBuild(
  frontendRoot: string,
  id: string,
  features?: Readonly<Record<string, { allowed: boolean }>>
): { file: string; deployment: TenantDeployment } {
  const file = tenantDeploymentPath(frontendRoot, id);
  if (!fs.existsSync(file)) {
    throw new Error(
      `[tenant] no deployment registry for tenant "${id}" at ${file}. ` +
        `A tenant never falls back to the platform contracts silently: add the file — ` +
        `kind "dedicated" with the tenant's own addresses, or kind "platform" with a note. ` +
        `Registered: ${listDeploymentIds(frontendRoot).join(', ')}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `[tenant] deployment registry for tenant "${id}" is not valid JSON: ${(e as Error).message}`
    );
  }
  const deployment = parseTenantDeployment(raw, id, retiredPlatformAddresses(frontendRoot));
  // 租戶設定授權的功能，這個部署必須真的有對應的合約。
  const problems = features ? deploymentFeatureProblems(deployment, features) : [];
  if (problems.length) {
    throw new Error(
      `[tenant] tenant "${id}" authorizes features its deployment cannot serve:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
  }
  return { file, deployment };
}
