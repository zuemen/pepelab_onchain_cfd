import { useState, useEffect, useCallback, useRef } from 'react'
import { BrowserProvider, type Eip1193Provider, type Signer } from 'ethers'

// Augment Window so TypeScript knows about window.ethereum
declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on(event: string, handler: (...args: unknown[]) => void): void
      removeListener(event: string, handler: (...args: unknown[]) => void): void
      isMetaMask?: boolean
    }
  }
}

export interface WalletState {
  address: string | null
  chainId: number | null
  isConnected: boolean
  provider: BrowserProvider | null
  signer: Signer | null
  isConnecting: boolean
  error: string | null
  /** true until the initial silent session-restore check finishes (route guards wait on this) */
  initializing: boolean
  /**
   * true for the demo/presentation channel — has an address but no provider
   * or signer, so it can never read chain state. Callers that need to know
   * "can this connection actually read from chain" should check this rather
   * than inferring it from `provider === null`, which is an implementation
   * detail of how the mock channel happens to be wired today.
   */
  isMock: boolean
}

export interface WalletAPI extends WalletState {
  connect: () => Promise<void>
  connectMock: () => void
  disconnect: () => void
  switchAccount: () => Promise<void>
}

const INITIAL: WalletState = {
  address: null,
  chainId: null,
  isConnected: false,
  provider: null,
  signer: null,
  isConnecting: false,
  error: null,
  initializing: true,
  isMock: false,
}

/**
 * 展示模式用的假地址。
 *
 * 舊值 `0x7cc14a…7cc14a` 有 **42 個 hex 字元 = 21 bytes**，不是合法的 EVM 位址
 * （必須是 20 bytes / 40 個 hex）。任何拿它去做 getAddress／checksum／explorer
 * 連結的地方都會炸掉或產生無效網址。這裡截成合法的 20 bytes。
 */
export const MOCK_ADDRESS = '0x7cc14a7cc14a7cc14a7cc14a7cc14a7cc14a7cc1'

export function useWallet(): WalletAPI {
  const [state, setState] = useState<WalletState>(INITIAL)
  const isConnectingRef = useRef(false)

  const connectMock = useCallback(() => {
    localStorage.setItem('pepefi_wallet_mock', 'true');
    setState({
      address: MOCK_ADDRESS,
      chainId: 84532,
      isConnected: true,
      provider: null,
      signer: null,
      isConnecting: false,
      error: null,
      initializing: false,
      isMock: true,
    });
  }, []);

  const disconnect = useCallback(() => {
    localStorage.removeItem('pepefi_wallet_mock');
    localStorage.removeItem('pepefi_wallet_session');
    setState({ ...INITIAL, initializing: false });
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState(s => ({ ...s, error: 'MetaMask not detected — please install the extension.' }))
      return
    }
    if (isConnectingRef.current) return  // prevent duplicate eth_requestAccounts
    isConnectingRef.current = true
    setState(s => ({ ...s, isConnecting: true, error: null }))
    try {
      const provider = new BrowserProvider(window.ethereum)
      await provider.send('eth_requestAccounts', [])
      const signer  = await provider.getSigner()
      const address = await signer.getAddress()
      const { chainId } = await provider.getNetwork()
      // 記住「使用者明確連過線」— 刷新時才允許靜默恢復 session
      localStorage.setItem('pepefi_wallet_session', 'true')
      setState({
        address,
        chainId: Number(chainId),
        isConnected: true,
        provider,
        signer,
        isConnecting: false,
        error: null,
        initializing: false,
        isMock: false,
      })
    } catch (err) {
      const code = (err as { code?: number }).code
      const msg =
        code === -32002 ? 'MetaMask has a pending request — open MetaMask and approve it.' :
        code === 4001   ? 'Connection rejected — please approve in MetaMask.' :
        err instanceof Error ? err.message : 'Connection failed'
      setState(s => ({ ...s, isConnecting: false, error: msg }))
    } finally {
      isConnectingRef.current = false
    }
  }, [])

  const switchAccount = useCallback(async () => {
    if (localStorage.getItem('pepefi_wallet_mock') === 'true') return;
    if (!window.ethereum) return
    try {
      await (window.ethereum as unknown as {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      }).request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
    } catch { /* user dismissed — ignore */ }
  }, [])

  // Eager session restore on load: mock session from localStorage, or a silent
  // MetaMask `eth_accounts` check (no popup) when the site was already
  // authorized. Route guards wait on `initializing` so refreshes of inner
  // pages don't bounce to the landing page before this finishes.
  useEffect(() => {
    const restore = async () => {
      if (localStorage.getItem('pepefi_wallet_mock') === 'true') {
        setState({
          address: MOCK_ADDRESS,
          chainId: 84532,
          isConnected: true,
          provider: null,
          signer: null,
          isConnecting: false,
          error: null,
          initializing: false,
          isMock: true,
        });
        return;
      }
      // 只有使用者曾明確按過 Connect（且尚未 Disconnect）才靜默恢復，
      // 否則即使 MetaMask 已授權過本站，刷新後仍停留在未連線狀態。
      const eth = window.ethereum
      if (eth && localStorage.getItem('pepefi_wallet_session') === 'true') {
        try {
          const provider = new BrowserProvider(eth)
          const accounts = (await provider.send('eth_accounts', [])) as string[]
          if (accounts.length > 0) {
            const signer  = await provider.getSigner()
            const address = await signer.getAddress()
            const { chainId } = await provider.getNetwork()
            setState({
              address,
              chainId: Number(chainId),
              isConnected: true,
              provider,
              signer,
              isConnecting: false,
              error: null,
              initializing: false,
              isMock: false,
            })
            return
          }
        } catch { /* fall through to disconnected */ }
      }
      setState(s => ({ ...s, initializing: false }))
    }
    void restore()
  }, []);

  // React to wallet / chain changes from MetaMask
  useEffect(() => {
    const eth = window.ethereum
    if (!eth) return

    const onAccountsChanged = async (raw: unknown) => {
      if (localStorage.getItem('pepefi_wallet_mock') === 'true') return;
      const accounts = raw as string[]
      if (accounts.length === 0) { disconnect(); return }
      // Re-fetch provider + signer so the new account's signing key is used
      try {
        const provider = new BrowserProvider(eth)
        const signer   = await provider.getSigner()
        const address  = await signer.getAddress()
        const { chainId } = await provider.getNetwork()
        setState({
          address,
          chainId: Number(chainId),
          isConnected: true,
          provider,
          signer,
          isConnecting: false,
          error: null,
          initializing: false,
          isMock: false,
        })
      } catch { /* silently ignore */ }
    }

    const onChainChanged = () => {
      if (localStorage.getItem('pepefi_wallet_mock') === 'true') return;
      window.location.reload()
    }

    eth.on('accountsChanged', onAccountsChanged as (...args: unknown[]) => void)
    eth.on('chainChanged', onChainChanged)
    return () => {
      eth.removeListener('accountsChanged', onAccountsChanged as (...args: unknown[]) => void)
      eth.removeListener('chainChanged', onChainChanged)
    }
  }, [disconnect])

  return { ...state, connect, connectMock, disconnect, switchAccount }
}
