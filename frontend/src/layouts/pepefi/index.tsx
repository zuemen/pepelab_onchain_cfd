import { useEffect } from 'react';
import { Outlet, useNavigate, useOutletContext } from 'react-router';

import Box from '@mui/material/Box';

import { usePathname } from 'src/routes/hooks';

import { type WalletAPI } from 'src/hooks/useWallet';

import { useWalletContext } from 'src/contexts/wallet-context';

import { LoadingScreen } from 'src/components/loading-screen';

// ----------------------------------------------------------------------
// PepefiLayout: 只呼叫一次 useWallet()，透過 outlet context 傳給所有子頁面
//
// Wallet gate:
//   - 未連錢包 → 只能停留在 PUBLIC_PATHS（landing / x402 docs / marketplace），
//     其他內頁一律導回 landing。
//   - 已連錢包 → 停在 landing 時自動進入 app（AFTER_CONNECT_PATH）。
//   - 刷新頁面時 useWallet 會先做靜默 session 恢復（initializing），
//     守衛等它完成才判斷，避免已連線用戶刷新內頁被誤踢回 landing。

const PUBLIC_PATHS = ['/', '/x402', '/marketplace'];
const AFTER_CONNECT_PATH = '/dashboard';

export function PepefiLayout() {
  const wallet = useWalletContext();
  const pathname = usePathname();
  const navigate = useNavigate();

  useEffect(() => {
    if (wallet.initializing) return;
    const isPublic = PUBLIC_PATHS.includes(pathname);
    if (!wallet.isConnected && !isPublic) {
      navigate('/', { replace: true });
    } else if (wallet.isConnected && pathname === '/') {
      navigate(AFTER_CONNECT_PATH, { replace: true });
    }
  }, [wallet.initializing, wallet.isConnected, pathname, navigate]);

  if (wallet.initializing) return <LoadingScreen />;

  return (
    // 讓 MUI theme 的 dark mode 控制背景色
    <Box sx={{ minHeight: '100%', bgcolor: 'background.default', color: 'text.primary' }}>
      {/* Skip link. The app rendered no landmarks at all — 0 <main>, 0 <nav> —
          so a keyboard or screen-reader user had no way past the header on
          every single page; they tabbed through it again on each navigation.
          Visually hidden until focused, which is the point: it appears for the
          people who need it and stays out of the way for everyone else. */}
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: 'absolute',
          left: 8,
          top: -60,
          zIndex: (theme) => theme.zIndex.modal + 1,
          px: 2,
          py: 1.25,
          borderRadius: 1,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          fontWeight: 700,
          textDecoration: 'none',
          transition: 'top 150ms ease-out',
          '&:focus': { top: 8 },
        }}
      >
        跳到主要內容
      </Box>

      <Box component="main" id="main-content" tabIndex={-1} sx={{ outline: 'none' }}>
        <Outlet context={wallet} />
      </Box>
    </Box>
  );
}

// 子頁面用這個 hook 拿 wallet（不需要 props 傳遞）
export function usePepefiWallet(): WalletAPI {
  return useOutletContext<WalletAPI>();
}
