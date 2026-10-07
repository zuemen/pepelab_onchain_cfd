import type { KycActionMode } from 'src/hooks/useVcKycRegistry'

import { t, interpolate } from 'src/locales'

/**
 * 下單面板的 KYC 提示（一句完整的話）。
 * 「請至 Exchange 頁送出申請」只適用舊的 allowlist 登錄（legacy）；交易所接的是 VC 准入登錄、
 * 或登錄種類還在確認時，那句話會把人帶去一個不存在的 submitKYC 表單，所以改用不指路的說法，
 * 下方另有「用合格投資人憑證取得資格」連結（docs/tenants/rwa-poc/POC_SCRIPT.md §6 第 7 點）。
 */
export function kycTicketNotice(
  asset: string,
  { unknown, pending, vcAction }: { unknown: boolean; pending: boolean; vcAction: KycActionMode }
): string {
  const tpl = unknown
    ? t.terminal.ticket.kycUnknown
    : pending
      ? t.terminal.ticket.kycPending
      : vcAction === 'legacy'
        ? t.terminal.ticket.kycRequired
        : t.terminal.ticket.kycRequiredVc
  return interpolate(tpl, { asset })
}
