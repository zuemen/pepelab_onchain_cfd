import { Outlet, useOutletContext } from 'react-router';

import { useWallet, type WalletAPI } from 'src/hooks/useWallet';

// ----------------------------------------------------------------------
// PepefiLayout: 只呼叫一次 useWallet()，透過 outlet context 傳給所有子頁面

export function PepefiLayout() {
  const wallet = useWallet();
  return (
    // 深色背景包住所有 pepefi 頁面，因為 pepefi 設計用 text-white / text-gray-300
    <div style={{ minHeight: '100%', backgroundColor: '#0f172a', color: '#f1f5f9' }}>
      <Outlet context={wallet} />
    </div>
  );
}

// 子頁面用這個 hook 拿 wallet（不需要 props 傳遞）
export function usePepefiWallet(): WalletAPI {
  return useOutletContext<WalletAPI>();
}
