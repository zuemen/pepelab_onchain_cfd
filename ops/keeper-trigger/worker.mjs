// Cloudflare Worker：用可靠的 cron 觸發 GitHub 上的 keeper workflow。
// 這個 Worker 不持有任何鏈上金鑰；它只有一個 GitHub 憑證，權限限定為
// zuemen/pepelab_onchain_cfd 的 Actions: Read and write。憑證二擇一：
//   - GitHub App（GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID、secret GITHUB_APP_PRIVATE_KEY）：
//     用私鑰換一小時的 installation token，觸發者顯示為 `<app-slug>[bot]`。
//   - 擁有者本人的 fine-grained PAT（secret GITHUB_TOKEN）：未設定 App 時沿用。
// 兩者都設定時用 App。部署與權限設定見同目錄 README.md。
import { decide } from "./decide.mjs";
import { appConfigOf, getInstallationToken, invalidateAppToken, redact } from "./github-app.mjs";

const API = "https://api.github.com";

/**
 * 決定這一次 tick 用哪個憑證。App 設定不完整、金鑰格式錯、換 token 被拒（401／403…）
 * 都會丟錯，不會退回 PAT：退回去的話 run 的觸發者會變回擁有者本人，而且沒有人會發現。
 * @returns {Promise<{ token: string, kind: "app" | "pat" }>}
 */
export async function resolveAuth(env, nowMs = Date.now()) {
  const app = appConfigOf(env);
  if (app) {
    if (env.GITHUB_TOKEN) console.log("auth: GitHub App 與 GITHUB_TOKEN 都有設定，使用 GitHub App（GITHUB_TOKEN 可以移除）");
    const t = await getInstallationToken(app, env.GITHUB_REPO, nowMs);
    const left = t.expiresAtMs == null ? "unknown" : `${Math.floor((t.expiresAtMs - nowMs) / 1000)}s`;
    console.log(`auth: GitHub App installation token（${t.fromCache ? "cached" : "new"}，expires in ${left}）`);
    return { token: t.token, kind: "app" };
  }
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN（或 GitHub App 的三項設定）未設定");
  return { token: env.GITHUB_TOKEN, kind: "pat" };
}

async function gh(auth, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${auth.token}`,
      "User-Agent": "pepelab-keeper-trigger",
      // 固定在 2022-11-28：這個版本的 dispatch 在沒帶 return_run_details 時回 204。
      // 2026-03-10 版改成一律回 200＋run ID；要升版時 tickOne 的 204 判斷要一起改。
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  // 快取中的 installation token 被拒：丟掉它，下一次 cron 重新換。
  if (res.status === 401 && auth.kind === "app") invalidateAppToken(auth.token);
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

async function tickOne(auth, repo, workflow, ref, minGap, nowMs) {
  const runsRes = await gh(auth, `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`);
  let latest = null;
  if (runsRes.ok) latest = (await runsRes.json()).workflow_runs?.[0] ?? null;
  else console.log(`[${workflow}] list runs failed: HTTP ${runsRes.status}`);

  const d = decide(latest, nowMs, minGap);
  console.log(`[${workflow}] decide: dispatch=${d.dispatch} (${d.reason})`);
  if (!d.dispatch) return { workflow, ...d };

  const res = await gh(auth, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  if (res.status !== 204) {
    throw new Error(`[${workflow}] dispatch failed: HTTP ${res.status} ${redact(await res.text(), [auth.token]).slice(0, 200)}`);
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
  if (!repo) throw new Error("GITHUB_REPO 未設定");
  const workflows = workflowsOf(env);
  // 憑證在分流之前取一次：多個 workflow 共用同一個 token，不會同時各換一個。
  const auth = await resolveAuth(env, nowMs);

  const settled = await Promise.allSettled(
    workflows.map((w) => tickOne(auth, repo, w, ref, minGap, nowMs)),
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
