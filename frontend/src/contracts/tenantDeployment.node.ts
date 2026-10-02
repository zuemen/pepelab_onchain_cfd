// 建置期（Node 端）讀部署登記檔。只有 vite.config.ts 與測試會 import 這個檔案；
// 瀏覽器端走 ./selectedDeployment.ts，經 `@tenant-deployment` alias 拿到同一個 JSON。

import fs from 'node:fs';
import path from 'node:path';

import {
  parseTenantDeployment,
  type TenantDeployment,
  deploymentFeatureProblems,
} from './tenantDeployment';

// ----------------------------------------------------------------------

/** 部署登記檔所在目錄（相對於 frontend/）。 */
export const DEPLOYMENTS_DIR = path.join('src', 'contracts', 'deployments');

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
  const deployment = parseTenantDeployment(raw, id);
  // 租戶設定授權的功能，這個部署必須真的有對應的合約。
  const problems = features ? deploymentFeatureProblems(deployment, features) : [];
  if (problems.length) {
    throw new Error(
      `[tenant] tenant "${id}" authorizes features its deployment cannot serve:\n${problems.map((p) => `  - ${p}`).join('\n')}`
    );
  }
  return { file, deployment };
}
