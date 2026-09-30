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

export async function tick(env, nowMs = Date.now()) {
  const repo = env.GITHUB_REPO;
  const workflow = env.WORKFLOW_FILE ?? "base-sepolia-keeper.yml";
  const ref = env.WORKFLOW_REF ?? "master";
  const minGap = Number(env.MIN_GAP_SEC ?? 900);
  if (!env.GITHUB_TOKEN || !repo) throw new Error("GITHUB_TOKEN / GITHUB_REPO 未設定");

  const runsRes = await gh(env, `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`);
  let latest = null;
  if (runsRes.ok) latest = (await runsRes.json()).workflow_runs?.[0] ?? null;
  else console.log(`list runs failed: HTTP ${runsRes.status}`);

  const d = decide(latest, nowMs, minGap);
  console.log(`decide: dispatch=${d.dispatch} (${d.reason})`);
  if (!d.dispatch) return d;

  const res = await gh(env, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) {
    // 丟出讓 Cloudflare 記錄成失敗的 cron 執行（可在 dashboard 看到）。
    throw new Error(`dispatch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return d;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // 不接受任何 HTTP 觸發：公開 URL 不該能替別人消耗 Actions 或讓 keeper 被洗版。
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
