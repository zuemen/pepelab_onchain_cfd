// KYC 個資不上鏈：送出的是加鹽雜湊，不是姓名與國籍本身。
//
// 背景：KYCRegistry.submitKYC(string fullName, string nationality) 把兩個參數
// 原樣寫進公開的合約 storage 與 KYCSubmitted 事件。舊版前端直接送明文——任何人都
// 讀得到、永遠刪不掉。使用者已裁定：不改合約（參數型別仍是 string），改送
//
//   nameHash        = keccak256(salt ‖ utf8(normalizeName(fullName)))
//   nationalityHash = keccak256(salt ‖ utf8(normalizeNationality(code)))
//
// salt 是前端產生的 32 bytes 隨機值，連同原始資料只留在使用者端（畫面上顯示、
// 提示自行保存，並寫進這台瀏覽器的 localStorage 方便日後出示）。審核員拿到使用者
// 線下出示的 salt 與原始資料後，用 verifyKycCommitment 重算比對。
//
// 注意：國籍只有幾十種可能，所以**沒有 salt 就無法反推**這件事完全仰賴 salt 保密。

import { hexlify, randomBytes, solidityPackedKeccak256 } from 'ethers'

/** 雜湊方案識別字串。改方案時一定要換版本號，舊收據才驗得回來。 */
export const KYC_COMMITMENT_SCHEME = 'keccak256(bytes32 salt || utf8(value)) v1'

const HASH_RE = /^0x[0-9a-fA-F]{64}$/

/** 姓名正規化：NFKC、去頭尾空白、連續空白合併、轉小寫。重算時必須用同一套。 */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 國籍代碼正規化：去空白、轉大寫（ISO 兩碼或 OTHER）。 */
export function normalizeNationality(code: string): string {
  return code.trim().toUpperCase()
}

export function generateSalt(): string {
  return hexlify(randomBytes(32))
}

export function commitValue(salt: string, value: string): string {
  return solidityPackedKeccak256(['bytes32', 'string'], [salt, value])
}

/** 鏈上讀回來的字串是不是本方案的雜湊（而不是舊版的明文）。 */
export function isCommitmentHash(v: string | null | undefined): boolean {
  return typeof v === 'string' && HASH_RE.test(v)
}

export interface KycSubmission {
  scheme: string
  salt: string
  nameHash: string
  nationalityHash: string
  /** 以下只留在使用者端，永遠不送上鏈。 */
  fullName: string
  nationality: string
  normalizedName: string
  normalizedNationality: string
}

export function buildKycSubmission(fullName: string, nationality: string, salt: string = generateSalt()): KycSubmission {
  if (!HASH_RE.test(salt)) throw new Error('salt must be 32 bytes hex')
  const normalizedName = normalizeName(fullName)
  const normalizedNationality = normalizeNationality(nationality)
  return {
    scheme: KYC_COMMITMENT_SCHEME,
    salt,
    nameHash: commitValue(salt, normalizedName),
    nationalityHash: commitValue(salt, normalizedNationality),
    fullName,
    nationality,
    normalizedName,
    normalizedNationality,
  }
}

/** 要送進 kycRegistry.submitKYC 的**唯一**參數組。只有雜湊，沒有原始資料。 */
export function kycSubmitArgs(s: KycSubmission): [string, string] {
  return [s.nameHash, s.nationalityHash]
}

/** 審核員線下比對：拿使用者出示的 salt 與原始資料重算，看是否等於鏈上的兩個雜湊。 */
export function verifyKycCommitment(a: {
  salt: string
  fullName: string
  nationality: string
  onChainName: string
  onChainNationality: string
}): { nameMatches: boolean; nationalityMatches: boolean } {
  const s = buildKycSubmission(a.fullName, a.nationality, a.salt)
  return {
    nameMatches: s.nameHash.toLowerCase() === a.onChainName.toLowerCase(),
    nationalityMatches: s.nationalityHash.toLowerCase() === a.onChainNationality.toLowerCase(),
  }
}

// ── 使用者端收據（localStorage）────────────────────────────────────────────
//
// 只存 salt 與兩個雜湊（＋定位用的 chainId／registry／user／txHash），**不存明文
// 姓名與國籍**：同一台電腦的其他人、瀏覽器擴充套件都讀得到 localStorage，
// 把明文放在這裡等於在本機又留一份個資。使用者出示時自己提供原始資料即可。
//
// 兩個 key，刻意分開：
//   pending  — 送交易「之前」寫入的那一份（還沒有 tx hash）。只有一份；錢包取消或
//              送出失敗時只刪它。
//   history  — 拿到 tx hash 之後升格進來，以 txHash 為索引保存多份。重送、取消都
//              不會動到這裡的舊收據——每一份都可能對應一筆已上鏈的申請。

export interface KycReceipt {
  scheme: string
  salt: string
  nameHash: string
  nationalityHash: string
  chainId: number | null
  registry: string
  user: string
  createdAt: number
  txHash: string | null
}

export interface ReceiptLocation {
  chainId: number | null
  registry: string
  user: string
}

export function toKycReceipt(
  s: KycSubmission,
  meta: ReceiptLocation & { txHash: string | null; createdAt?: number },
): KycReceipt {
  return {
    scheme: s.scheme,
    salt: s.salt,
    nameHash: s.nameHash,
    nationalityHash: s.nationalityHash,
    chainId: meta.chainId,
    registry: meta.registry,
    user: meta.user,
    createdAt: meta.createdAt ?? Date.now(),
    txHash: meta.txHash,
  }
}

const locPart = (l: ReceiptLocation) => `${l.chainId ?? 0}:${l.registry.toLowerCase()}:${l.user.toLowerCase()}`

export const pendingReceiptKey = (l: ReceiptLocation) => `pepefi:kyc-receipt-pending:${locPart(l)}`
export const historyReceiptKey = (l: ReceiptLocation) => `pepefi:kyc-receipts:${locPart(l)}`
/** F4 第一版用過的單一 key，可能存了明文姓名與國籍。讀到就清洗、搬進 history、刪掉。 */
export const legacyReceiptKey = (l: ReceiptLocation) => `pepefi:kyc-receipt:${locPart(l)}`

const isStr = (v: unknown): v is string => typeof v === 'string'

/**
 * 白名單清洗：只留 KycReceipt 的欄位。舊版曾把 fullName / nationality /
 * normalizedName… 一起存進來，這裡一律丟掉。格式不對回 null。
 */
export function sanitizeKycReceipt(raw: unknown): KycReceipt | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isStr(r.salt) || !isStr(r.nameHash) || !isStr(r.nationalityHash)) return null
  return {
    scheme: isStr(r.scheme) ? r.scheme : KYC_COMMITMENT_SCHEME,
    salt: r.salt,
    nameHash: r.nameHash,
    nationalityHash: r.nationalityHash,
    chainId: typeof r.chainId === 'number' ? r.chainId : null,
    registry: isStr(r.registry) ? r.registry : '',
    user: isStr(r.user) ? r.user : '',
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
    txHash: isStr(r.txHash) ? r.txHash : null,
  }
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v))
    return true
  } catch {
    return false
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 私密模式等：沒存進去也就不用刪 */
  }
}

function readHistory(l: ReceiptLocation): KycReceipt[] {
  const raw = readJson(historyReceiptKey(l))
  return Array.isArray(raw) ? raw.map(sanitizeKycReceipt).filter((r): r is KycReceipt => !!r && !!r.txHash) : []
}

/** 送交易前寫入 pending。回 false 代表寫不進去（私密模式／空間滿）。 */
export function savePendingKycReceipt(r: KycReceipt): boolean {
  return writeJson(pendingReceiptKey(r), { ...r, txHash: null })
}

/** 錢包取消或送出失敗：只刪 pending，history 裡的舊收據不動。 */
export function clearPendingKycReceipt(l: ReceiptLocation): void {
  removeKey(pendingReceiptKey(l))
}

/** 拿到 tx hash 後升格進 history（同一個 txHash 覆寫），並清掉 pending。 */
export function promoteKycReceipt(r: KycReceipt & { txHash: string }): boolean {
  const list = readHistory(r).filter((x) => x.txHash!.toLowerCase() !== r.txHash.toLowerCase())
  list.push(sanitizeKycReceipt(r)!)
  const ok = writeJson(historyReceiptKey(r), list)
  if (ok) clearPendingKycReceipt(r)
  return ok
}

export interface StoredKycReceipts {
  /** 帶 tx hash 的收據，新到舊。 */
  history: KycReceipt[]
  /** 送出前留下、但沒拿到 tx hash 的那一份（例如頁面在錢包彈窗時被關掉）。 */
  pending: KycReceipt | null
}

/**
 * 讀出這個位置的所有收據。順便做遷移：舊版單一 key 的收據清洗後（有 txHash）併進
 * history，舊 key 刪除；history 也以清洗後的內容覆寫回去，確保明文不殘留。
 */
export function loadKycReceipts(l: ReceiptLocation): StoredKycReceipts {
  const legacy = sanitizeKycReceipt(readJson(legacyReceiptKey(l)))
  let history = readHistory(l)
  if (legacy?.txHash && !history.some((x) => x.txHash!.toLowerCase() === legacy.txHash!.toLowerCase())) {
    history = [...history, legacy]
  }
  if (readJson(legacyReceiptKey(l)) !== null || readJson(historyReceiptKey(l)) !== null) {
    if (writeJson(historyReceiptKey(l), history)) removeKey(legacyReceiptKey(l))
  }
  const pending = sanitizeKycReceipt(readJson(pendingReceiptKey(l)))
  if (pending) writeJson(pendingReceiptKey(l), pending)
  return { history: [...history].sort((a, b) => b.createdAt - a.createdAt), pending }
}
