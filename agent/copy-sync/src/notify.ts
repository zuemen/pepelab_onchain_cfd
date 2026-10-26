// 選用的結果通知：POST JSON 到 --notify-webhook，讓跟隨者本人（或他的其他 agent）知道
// 「同步成功了」、「為什麼被擋」（KYC、休市、油箱不足……），以及（personal 模式）「交易者發布了新版」——
// 沒開自動同步、或指定了別的執行者的跟單也會收到，讓本人到投資組合檢視新版內容後手動同步。
//
// - webhook 網址本身常是憑證（Slack／Discord），日誌一律遮蔽（log.ts）。
// - 只允許 https；http 只允許 localhost／127.0.0.1／::1（本機測試）。
// - 通知失敗不影響同步：記一行 warning 就繼續。逾時 5 秒。
// - 不重複轟炸：同一筆 record 的同一個狀態＋原因只通知一次（engine.ts 用 lastNotified 去重）。

/**
 * - resynced：同步成功（含新腿數與重新部署的保證金）。
 * - blocked：被合約擋下（油箱、費率同意、KYC、休市…；冷卻不通知，new-version 已附預計時間）。
 * - new-version：交易者發布了新版（只在 personal 模式，每一版一次）。`autoSync` 為 true 時本執行者會在
 *   `retryAt` 之後代為同步；false（或指定了別的執行者）時要本人手動同步。
 * - tx-failed／tx-unconfirmed：送出的交易上鏈後 revert／等確認逾時。
 */
export type NotifyKind = "resynced" | "blocked" | "new-version" | "dropped" | "tx-failed" | "tx-unconfirmed";

export interface NotifyPayload {
  source: "pepefi-copy-sync";
  kind: NotifyKind;
  chainId: number;
  copyTracker: string;
  follower: string;
  recordIdx: number;
  trader: string;
  fromVersion: number | null;
  toVersion: number | null;
  /** 分類代碼（errors.ts 的 RevertCategory）或 null。 */
  category: string | null;
  /** 這筆跟單在鏈上是否開著自動同步。 */
  autoSync: boolean;
  /** 繁中說明（不含秘密）。 */
  message: string;
  txHash: string | null;
  executor: string | null;
  /** 下次重試的時間（ISO）；不再重試時為 null。 */
  retryAt: string | null;
  at: string;
}

export type Notifier = (p: NotifyPayload) => Promise<void>;

/** 驗證 webhook 網址；不合格回傳理由。 */
export function webhookUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "--notify-webhook 不是合法網址";
  }
  if (u.protocol === "https:") return null;
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol === "http:" && local) return null;
  return "--notify-webhook 只接受 https（本機測試可用 http://localhost）";
}

export function makeWebhookNotifier(
  url: string,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    onError?: (msg: string) => void;
  } = {},
): Notifier {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async (p) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
        signal: ctl.signal,
        redirect: "error",
      });
      if (!res.ok) opts.onError?.(`通知 webhook 回應 HTTP ${res.status}（${p.kind} ${p.follower}#${p.recordIdx}）`);
    } catch (e) {
      const why = (e as Error)?.name === "AbortError" ? `逾時（${timeoutMs} ms）` : "連線失敗";
      opts.onError?.(`通知 webhook ${why}（${p.kind} ${p.follower}#${p.recordIdx}）`);
    } finally {
      clearTimeout(t);
    }
  };
}

export const noopNotifier: Notifier = async () => {};
