import { Outlet, useOutletContext } from 'react-router';

import Box from '@mui/material/Box';

import { useWallet, type WalletAPI } from 'src/hooks/useWallet';

// ----------------------------------------------------------------------
// PepefiLayout: 只呼叫一次 useWallet()，透過 outlet context 傳給所有子頁面

export function PepefiLayout() {
  const wallet = useWallet();
  return (
    // 讓 MUI theme 的 dark mode 控制背景色
    <Box sx={{ minHeight: '100%', bgcolor: 'background.default', color: 'text.primary' }}>
      <Outlet context={wallet} />
    </Box>
  );
}

// 子頁面用這個 hook 拿 wallet（不需要 props 傳遞）
export function usePepefiWallet(): WalletAPI {
  return useOutletContext<WalletAPI>();
}
