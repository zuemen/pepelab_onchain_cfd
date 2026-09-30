// SDK 的 signal-api 型別 vs docs/api/openapi.yaml：
//   • 每個 schema 的欄位集合、必填集合完全相同（SDK 端的清單由 tsc 保證與 TS 型別一致）；
//   • OPERATIONS 的每個端點都在 openapi 的 paths 裡，方法相同，付費與否與 security: x402 一致；
//   • openapi 的 GET 端點（/demo 以外）SDK 都有對應方法。
//   cd agent && npx tsx sdk/test/openapi-schema.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import {
  SIGNAL_API_TESTNET_URL,
  INLINE_SCHEMA_KEYS,
  OPERATIONS,
  SCHEMA_KEYS,
  ASSET_SYMBOLS,
} from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const spec = parse(readFileSync(resolve(ROOT, "docs/api/openapi.yaml"), "utf8")) as any;
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const sorted = (a: Iterable<string>) => [...a].sort();

function compareSchema(label: string, schema: any, keys: { all: readonly string[]; required: readonly string[] }) {
  assert.ok(schema?.properties, `${label}：openapi 沒有 properties`);
  assert.deepEqual(sorted(Object.keys(schema.properties)), sorted(keys.all), `${label}：欄位集合與 openapi 不同`);
  if (Array.isArray(schema.required)) {
    assert.deepEqual(sorted(schema.required), sorted(keys.required), `${label}：必填集合與 openapi 不同`);
  }
}

// 1) components.schemas
{
  const schemas = spec.components.schemas;
  for (const [name, keys] of Object.entries(SCHEMA_KEYS)) compareSchema(name, schemas[name], keys);
  // 反向：openapi 有、SDK 沒有型別的 schema 要明確列出理由
  const untyped = Object.keys(schemas).filter((k) => !(k in SCHEMA_KEYS));
  assert.deepEqual(untyped, [], `openapi 有 SDK 未比對的 schema：${untyped.join(", ")}`);
  ok(`components.schemas 共 ${Object.keys(SCHEMA_KEYS).length} 個，欄位與必填集合全部一致`);
}

// 2) 內嵌在 paths 的回應 schema
{
  for (const [key, keys] of Object.entries(INLINE_SCHEMA_KEYS)) {
    const [method, path, status] = key.split(" ");
    const schema = spec.paths[path!][method!.toLowerCase()].responses[status!].content["application/json"].schema;
    compareSchema(key, schema, keys);
  }
  ok("內嵌回應 schema（/risk/exposure、/agent/{did}/verification）一致");
}

// 3) 端點目錄
{
  for (const [name, op] of Object.entries(OPERATIONS)) {
    const item = spec.paths[op.path];
    assert.ok(item, `${name}：openapi 沒有 ${op.path}`);
    const o = item[op.method.toLowerCase()];
    assert.ok(o, `${name}：${op.path} 沒有 ${op.method}`);
    assert.equal(o.operationId, name, `${name}：operationId 不同（openapi 為 ${o.operationId}）`);
    const paid = Array.isArray(o.security) && o.security.some((s: any) => "x402" in s);
    assert.equal(paid, op.paid, `${name}：付費與否與 openapi 的 security 不同`);
    if (op.paid) {
      for (const code of ["402", "503"]) assert.ok(o.responses[code], `${name}：付費端點應有 ${code}`);
    }
  }
  const sdkPaths = new Set(Object.values(OPERATIONS).map((o) => `${o.method} ${o.path}`));
  const specGets = Object.entries(spec.paths)
    .flatMap(([p, item]: [string, any]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`))
    .filter((k) => !k.includes("/demo/"));
  const missing = specGets.filter((k) => !sdkPaths.has(k));
  assert.deepEqual(missing, [], `openapi 有、SDK 沒有的端點：${missing.join(", ")}`);
  ok(`端點目錄 ${Object.keys(OPERATIONS).length} 個與 openapi paths／operationId／security 一致（/demo 刻意不包）`);
}

// 4) 其他一致性：伺服器 URL、/oracle 的資產列舉
{
  assert.equal(spec.servers[0].url, SIGNAL_API_TESTNET_URL);
  const assetEnum = spec.paths["/oracle/{asset}"].get.parameters[0].schema.enum;
  assert.deepEqual(sorted(assetEnum), sorted(ASSET_SYMBOLS));
  const req = spec.components.schemas.PaymentRequirements.properties;
  assert.equal(req.scheme.const, "exact");
  ok("預設 base URL、/oracle 資產列舉、x402 scheme 與 openapi 一致");
}

console.log(`\n✅ sdk openapi-schema.test.ts 全過（${n} 項）`);
