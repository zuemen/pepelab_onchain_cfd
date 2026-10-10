// ADR-016 撤銷檢查的驗證端狀態（sequence 高水位、同號異文偵測、sticky 撤銷）的共享儲存：
// Upstash Redis（與 KYA 花費帳、x402 記帳同一個 DB）。設計與取捨見 docs/ADR-021-signal-api-shared-state.md。
//
// 為什麼需要：Vercel 上每個實例各有一份 /tmp 狀態檔，互不相通。實例 A 接受過 sequence 5（撤銷了 X）之後，
// 冷啟動的實例 B 會接受任何仍在 validUntil 內、簽章正確的舊清單（sequence 4，沒有 X）——防回滾與
// sticky 撤銷只在同一個暖實例內成立（docs/tenants/rwa-poc/ONLINE.md 的已知限制）。
//
// 怎麼做到原子：樂觀並行控制（compare-and-set）。每個 `${verifyingContract}|${issuer}` 兩個 key：
//   <prefix>ver:<key>    版本號（"1"、"2"…；每次成功寫入 +1）
//   <prefix>state:<key>  IssuerStatusState 的 JSON
// accept：MGET 兩個 key（單一指令＝一致的快照）→ 以 shared 的 mergeIssuerStatusState 合併（與檔案、記憶體版
// **同一套規則**）→ EVAL「版本號仍是剛才讀到的那個才寫入」。被別的實例搶先寫入 → 重讀、重合併（最多
// DEFAULT_CAS_ATTEMPTS 次）。所以：
//   - 高水位只升不降：較舊的清單在重讀後一律 STATUS_LIST_REPLAYED，不會蓋掉較新的狀態；
//   - 撤銷是聯集：兩個實例同時接受不同清單，後寫的那個一定是合併過先寫者的狀態；
//   - 合併規則只在 JS 一處（可離線測），Lua 只做字串比較與兩個 SET——沒有 cjson、沒有要在 Redis 裡重寫的邏輯。
// 任何讀寫失敗（連不上、格式不符、兩個 key 只剩一個）都是 STATUS_STATE_*：寫入類一律拒絕（fail-closed）。
//
// 不設 TTL：刪掉狀態＝忘記高水位與 sticky 撤銷（與刪狀態檔相同，ADR-016 §7）。key 數量的上界是「在
// VC_STATUS_URL 發佈過清單的簽發者數」——清單來源由營運方控管，請求方無法憑空製造新 key。
import {
  defaultStatusStatePath,
  mergeIssuerStatusState,
  parseIssuerStatusState,
  setVcStatusStateStore,
  type AcceptResult,
  type IssuerStatusState,
  type StatusStateStore,
} from "@pepelab/shared";

/** 送一個 Upstash REST 指令（body = ["CMD", ...args]），回傳 result。失敗丟錯。 */
export type UpstashCommand = <T>(cmd: (string | number)[]) => Promise<T>;

export const VC_STATUS_KV_PREFIX = "vc:status:";
/** 寫入被別的實例搶先時，最多重讀重合併幾次（serverless 的實際競爭極低；用盡＝本次 fail-closed）。 */
export const DEFAULT_CAS_ATTEMPTS = 8;

// KEYS: ver key, state key   ARGV: 讀到的版本號（沒有＝""）, 新版本號, 新狀態 JSON。1 = 已寫入，0 = 版本已變。
// redis.call('GET', 不存在的 key) 在 Lua 裡是 false，`or ''` 讓「沒有紀錄」與 ARGV[1]="" 比對。
export const VC_STATUS_CAS_SCRIPT = `-- pepelab:vcstatus_cas
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1`;

function upstashCreds(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } | null {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

/** 預設的 REST 指令（與 ledger.ts、kya.ts 同一個端點與格式；每次呼叫時讀 env）。 */
export const upstashRestCommand: UpstashCommand = async <T>(cmd: (string | number)[]): Promise<T> => {
  const c = upstashCreds();
  if (!c) throw new Error("VC 狀態共享儲存需要 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  const res = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`Upstash ${cmd[0]} 失敗：${body.error ?? res.statusText}`);
  return body.result as T;
};

export interface UpstashVcStatusStoreOptions {
  /** 指令傳輸（測試注入；預設 upstashRestCommand）。 */
  command?: UpstashCommand;
  /** key 前綴（預設 VC_STATUS_KV_PREFIX）。 */
  prefix?: string;
  /** compare-and-set 最多嘗試幾次（預設 DEFAULT_CAS_ATTEMPTS）。 */
  maxAttempts?: number;
}

interface Snapshot {
  /** 讀到的版本號字串（沒有紀錄＝""，原樣送回 CAS 比對）。 */
  ver: string;
  state: IssuerStatusState | null;
}

/** Upstash 版 StatusStateStore（非同步；以 setVcStatusStateStore 注入，或直接給 createVcStatusChecker）。 */
export function upstashVcStatusStateStore(o: UpstashVcStatusStoreOptions = {}): StatusStateStore {
  const command = o.command ?? upstashRestCommand;
  const prefix = o.prefix ?? VC_STATUS_KV_PREFIX;
  const attempts = Math.max(1, Math.floor(o.maxAttempts ?? DEFAULT_CAS_ATTEMPTS));
  const verKey = (k: string) => `${prefix}ver:${k}`;
  const stateKeyOf = (k: string) => `${prefix}state:${k}`;

  /** 一致的快照；格式不符或兩個 key 只剩一個 → 丟錯（呼叫端視為狀態不明，寫入拒絕）。 */
  async function read(key: string): Promise<Snapshot> {
    const r = await command<(string | null)[] | null>(["MGET", verKey(key), stateKeyOf(key)]);
    const [ver, raw] = Array.isArray(r) ? r : [null, null];
    if (ver == null && raw == null) return { ver: "", state: null };
    if (ver == null || raw == null || !/^[1-9][0-9]{0,14}$/.test(ver)) {
      throw new Error("vc status 共享狀態不一致（版本號與狀態缺一或版本號格式不符）");
    }
    return { ver, state: parseIssuerStatusState(JSON.parse(raw)) };
  }

  return {
    async get(key) {
      return (await read(key)).state;
    },
    async accept(key, list, nowSec): Promise<AcceptResult> {
      for (let i = 0; i < attempts; i++) {
        let snap: Snapshot;
        try {
          snap = await read(key);
        } catch (e) {
          return { ok: false, reasonCode: "STATUS_STATE_UNREADABLE", message: `VC 共享狀態無法讀取或格式不符（fail-closed）：${(e as Error)?.message ?? e}` };
        }
        const r = mergeIssuerStatusState(snap.state, list, nowSec);
        // 拒絕（重放／同號異文），或同一份清單（狀態不變）：不寫。
        if (!r.ok || r.state === snap.state) return r;
        const next = String(Number(snap.ver || "0") + 1);
        let won: boolean;
        try {
          won = Number(await command<number>(["EVAL", VC_STATUS_CAS_SCRIPT, 2, verKey(key), stateKeyOf(key), snap.ver, next, JSON.stringify(r.state)])) === 1;
        } catch (e) {
          // 寫入結果不明（可能已寫入）：本次 fail-closed；下一個請求重讀就會看到實際狀態。
          return { ok: false, reasonCode: "STATUS_STATE_WRITE_FAILED", message: `VC 共享狀態無法寫入（fail-closed）：${(e as Error)?.message ?? e}` };
        }
        if (won) return r;
        // 被別的實例搶先：重讀、以新狀態重新合併（較舊的清單會在這裡變成 STATUS_LIST_REPLAYED）。
      }
      return {
        ok: false,
        reasonCode: "STATUS_STATE_LOCK_FAILED",
        message: `VC 共享狀態寫入競爭：compare-and-set 連續 ${attempts} 次被搶先（fail-closed）`,
      };
    },
  };
}

// ── 由環境變數決定要不要注入 ───────────────────────────────────────────────────

export type VcStatusStateStoreMode = "upstash" | "file";

let warnedInvalid = false;

/**
 * VC_STATUS_STATE_STORE：
 *   未設（預設）  有 UPSTASH_REDIS_REST_URL／TOKEN → upstash；沒有 → file（單機，本機開發）
 *   upstash       一律 upstash（沒有 Upstash 設定 → 每次檢查都 STATUS_STATE_UNREADABLE，寫入拒絕；不會悄悄退回單機）
 *   file          一律單機檔案 VC_STATUS_STATE_PATH（即使有 Upstash；只給單機開發）
 * 其他值：印 ::error::，照「未設」處理。
 */
export function resolveVcStatusStateStoreMode(env: NodeJS.ProcessEnv = process.env): VcStatusStateStoreMode {
  const raw = env.VC_STATUS_STATE_STORE?.trim().toLowerCase();
  if (raw === "upstash" || raw === "file") return raw;
  if (raw && !warnedInvalid) {
    warnedInvalid = true;
    console.error(`::error::[vc-status] VC_STATUS_STATE_STORE=${raw} 無法辨識（只接受 upstash／file），改用預設（有 Upstash 設定就共用）`);
  }
  return upstashCreds(env) ? "upstash" : "file";
}

let installed: StatusStateStore | null = null;

/**
 * signal-api 啟動時呼叫（KYA 開啟時，app.ts kyaFromEnv）：依 VC_STATUS_STATE_STORE 注入 Upstash 版，
 * 或維持單機檔案。回傳給啟動 log 的描述。
 */
export function installVcStatusStateStore(
  env: NodeJS.ProcessEnv = process.env,
  o: UpstashVcStatusStoreOptions = {},
): string {
  if (resolveVcStatusStateStoreMode(env) === "upstash") {
    installed = upstashVcStatusStateStore(o);
    setVcStatusStateStore(installed, "upstash");
    return "upstash（跨實例共用）";
  }
  // 只撤掉自己先前注入的那一個（測試或其他呼叫端注入的不動）。
  if (installed) {
    setVcStatusStateStore(null);
    installed = null;
  }
  return `單機檔案 ${defaultStatusStatePath()}（多實例部署請設 Upstash）`;
}
