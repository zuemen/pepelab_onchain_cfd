import type { WalletAPI } from 'src/hooks/useWallet'

import { createElement } from 'react'
import { it, expect, describe } from 'vitest'
import { renderToString } from 'react-dom/server'

import { InvestorCredentialPanel } from './InvestorCredentialPanel'

// ----------------------------------------------------------------------

const wallet = {
  address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  chainId: 84532,
  isConnected: true,
  provider: null,
  signer: null,
  isConnecting: false,
  error: null,
  initializing: false,
  isMock: false,
  connect: async () => {},
  connectMock: () => {},
  disconnect: () => {},
  switchAccount: async () => {},
} as unknown as WalletAPI

describe('InvestorCredentialPanel', () => {
  it('registry 未設定 → 降級顯示「此部署尚未啟用 VC 准入」，沒有上傳／送出按鈕', () => {
    const html = renderToString(createElement(InvestorCredentialPanel, { wallet, registryAddress: null }))
    expect(html).toContain('此部署尚未啟用 VC 准入')
    expect(html).toContain('vc-kyc-disabled')
    expect(html).not.toContain('送出資格證明上鏈')
    expect(html).not.toContain('上傳 VC 檔案')
  })

  it('registry 已設定 → 顯示上傳、貼上與本地驗證', () => {
    const html = renderToString(
      createElement(InvestorCredentialPanel, { wallet, registryAddress: `0x${'c0'.repeat(20)}` })
    )
    expect(html).toContain('vc-kyc-panel')
    expect(html).toContain('上傳 VC 檔案')
    expect(html).toContain('本地驗證')
    expect(html).not.toContain('此部署尚未啟用 VC 准入')
  })

  it('沒有傳 registryAddress 時讀部署設定；目前沒有任何鏈設定 → 降級', () => {
    const html = renderToString(createElement(InvestorCredentialPanel, { wallet }))
    expect(html).toContain('此部署尚未啟用 VC 准入')
  })
})
