import { useState, useEffect, useCallback } from 'react'
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

  const disconnect = useCallback(() => setState(INITIAL), [])

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setState(s => ({ ...s, error: 'MetaMask not detected — please install the extension.' }))
      return
    }
    setState(s => ({ ...s, isConnecting: true, error: null }))
    try {
      const provider = new BrowserProvider(window.ethereum)
      await provider.send('eth_requestAccounts', [])
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
    } catch (err) {
      setState(s => ({
        ...s,
        isConnecting: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      }))
    }
  }, [])

  // React to wallet / chain changes from MetaMask
  useEffect(() => {
    const eth = window.ethereum
    if (!eth) return

    const onAccountsChanged = (raw: unknown) => {
      const accounts = raw as string[]
      if (accounts.length === 0) disconnect()
      else setState(s => ({ ...s, address: accounts[0] }))
    }
    const onChainChanged = () => window.location.reload()

    eth.on('accountsChanged', onAccountsChanged)
    eth.on('chainChanged', onChainChanged)
    return () => {
      eth.removeListener('accountsChanged', onAccountsChanged)
      eth.removeListener('chainChanged', onChainChanged)
    }
  }, [disconnect])

  return { ...state, connect, disconnect }
}
