import { useMemo, useContext, createContext, type ReactNode } from 'react';

import { useWallet, type WalletAPI } from 'src/hooks/useWallet';

// ----------------------------------------------------------------------

const WalletContext = createContext<WalletAPI | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  // useMemo 避免 re-render（wallet 物件每次 render 都是新的）
  const value = useMemo(() => wallet, [wallet]);
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletContext(): WalletAPI {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWalletContext must be used within WalletProvider');
  return ctx;
}
