// 建置期（Node 端）讀租戶設定檔。只有 vite.config.ts 與測試會 import 這個檔案；
// 瀏覽器端走 src/tenant/index.ts，經 `@tenant-config` alias 拿到**同一個** JSON。
//
// 為什麼用 alias 而不是把所有租戶都 import 進來再挑：那樣每個租戶的 bundle 都會帶著
// 其他所有租戶的設定（機構名稱、聯絡方式、上架資產）。白標客戶彼此是競爭者，
// A 銀行的站不該讓人從 JS 裡讀到 B 銀行的設定。alias 讓 bundle 裡只有被選中的那一份。

import fs from 'node:fs';
import path from 'node:path';

import { parseTenant, tenantIdFrom, type TenantConfig } from './schema';

// ----------------------------------------------------------------------

/** 租戶設定檔所在目錄（相對於 frontend/）。 */
export const TENANTS_DIR = path.join('src', 'tenant', 'tenants');

export function tenantConfigPath(frontendRoot: string, id: string): string {
  return path.resolve(frontendRoot, TENANTS_DIR, `${id}.json`);
}

/** 列出所有租戶 id（依檔名）。 */
export function listTenantIds(frontendRoot: string): string[] {
  return fs
    .readdirSync(path.resolve(frontendRoot, TENANTS_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * 依 `VITE_TENANT` 的原始值載入並驗證租戶設定。任何問題（名字不合法、檔案不存在、
 * JSON 壞掉、schema 不過）都丟錯，讓 build 失敗。
 */
export function loadTenantForBuild(
  frontendRoot: string,
  rawTenant: unknown
): { id: string; file: string; config: TenantConfig } {
  const id = tenantIdFrom(rawTenant);
  const file = tenantConfigPath(frontendRoot, id);
  if (!fs.existsSync(file)) {
    const known = listTenantIds(frontendRoot).join(', ');
    throw new Error(
      `[tenant] no config file for tenant "${id}" at ${file}. Known tenants: ${known}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `[tenant] config file for tenant "${id}" is not valid JSON: ${(e as Error).message}`,
      { cause: e }
    );
  }
  return { id, file, config: parseTenant(raw, id) };
}
