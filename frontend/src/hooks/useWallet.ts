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
}

export interface WalletAPI extends WalletState {
  connect: () => Promise<void>
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
}

export function useWallet(): WalletAPI {
  const [state, setState] = useState<WalletState>(INITIAL)
  const isConnectingRef = useRef(false)

  const disconnect = useCallback(() => setState(INITIAL), [])

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
      setState({
        address,
        chainId: Number(chainId),
        isConnected: true,
        provider,
        signer,
        isConnecting: false,
        error: null,
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
    if (!window.ethereum) return
    try {
      await (window.ethereum as unknown as {
        request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
      }).request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
    } catch { /* user dismissed — ignore */ }
  }, [])

  // React to wallet / chain changes from MetaMask
  useEffect(() => {
    const eth = window.ethereum
    if (!eth) return

    const onAccountsChanged = async (raw: unknown) => {
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
        })
      } catch { /* silently ignore */ }
    }

    const onChainChanged = () => window.location.reload()

    eth.on('accountsChanged', onAccountsChanged as (...args: unknown[]) => void)
    eth.on('chainChanged', onChainChanged)
    return () => {
      eth.removeListener('accountsChanged', onAccountsChanged as (...args: unknown[]) => void)
      eth.removeListener('chainChanged', onChainChanged)
    }
  }, [disconnect])

  return { ...state, connect, disconnect, switchAccount }
}
