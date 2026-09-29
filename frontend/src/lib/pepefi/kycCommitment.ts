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

export function toKycReceipt(
  s: KycSubmission,
  meta: { chainId: number | null; registry: string; user: string; txHash: string | null; createdAt?: number },
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

export const receiptKey = (chainId: number | null, registry: string, user: string) =>
  `pepefi:kyc-receipt:${chainId ?? 0}:${registry.toLowerCase()}:${user.toLowerCase()}`

/** 盡力保存；私密模式或空間滿時回 false，呼叫端要提醒使用者自行抄下。 */
export function saveKycReceipt(r: KycReceipt): boolean {
  try {
    localStorage.setItem(receiptKey(r.chainId, r.registry, r.user), JSON.stringify(r))
    return true
  } catch {
    return false
  }
}

export function loadKycReceipt(chainId: number | null, registry: string, user: string): KycReceipt | null {
  try {
    const raw = localStorage.getItem(receiptKey(chainId, registry, user))
    return raw ? (JSON.parse(raw) as KycReceipt) : null
  } catch {
    return null
  }
}

/** 交易被取消或失敗（沒有送上鏈）時刪掉收據：那組 salt 不對應任何鏈上雜湊。 */
export function removeKycReceipt(chainId: number | null, registry: string, user: string): void {
  try {
    localStorage.removeItem(receiptKey(chainId, registry, user))
  } catch {
    /* 私密模式等：沒存進去也就不用刪 */
  }
}
