// Cloudflare Worker：用可靠的 cron 觸發 GitHub 上的 keeper workflow。
// 這個 Worker 不持有任何鏈上金鑰；它只有一個 GitHub fine-grained token，
// 權限限定為 zuemen/pepelab_onchain_cfd 的 Actions: Read and write。
// 部署與權限設定見同目錄 README.md。
import { decide } from "./decide.mjs";

const API = "https://api.github.com";

async function gh(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "pepelab-keeper-trigger",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;

/**
 * 要照顧的 workflow 清單。WORKFLOW_FILES（逗號分隔）優先，舊的單一 WORKFLOW_FILE 仍可用。
 * 檔名只接受 `name.yml`／`name.yaml`，避免把設定值拼進 API 路徑時被塞入 `../`。
 */
export function workflowsOf(env) {
  const raw = env.WORKFLOW_FILES ?? env.WORKFLOW_FILE ?? "base-sepolia-keeper.yml";
  const list = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("WORKFLOW_FILES 是空的");
  for (const w of list) {
    if (!WORKFLOW_NAME.test(w)) throw new Error(`不合法的 workflow 檔名：${w}`);
  }
  return [...new Set(list)];
}

async function tickOne(env, repo, workflow, ref, minGap, nowMs) {
  const runsRes = await gh(env, `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`);
  let latest = null;
  if (runsRes.ok) latest = (await runsRes.json()).workflow_runs?.[0] ?? null;
  else console.log(`[${workflow}] list runs failed: HTTP ${runsRes.status}`);

  const d = decide(latest, nowMs, minGap);
  console.log(`[${workflow}] decide: dispatch=${d.dispatch} (${d.reason})`);
  if (!d.dispatch) return { workflow, ...d };

  const res = await gh(env, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) {
    throw new Error(`[${workflow}] dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return { workflow, ...d };
}

/**
 * 每個 workflow 各自判斷、各自觸發。一個失敗不影響其他的；全部跑完後，只要有任何
 * 失敗就丟出（讓 Cloudflare 把這次 cron 記成失敗）。
 *
 * 2026-10-01：Ethereum Sepolia 的 price-keeper 同樣被 GitHub 排程節流到 4–5 小時一次，
 * oracle-health 開了過期 issue（#208）。原本只照顧 base-sepolia-keeper。
 */
export async function tick(env, nowMs = Date.now()) {
  const repo = env.GITHUB_REPO;
  const ref = env.WORKFLOW_REF ?? "master";
  const minGap = Number(env.MIN_GAP_SEC ?? 900);
  if (!env.GITHUB_TOKEN || !repo) throw new Error("GITHUB_TOKEN / GITHUB_REPO 未設定");
  const workflows = workflowsOf(env);

  const settled = await Promise.allSettled(
    workflows.map((w) => tickOne(env, repo, w, ref, minGap, nowMs)),
  );
  const errors = settled.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? String(r.reason));
  if (errors.length) throw new Error(errors.join("; "));
  return settled.map((r) => r.value);
}

export default {
  // 直接 await（審查 M3）：tick 丟錯時 scheduled 的 promise 會 reject，Cloudflare 才會把
  // 這次 cron 記成失敗。改用 ctx.waitUntil 的話 handler 先回傳成功，失敗只剩 log。
  async scheduled(_event, env) {
    await tick(env);
  },
  // 不接受任何 HTTP 觸發：公開 URL 不該能替別人消耗 Actions 或讓 keeper 被洗版。
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
