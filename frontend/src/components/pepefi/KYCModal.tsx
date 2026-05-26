import { useState } from 'react'
import type { Contract } from 'ethers'
import { prettyError } from 'src/lib/pepefi/errorMessages'

const COUNTRIES = [
  'TW', 'US', 'JP', 'KR', 'HK', 'SG', 'GB', 'DE', 'FR', 'CA',
  'AU', 'NZ', 'CH', 'SE', 'NL', 'BE', 'IT', 'ES', 'PT', 'AT',
  'DK', 'NO', 'FI', 'IE', 'CN', 'IN', 'BR', 'MX', 'TH', 'MY',
  'ID', 'PH', 'VN', 'PL', 'CZ', 'IL', 'ZA', 'AE', 'SA', 'OTHER',
]

const COUNTRY_NAMES: Record<string, string> = {
  TW: '台灣', US: '美國', JP: '日本', KR: '韓國', HK: '香港', SG: '新加坡',
  GB: '英國', DE: '德國', FR: '法國', CA: '加拿大', AU: '澳大利亞', NZ: '紐西蘭',
  CH: '瑞士', SE: '瑞典', NL: '荷蘭', BE: '比利時', IT: '義大利', ES: '西班牙',
  PT: '葡萄牙', AT: '奧地利', DK: '丹麥', NO: '挪威', FI: '芬蘭', IE: '愛爾蘭',
  CN: '中國', IN: '印度', BR: '巴西', MX: '墨西哥', TH: '泰國', MY: '馬來西亞',
  ID: '印尼', PH: '菲律賓', VN: '越南', PL: '波蘭', CZ: '捷克', IL: '以色列',
  ZA: '南非', AE: '阿聯酋', SA: '沙烏地阿拉伯', OTHER: '其他',
}

interface Props {
  isOpen:      boolean
  onClose:     () => void
  onSuccess:   () => void
  kycRegistry: Contract | null
}

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

export default function KYCModal({ isOpen, onClose, onSuccess, kycRegistry }: Props) {
  const [fullName,    setFullName]    = useState('')
  const [nationality, setNationality] = useState('TW')
  const [busy,        setBusy]        = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async () => {
    if (!kycRegistry) return
    if (!fullName.trim()) { setError('請輸入姓名'); return }
    setBusy(true)
    setError(null)
    try {
      const tx = asTx(await kycRegistry.submitKYC(fullName.trim(), nationality))
      await tx.wait()
      onSuccess()
      onClose()
    } catch (e) {
      setError(prettyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-surface-sub border border-surface-border rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">KYC 身分驗證</h2>
            <p className="text-xs text-gray-400 mt-0.5">交易股票 / 債券類合成資產需要完成 KYC</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Demo disclaimer */}
        <div className="rounded-lg bg-yellow-900/20 border border-yellow-700/40 px-4 py-3 text-xs text-yellow-300 space-y-1">
          <p className="font-semibold">Demo KYC — 不會儲存真實個資</p>
          <p className="text-yellow-400/80">
            此為學術展示系統。填入的姓名與國籍僅儲存在智能合約上作為 PoC 示範，請勿填入真實個人資訊。
          </p>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">姓名（示範用）</label>
            <input
              type="text"
              placeholder="e.g. Demo User"
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              className="w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand-300"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-400 uppercase tracking-wide">國籍</label>
            <select
              value={nationality}
              onChange={e => setNationality(e.target.value)}
              className="w-full rounded-lg bg-gray-800 border border-gray-600 px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-300"
            >
              {COUNTRIES.map(c => (
                <option key={c} value={c}>{c} — {COUNTRY_NAMES[c] ?? c}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 font-medium">{error}</p>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy || !fullName.trim() || !kycRegistry}
            className="flex-1 py-2.5 rounded-lg bg-brand-200 hover:bg-brand-300 disabled:opacity-40 text-white text-sm font-bold transition-colors"
          >
            {busy ? '提交中…' : '完成 KYC 驗證'}
          </button>
        </div>
      </div>
    </div>
  )
}
