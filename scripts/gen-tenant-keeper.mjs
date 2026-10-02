#!/usr/bin/env node
// 產生專屬租戶的 keeper workflow：.github/workflows/keeper-<id>.yml。
//
//   node scripts/gen-tenant-keeper.mjs <id>           # 寫出檔案
//   node scripts/gen-tenant-keeper.mjs <id> --check   # 只比對現有檔案（不同就以 1 結束）
//   node scripts/gen-tenant-keeper.mjs <id> --stdout  # 印到 stdout
//   node scripts/gen-tenant-keeper.mjs --template-probe
//        以探測用 id 代入範本、印到 stdout（不要求登記）。CI 的 actionlint job 用它檢查範本本身。
//
// 唯一的輸入是範本 ops/tenant-keeper/keeper.template.yml 與租戶 id；位址不寫進 workflow
// （執行期由 ops/tenant-keeper/load-env.mjs 從部署登記讀）。scripts/check-workflow-guards.mjs
// 會用同一個函式重新產生、逐位元比對——手改產生出來的檔案一定紅燈。
//
// 只為已登記的專屬租戶產生（frontend/src/contracts/deployments/<id>.json，kind=dedicated）：
// kind=platform 的租戶跑在平台的合約上，它的 keeper 就是平台的 keeper。
//
// 這支腳本不建立 GitHub environment、不放任何 secret（那是擁有者的步驟，見
// docs/TENANT_OPERATIONS.md §1.2）。

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TEMPLATE_FILE,
  TENANT_KEEPER_ID,
  listDedicatedTenantIds,
  renderTenantKeeper,
  tenantKeeperFileName,
} from "./lib/tenant-keeper.mjs";

/** 產生的內容一律 LF（.gitattributes 對 *.yml 是 eol=lf；檢查器比對前也會正規化）。 */
export function generate(root, id, { requireRegistered = true } = {}) {
  if (!TENANT_KEEPER_ID.test(id ?? "")) throw new Error(`租戶 id「${id}」格式不合（${TENANT_KEEPER_ID}）`);
  if (requireRegistered && !listDedicatedTenantIds(root).includes(id)) {
    throw new Error(
      `${id} 不是已登記的專屬租戶：frontend/src/contracts/deployments/${id}.json 必須存在且 kind=dedicated`,
    );
  }
  const template = readFileSync(join(root, TEMPLATE_FILE), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return { file: join(root, ".github/workflows", tenantKeeperFileName(id)), text: renderTenantKeeper(template, id) };
}

export const TEMPLATE_PROBE_ID = "zz-template-probe";

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.includes("--template-probe")) {
    process.stdout.write(generate(root, TEMPLATE_PROBE_ID, { requireRegistered: false }).text);
    return 0;
  }
  const id = argv.find((a) => !a.startsWith("--"));
  const { file, text } = generate(root, id);
  if (argv.includes("--stdout")) {
    process.stdout.write(text);
    return 0;
  }
  if (argv.includes("--check")) {
    const same = existsSync(file) && readFileSync(file, "utf8").replace(/\r\n/g, "\n") === text;
    console.log(same ? `${file} 與範本一致 ✓` : `::error::${file} 與範本產生的內容不同（或不存在）`);
    return same ? 0 : 1;
  }
  writeFileSync(file, text);
  console.log(`寫出 ${file}。接著：建立 environment keeper-${id} 並放入 secret（docs/TENANT_OPERATIONS.md §1.2）、開 PR。`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`::error::gen-tenant-keeper：${e.message}`);
    process.exit(2);
  }
}
